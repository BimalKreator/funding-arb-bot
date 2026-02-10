import { Router, Request, Response } from 'express';
import { TradeService } from '../services/trade.service.js';
import type { ArbitrageStrategy } from '../services/trade.service.js';

export function createTradeRouter(tradeService: TradeService): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    try {
      const { symbol, quantity: quantityRaw, strategy: strategyRaw, leverage: leverageRaw, markPrice: markPriceRaw } = req.body ?? {};
      if (!symbol || typeof symbol !== 'string' || symbol.trim() === '') {
        res.status(400).json({ error: 'Missing or invalid symbol' });
        return;
      }
      const quantity = Number(quantityRaw);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        res.status(400).json({ error: 'Missing or invalid quantity' });
        return;
      }
      const leverageNum = leverageRaw != null ? Number(leverageRaw) : 1;
      const leverage = Number.isInteger(leverageNum) && leverageNum >= 1 ? leverageNum : 1;
      const strategy = strategyRaw && typeof strategyRaw === 'object'
        ? strategyRaw as { binanceSide?: string; bybitSide?: string }
        : {};
      const binanceSide = strategy.binanceSide;
      const bybitSide = strategy.bybitSide;
      if (binanceSide !== 'BUY' && binanceSide !== 'SELL') {
        res.status(400).json({ error: 'Invalid strategy.binanceSide (must be BUY or SELL)' });
        return;
      }
      if (bybitSide !== 'BUY' && bybitSide !== 'SELL') {
        res.status(400).json({ error: 'Invalid strategy.bybitSide (must be BUY or SELL)' });
        return;
      }
      const strategyObj: ArbitrageStrategy = { binanceSide, bybitSide };
      const markPrice = markPriceRaw != null && Number.isFinite(Number(markPriceRaw)) ? Number(markPriceRaw) : undefined;
      const result = await tradeService.executeArbitrage(symbol.trim(), quantity, strategyObj, leverage, markPrice);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Trade failed';
      res.status(500).json({ error: message });
    }
  });

  return router;
}
