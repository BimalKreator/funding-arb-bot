import './env-setup.js';

import express from 'express';
import cors from 'cors';
import { authenticateToken } from './middleware/auth.middleware.js';
import { authRouter } from './routes/auth.js';
import { healthRouter } from './routes/health.js';
import { createExchangesRouter } from './routes/exchanges.js';
import { ExchangeManager } from './services/exchange/index.js';
import { FundingService } from './services/funding.service.js';
import { createFundingRouter } from './routes/funding.js';
import { createScreenerRouter } from './routes/screener.js';
import { createTradeRouter } from './routes/trade.js';
import { createPositionsRouter } from './routes/positions.js';
import { ScreenerService } from './services/screener.service.js';
import { TradeService } from './services/trade.service.js';
import { PositionService } from './services/position.service.js';
import { FundingFeeService } from './services/funding-fee.service.js';
import { AutoExitService } from './services/auto-exit.service.js';
import { AutoEntryService } from './services/auto-entry.service.js';
import { NotificationService } from './services/notification.service.js';
import { createNotificationsRouter } from './routes/notifications.js';
import { createStatsRouter } from './routes/stats.js';
import { createTransactionsRouter } from './routes/transactions.js';
import { BalanceService } from './services/balance.service.js';
import { ConfigService } from './services/config.service.js';
import { getMarketDataService } from './services/market-data.service.js';
import { createConfigRouter } from './routes/config.js';
import { createSettingsRouter } from './routes/settings.js';
import { createInstrumentsRouter } from './routes/instruments.js';
import { InstrumentService } from './services/InstrumentService.js';
import { BannedSymbolsService } from './services/banned-symbols.service.js';
import { config } from './config.js';

const HOUR_MS = 60 * 60 * 1000;

const app = express();
const bannedSymbolsService = new BannedSymbolsService();

app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());

// Protect all /api/* except POST /api/auth/login
app.use('/api', (req, res, next) => {
  if (req.path === '/auth/login' && req.method === 'POST') return next();
  authenticateToken(req, res, next);
});

app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);

const fundingService = new FundingService({
  bybitTestnet: config.exchanges.bybit.testnet,
});
app.use('/api/funding', createFundingRouter(fundingService));

const instrumentService = new InstrumentService({
  bybitTestnet: config.exchanges.bybit.testnet,
});
instrumentService.start();

const exchangeManager = new ExchangeManager({
  binance:
    config.exchanges.binance.apiKey && config.exchanges.binance.apiSecret
      ? {
          apiKey: config.exchanges.binance.apiKey,
          apiSecret: config.exchanges.binance.apiSecret,
          testnet: config.exchanges.binance.testnet,
        }
      : undefined,
  bybit:
    config.exchanges.bybit.apiKey && config.exchanges.bybit.apiSecret
      ? {
          apiKey: config.exchanges.bybit.apiKey,
          apiSecret: config.exchanges.bybit.apiSecret,
          testnet: config.exchanges.bybit.testnet,
        }
      : undefined,
  instrumentService,
});
app.use('/api/exchanges', createExchangesRouter(exchangeManager));

const notificationService = new NotificationService();
const configService = new ConfigService();
app.use('/api/config', createConfigRouter(configService));
app.use('/api/settings', createSettingsRouter(configService));
app.use('/api/instruments', createInstrumentsRouter(bannedSymbolsService));

const marketDataService = getMarketDataService();
marketDataService.start(config.exchanges.binance.testnet);

// TradeService(exchangeManager, notificationService, instrumentService, configService, marketDataService)
const tradeService = new TradeService(
  exchangeManager,
  notificationService,
  instrumentService,
  configService,
  marketDataService
);
app.use('/api/trade', createTradeRouter(tradeService));

const positionService = new PositionService(exchangeManager, fundingService, instrumentService);
app.use('/api/positions', createPositionsRouter(positionService));

const fundingFeeService = new FundingFeeService(positionService, fundingService);
fundingFeeService.start();

const autoExitService = new AutoExitService(
  configService,
  positionService,
  notificationService,
  fundingService,
  exchangeManager
);
autoExitService.start();

app.use('/api/notifications', createNotificationsRouter(notificationService));

const balanceService = new BalanceService(exchangeManager);
app.use('/api/stats', createStatsRouter(balanceService));
app.use('/api/transactions', createTransactionsRouter(balanceService));

const MIDNIGHT_CHECK_MS = 10 * 60 * 1000; // 10 min — ensures we hit 12 AM IST window
setInterval(() => balanceService.runMidnightSnapshotIfNeeded(), MIDNIGHT_CHECK_MS);

const REBALANCE_INTERVAL_MS = 30_000;
setInterval(() => tradeService.rebalanceQuantities(), REBALANCE_INTERVAL_MS);

// WebSocket endpoint placeholder for future implementation
// app.use('/ws', wsHandler);

app.get('/api', (_req, res) => {
  res.json({ message: 'Funding Arb Bot API', version: config.version });
});

let server: ReturnType<typeof app.listen> | undefined;

async function start(): Promise<void> {
  await bannedSymbolsService.load();
  const screenerService = new ScreenerService(
    fundingService,
    instrumentService,
    bannedSymbolsService,
    configService,
    exchangeManager,
    marketDataService
  );
  app.use('/api/screener', createScreenerRouter(screenerService));

  const autoEntryService = new AutoEntryService(
    configService,
    exchangeManager,
    positionService,
    screenerService,
    tradeService,
    notificationService,
    instrumentService
  );
  autoEntryService.startMonitoring();

  server = app.listen(config.port, () => {
    console.log(`Backend listening on http://localhost:${config.port}`);
    fundingService.start();
  });
}

start().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});

export { app, server };
