import './env-setup.js';

import express from 'express';
import cors from 'cors';
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
import { AutoExitService } from './services/auto-exit.service.js';
import { NotificationService } from './services/notification.service.js';
import { createNotificationsRouter } from './routes/notifications.js';
import { createStatsRouter } from './routes/stats.js';
import { createTransactionsRouter } from './routes/transactions.js';
import { BalanceService } from './services/balance.service.js';
import { config } from './config.js';

const HOUR_MS = 60 * 60 * 1000;

const app = express();

app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());

app.use('/api/health', healthRouter);

const fundingService = new FundingService({
  bybitTestnet: config.exchanges.bybit.testnet,
});
app.use('/api/funding', createFundingRouter(fundingService));

const screenerService = new ScreenerService(fundingService);
app.use('/api/screener', createScreenerRouter(screenerService));

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
});
app.use('/api/exchanges', createExchangesRouter(exchangeManager));

const notificationService = new NotificationService();
const tradeService = new TradeService(exchangeManager, notificationService);
app.use('/api/trade', createTradeRouter(tradeService));

const positionService = new PositionService(exchangeManager, fundingService);
app.use('/api/positions', createPositionsRouter(positionService));

const autoExitService = new AutoExitService(
  positionService,
  notificationService,
  fundingService
);
autoExitService.start();

app.use('/api/notifications', createNotificationsRouter(notificationService));

const balanceService = new BalanceService(exchangeManager);
app.use('/api/stats', createStatsRouter(balanceService));
app.use('/api/transactions', createTransactionsRouter(balanceService));

setInterval(() => balanceService.runMidnightSnapshotIfNeeded(), HOUR_MS);

// WebSocket endpoint placeholder for future implementation
// app.use('/ws', wsHandler);

app.get('/api', (_req, res) => {
  res.json({ message: 'Funding Arb Bot API', version: config.version });
});

const server = app.listen(config.port, () => {
  console.log(`Backend listening on http://localhost:${config.port}`);
  fundingService.start();
});

export { app, server };
