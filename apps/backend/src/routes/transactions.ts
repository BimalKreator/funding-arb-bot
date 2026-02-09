import { Router, Request, Response } from 'express';
import type { BalanceService, Transaction } from '../services/balance.service.js';

export function createTransactionsRouter(balanceService: BalanceService): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const list = await balanceService.getTransactions();
      res.json(list);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to list transactions';
      res.status(500).json({ error: message });
    }
  });

  router.post('/', async (req: Request, res: Response) => {
    try {
      const { date, exchange, type, amount, remark } = req.body ?? {};
      if (!date || typeof date !== 'string' || date.trim() === '') {
        res.status(400).json({ error: 'Missing or invalid date' });
        return;
      }
      if (!exchange || typeof exchange !== 'string' || exchange.trim() === '') {
        res.status(400).json({ error: 'Missing or invalid exchange' });
        return;
      }
      if (type !== 'DEPOSIT' && type !== 'WITHDRAWAL') {
        res.status(400).json({ error: 'type must be DEPOSIT or WITHDRAWAL' });
        return;
      }
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt < 0) {
        res.status(400).json({ error: 'Invalid amount' });
        return;
      }
      const tx = await balanceService.addTransaction(
        date.trim(),
        exchange.trim(),
        type,
        amt,
        typeof remark === 'string' ? remark : ''
      );
      res.status(201).json(tx);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add transaction';
      res.status(500).json({ error: message });
    }
  });

  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const updates: Record<string, unknown> = {};
      if (typeof body.date === 'string') updates.date = body.date;
      if (typeof body.exchange === 'string') updates.exchange = body.exchange;
      if (body.type === 'DEPOSIT' || body.type === 'WITHDRAWAL') updates.type = body.type;
      if (Number.isFinite(Number(body.amount))) updates.amount = Number(body.amount);
      if (typeof body.remark === 'string') updates.remark = body.remark;

      const tx = await balanceService.updateTransaction(id, updates as Partial<Omit<Transaction, 'id'>>);
      if (!tx) {
        res.status(404).json({ error: 'Transaction not found' });
        return;
      }
      res.json(tx);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update transaction';
      res.status(500).json({ error: message });
    }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const ok = await balanceService.deleteTransaction(id);
      if (!ok) {
        res.status(404).json({ error: 'Transaction not found' });
        return;
      }
      res.status(204).send();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete transaction';
      res.status(500).json({ error: message });
    }
  });

  return router;
}
