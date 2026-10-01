import { parse } from 'csv-parse/sync';
import { tradeSchema } from '../shared/contracts.js';
import { insertObject } from './database.js';
const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const aliases = {
  ticket_number: ['ticket', 'ticketnumber', 'position', 'order'],
  standard_symbol: ['symbol', 'item', 'instrument'],
  type: ['type', 'side', 'direction'],
  lot_size: ['volume', 'lots', 'lotsize', 'size'],
  open_price: ['openprice', 'entryprice', 'price'],
  close_price: ['closeprice', 'exitprice', 'price2'],
  open_time: ['opentime', 'entrytime', 'time'],
  close_time: ['closetime', 'exittime', 'time2'],
  profit: ['profit', 'pnl'],
  net: ['netpnl', 'netprofit'],
  commission: ['commission'],
  swap: ['swap'],
  fee: ['fee', 'fees'],
  pips: ['pips'],
};
function number(value) {
  if (value == null || String(value).trim() === '') throw Error('Missing numeric field');
  const n = Number(String(value).replace(/\s/g, '').replace(/,/g, '.'));
  if (!Number.isFinite(n)) throw Error('Invalid numeric field: ' + value);
  return n;
}
function date(value) {
  const s = String(value || '')
    .trim()
    .replace(/^(\d{4})\.(\d{2})\.(\d{2})/, '$1-$2-$3')
    .replace(' ', 'T');
  const d = new Date(/Z$|[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z');
  if (!Number.isFinite(+d)) throw Error('Invalid date: ' + value);
  return d.toISOString();
}
export function parseTrades(raw, account, mappings) {
  if (typeof raw !== 'string' || raw.length > 20_000_000) throw Error('CSV must be under 20 MB');
  const first = raw.replace(/^\uFEFF/, '').split(/\r?\n/)[0];
  const delimiter = ['\t', ';', ','].sort(
    (a, b) => first.split(b).length - first.split(a).length,
  )[0];
  const rows = parse(raw, {
    delimiter,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });
  if (rows.length < 2) throw Error('A header and trade rows are required');
  const seen = {};
  const headers = rows.shift().map((h) => {
    const k = normalize(h);
    seen[k] = (seen[k] || 0) + 1;
    return k + (seen[k] > 1 ? seen[k] : '');
  });
  const pick = (r, k) => {
    const i = headers.findIndex((h) => aliases[k].includes(h));
    return i < 0 ? undefined : r[i];
  };
  for (const key of [
    'ticket_number',
    'standard_symbol',
    'type',
    'lot_size',
    'open_price',
    'close_price',
    'open_time',
    'close_time',
  ])
    if (!headers.some((h) => aliases[key].includes(h)))
      throw Error(`Missing ${key} column. Export closed positions, not an MT5 deals ledger.`);
  const trades = [],
    errors = [];
  rows.forEach((r, i) => {
    try {
      const symbol = String(pick(r, 'standard_symbol') || '');
      const mapped = mappings.find(
        (m) =>
          m.broker_symbol.toLowerCase() === symbol.toLowerCase() ||
          m.standard_symbol.toLowerCase() === symbol.toLowerCase(),
      );
      if (!mapped) throw Error('No symbol mapping for ' + symbol);
      const net = pick(r, 'net');
      const pnl =
        net !== undefined && net !== ''
          ? number(net)
          : number(pick(r, 'profit')) +
            ['commission', 'swap', 'fee'].reduce(
              (sum, k) => sum + (pick(r, k) ? number(pick(r, k)) : 0),
              0,
            );
      trades.push(
        tradeSchema.parse({
          ticket_number: String(pick(r, 'ticket_number') || ''),
          account_id: account.id,
          standard_symbol: mapped.standard_symbol,
          type: String(pick(r, 'type')).toUpperCase(),
          lot_size: number(pick(r, 'lot_size')),
          open_price: number(pick(r, 'open_price')),
          close_price: number(pick(r, 'close_price')),
          open_time: date(pick(r, 'open_time')),
          close_time: date(pick(r, 'close_time')),
          net_pnl: pnl,
          pips: pick(r, 'pips') ? number(pick(r, 'pips')) : null,
          status: pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'BE',
          setup_tags: '[]',
          mistake_tags: '[]',
          notes: '',
        }),
      );
    } catch (e) {
      errors.push({ row: i + 2, message: e.message });
    }
  });
  return { trades, errors };
}
export function importCsv(db, raw, id) {
  const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  if (!account) throw Error('Select an import account');
  const parsed = parseTrades(
    raw,
    account,
    db.prepare('SELECT * FROM symbol_mappings WHERE broker_name=?').all(account.broker_name),
  );
  let inserted = 0;
  db.transaction(() => {
    for (const row of parsed.trades) inserted += insertObject(db, 'trades', row, true).changes;
  })();
  return { inserted, duplicates: parsed.trades.length - inserted, errors: parsed.errors };
}
