import { z } from 'zod';
export const disclaimer =
  '⚠️ RISK DISCLAIMER: Financial trading involves substantial risk of loss and is not suitable for every investor. Automated or quick-click order execution through external desktop clients can multiply latency risks, slip prices, or lead to unintended double-executions. Past performance is not indicative of future results.';
const text = z.string().trim().min(1).max(120);
export const accountSchema = z.object({
  broker_name: text,
  account_type: text,
  base_currency: z.string().regex(/^[A-Z]{3}$/),
  display_name: text,
  starting_balance: z.number().nonnegative().finite(),
  login_id: z.string().max(100).default(''),
  server_name: z.string().max(120).default(''),
  terminal_path: z.string().max(1024).default('C:\\Program Files\\MetaTrader 5\\terminal64.exe'),
  tracking_since: z.string().datetime().default('2000-01-01T00:00:00.000Z'),
});
export const mappingSchema = z.object({
  broker_name: text,
  standard_symbol: text,
  broker_symbol: text,
});
export const orderSchema = z
  .object({
    asset: text,
    type: z.enum(['BUY', 'SELL']),
    kind: z.enum(['MARKET', 'BUY_LIMIT', 'SELL_LIMIT', 'BUY_STOP', 'SELL_STOP']),
    lots: z.number().positive().finite().max(100),
    stop_loss: z.number().positive().finite(),
    price: z.number().positive().finite().optional(),
  })
  .superRefine((v, c) => {
    if (v.kind !== 'MARKET' && (!v.price || !v.kind.startsWith(v.type)))
      c.addIssue({ code: 'custom', message: 'Pending orders require a price and matching side' });
  });
export const tradeSchema = z
  .object({
    ticket_number: text,
    account_id: z.number().int().positive(),
    standard_symbol: text,
    type: z.enum(['BUY', 'SELL']),
    lot_size: z.number().positive().finite(),
    open_price: z.number().nonnegative().finite(),
    close_price: z.number().nonnegative().finite(),
    open_time: z.string().datetime(),
    close_time: z.string().datetime(),
    net_pnl: z.number().finite(),
    pips: z.number().finite().nullable(),
    status: z.enum(['WIN', 'LOSS', 'BE']),
    setup_tags: z.string().max(10000),
    mistake_tags: z.string().max(10000),
    notes: z.string().max(50000),
  })
  .superRefine((t, c) => {
    if (
      t.close_time < t.open_time ||
      t.status !== (t.net_pnl > 0 ? 'WIN' : t.net_pnl < 0 ? 'LOSS' : 'BE')
    )
      c.addIssue({ code: 'custom', message: 'Inconsistent trade dates or status' });
    for (const key of ['setup_tags', 'mistake_tags']) {
      try {
        if (!Array.isArray(JSON.parse(t[key]))) throw Error();
      } catch {
        c.addIssue({ code: 'custom', message: 'Tags must be JSON arrays' });
      }
    }
  });
