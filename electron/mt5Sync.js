import { z } from 'zod';
import { tradeSchema } from '../shared/contracts.js';
import { insertObject } from './database.js';

const accountSnapshotSchema = z.object({
  login_id: z.string().min(1),
  server_name: z.string().min(1),
  broker_company: z.string(),
  account_name: z.string(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  balance: z.number().finite(),
  equity: z.number().finite(),
  trade_allowed: z.boolean(),
  trade_expert: z.boolean(),
  terminal_connected: z.boolean(),
  terminal_path: z.string(),
  adapter_mode: z.literal('read-only'),
});

const historyTradeSchema = z.object({
  broker_position_id: z.string(),
  broker_symbol: z.string().min(1),
  standard_symbol: z.string().min(1),
  type: z.enum(['BUY', 'SELL']),
  ticket_number: z.string().min(1),
  lot_size: z.number().positive().finite(),
  open_price: z.number().nonnegative().finite(),
  close_price: z.number().nonnegative().finite(),
  open_time: z.string().datetime(),
  close_time: z.string().datetime(),
  net_pnl: z.number().finite(),
  pips: z.number().finite().nullable(),
  status: z.enum(['WIN', 'LOSS', 'BE']),
  setup_tags: z.string(),
  mistake_tags: z.string(),
  notes: z.string(),
});

const historySchema = z.object({
  login_id: z.string().min(1),
  server_name: z.string().min(1),
  current_balance: z.number().finite(),
  balance_events: z.array(z.object({
    ticket_number: z.string().min(1), occurred_at: z.string().datetime(), amount: z.number().finite(),
    kind: z.string(), comment: z.string(),
  })).max(1000000),
  trades: z.array(historyTradeSchema).max(1000000),
  deal_count: z.number().int().nonnegative(),
  skipped_open_positions: z.number().int().nonnegative(),
  skipped_complex_positions: z.number().int().nonnegative(),
});

export async function syncMt5History(db, bridge, account, initialSnapshot) {
  const snapshot = accountSnapshotSchema.parse(initialSnapshot);
  if (!snapshot.terminal_connected) throw Error('MT5 terminal is not connected to its broker');
  if (account.login_id && account.login_id !== snapshot.login_id)
    throw Error('The MT5 terminal login does not match the selected Meridian account');
  if (account.server_name && account.server_name !== snapshot.server_name)
    throw Error('The MT5 terminal server does not match the selected Meridian account');

  const history = historySchema.parse(
    await bridge.request(
      'history.closed-trades',
      { date_from: '2000-01-01T00:00:00Z' },
      undefined,
      60000,
    ),
  );
  if (history.login_id !== snapshot.login_id || history.server_name !== snapshot.server_name)
    throw Error('MT5 account changed while history was being synchronized');

  let inserted = 0;
  let duplicates = 0;
  db.transaction(() => {
    db.prepare('UPDATE accounts SET login_id=?,server_name=?,base_currency=? WHERE id=?').run(
      snapshot.login_id,
      snapshot.server_name,
      snapshot.currency,
      account.id,
    );
    for (const trade of history.trades) {
      db.prepare(
        `INSERT INTO symbol_mappings(broker_name,standard_symbol,broker_symbol)
         VALUES(?,?,?) ON CONFLICT(broker_name,standard_symbol)
         DO UPDATE SET broker_symbol=excluded.broker_symbol`,
      ).run(account.broker_name, trade.standard_symbol, trade.broker_symbol);
      const { broker_position_id: _position, broker_symbol: _symbol, ...journalTrade } = trade;
      const validatedTrade = tradeSchema.parse({ ...journalTrade, account_id: account.id });
      const result = insertObject(db, 'trades', validatedTrade, true);
      inserted += result.changes;
      duplicates += result.changes ? 0 : 1;
    }
    for (const event of history.balance_events) {
      db.prepare(
        `INSERT OR IGNORE INTO capital_events(account_id,ticket_number,occurred_at,amount,kind,comment)
         VALUES(?,?,?,?,?,?)`,
      ).run(account.id, event.ticket_number, event.occurred_at, event.amount, event.kind, event.comment);
    }
    db.prepare(
      `INSERT INTO account_balances(account_id,balance,captured_at) VALUES(?,?,?)
       ON CONFLICT(account_id) DO UPDATE SET balance=excluded.balance,captured_at=excluded.captured_at`,
    ).run(account.id, history.current_balance, new Date().toISOString());
  })();

  return {
    account: snapshot,
    inserted,
    duplicates,
    closedPositions: history.trades.length,
    dealCount: history.deal_count,
    skippedOpenPositions: history.skipped_open_positions,
    skippedComplexPositions: history.skipped_complex_positions,
  };
}
