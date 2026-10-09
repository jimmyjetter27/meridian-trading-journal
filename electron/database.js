import Database from 'better-sqlite3';
import { accountSchema, mappingSchema, tradeSchema } from '../shared/contracts.js';
import { z } from 'zod';
export const schema = `
CREATE TABLE IF NOT EXISTS accounts(id INTEGER PRIMARY KEY,broker_name TEXT NOT NULL,account_type TEXT NOT NULL,base_currency TEXT NOT NULL,display_name TEXT NOT NULL,starting_balance REAL NOT NULL DEFAULT 0 CHECK(starting_balance>=0),login_id TEXT NOT NULL DEFAULT '',master_password_encrypted TEXT NOT NULL DEFAULT '',server_name TEXT NOT NULL DEFAULT '',terminal_path TEXT NOT NULL DEFAULT 'C:\\Program Files\\MetaTrader 5\\terminal64.exe',tracking_since TEXT NOT NULL DEFAULT '2000-01-01T00:00:00.000Z');
CREATE TABLE IF NOT EXISTS symbol_mappings(id INTEGER PRIMARY KEY,broker_name TEXT NOT NULL,standard_symbol TEXT NOT NULL,broker_symbol TEXT NOT NULL,UNIQUE(broker_name,broker_symbol),UNIQUE(broker_name,standard_symbol));
CREATE TABLE IF NOT EXISTS trades(id INTEGER PRIMARY KEY,ticket_number TEXT NOT NULL UNIQUE,account_id INTEGER NOT NULL REFERENCES accounts(id),standard_symbol TEXT NOT NULL,type TEXT NOT NULL CHECK(type IN ('BUY','SELL')),lot_size REAL NOT NULL CHECK(lot_size>0),open_price REAL NOT NULL,close_price REAL NOT NULL,open_time TEXT NOT NULL,close_time TEXT NOT NULL,net_pnl REAL NOT NULL,pips REAL,status TEXT NOT NULL CHECK(status IN ('WIN','LOSS','BE')),setup_tags TEXT NOT NULL DEFAULT '[]',mistake_tags TEXT NOT NULL DEFAULT '[]',notes TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS trades_filter ON trades(account_id,standard_symbol,close_time);
CREATE TABLE IF NOT EXISTS execution_log(id TEXT PRIMARY KEY,account_id INTEGER NOT NULL REFERENCES accounts(id),created_at TEXT NOT NULL,action TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS daily_entries(id INTEGER PRIMARY KEY,account_id INTEGER NOT NULL REFERENCES accounts(id),entry_date TEXT NOT NULL,session TEXT NOT NULL DEFAULT '',mood TEXT NOT NULL DEFAULT '',behavior_tags TEXT NOT NULL DEFAULT '[]',market_context TEXT NOT NULL DEFAULT '',reflection TEXT NOT NULL DEFAULT '',next_session_rule TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(account_id,entry_date));
CREATE INDEX IF NOT EXISTS daily_entries_date ON daily_entries(entry_date DESC,account_id);
CREATE TABLE IF NOT EXISTS price_alerts(id INTEGER PRIMARY KEY,account_id INTEGER NOT NULL REFERENCES accounts(id),standard_symbol TEXT NOT NULL,broker_symbol TEXT NOT NULL,target_price REAL NOT NULL CHECK(target_price>0),direction TEXT NOT NULL CHECK(direction IN ('above','below')),reference_price REAL NOT NULL,point_size REAL NOT NULL CHECK(point_size>0),status TEXT NOT NULL DEFAULT 'ARMED' CHECK(status IN ('ARMED','TRIGGERED','PAUSED')),created_at TEXT NOT NULL,triggered_at TEXT,trigger_price REAL);
CREATE INDEX IF NOT EXISTS price_alerts_monitor ON price_alerts(account_id,status,broker_symbol);
CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS capital_events(id INTEGER PRIMARY KEY,account_id INTEGER NOT NULL REFERENCES accounts(id),ticket_number TEXT NOT NULL,occurred_at TEXT NOT NULL,amount REAL NOT NULL,kind TEXT NOT NULL DEFAULT '',comment TEXT NOT NULL DEFAULT '',UNIQUE(account_id,ticket_number));
CREATE INDEX IF NOT EXISTS capital_events_time ON capital_events(account_id,occurred_at);
CREATE TABLE IF NOT EXISTS account_balances(account_id INTEGER PRIMARY KEY REFERENCES accounts(id),balance REAL NOT NULL,captured_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS signal_analyses(id INTEGER PRIMARY KEY,account_id INTEGER NOT NULL REFERENCES accounts(id),signal_date TEXT NOT NULL,setup_number INTEGER NOT NULL,standard_symbol TEXT NOT NULL,broker_symbol TEXT NOT NULL,side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),zone_low REAL NOT NULL,zone_high REAL NOT NULL,stop_loss REAL NOT NULL,take_profit REAL NOT NULL,lot_size REAL NOT NULL DEFAULT 0.01 CHECK(lot_size=0.01),starting_balance REAL NOT NULL,raw_setup TEXT NOT NULL,raw_outcome TEXT NOT NULL DEFAULT '',result_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(account_id,signal_date,setup_number));
CREATE INDEX IF NOT EXISTS signal_analyses_date ON signal_analyses(signal_date DESC,setup_number DESC);
`;
export function openDatabase(path) {
  const db = new Database(path);
  db.pragma('foreign_keys=ON');
  db.pragma('journal_mode=DELETE');
  db.pragma('busy_timeout=5000');
  db.exec(schema);
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(accounts)')
      .all()
      .map((column) => column.name),
  );
  if (!columns.has('terminal_path')) {
    db.exec(
      "ALTER TABLE accounts ADD COLUMN terminal_path TEXT NOT NULL DEFAULT 'C:\\Program Files\\MetaTrader 5\\terminal64.exe'",
    );
  }
  if (!columns.has('tracking_since')) {
    db.exec("ALTER TABLE accounts ADD COLUMN tracking_since TEXT NOT NULL DEFAULT '2000-01-01T00:00:00.000Z'");
  }
  db.pragma('user_version=7');
  return db;
}
export const publicAccounts = (db) =>
  db
    .prepare(
      'SELECT id,broker_name,account_type,base_currency,display_name,starting_balance,login_id,server_name,terminal_path,tracking_since FROM accounts ORDER BY id',
    )
    .all();
export function insertObject(db, table, row, ignore = false) {
  const keys = Object.keys(row);
  return db
    .prepare(
      `INSERT ${ignore ? 'OR IGNORE' : ''} INTO ${table} (${keys.join(',')}) VALUES (${keys.map((k) => '@' + k).join(',')})`,
    )
    .run(row);
}
export function packageData(db) {
  return {
    format: 'meridian',
    version: 1,
    exported_at: new Date().toISOString(),
    accounts: publicAccounts(db),
    symbol_mappings: db.prepare('SELECT * FROM symbol_mappings').all(),
    trades: db.prepare('SELECT * FROM trades').all(),
    daily_entries: db.prepare('SELECT * FROM daily_entries').all(),
    price_alerts: db.prepare('SELECT * FROM price_alerts').all(),
    app_settings: db.prepare('SELECT * FROM app_settings').all(),
    capital_events: db.prepare('SELECT * FROM capital_events').all(),
    account_balances: db.prepare('SELECT * FROM account_balances').all(),
    signal_analyses: db.prepare('SELECT * FROM signal_analyses').all(),
  };
}
const portable = z.object({
  format: z.literal('meridian'),
  version: z.literal(1),
  accounts: z.array(accountSchema.extend({ id: z.number().int().positive() })).max(10000),
  symbol_mappings: z.array(mappingSchema.extend({ id: z.number().int().positive() })).max(100000),
  trades: z.array(tradeSchema.extend({ id: z.number().int().positive() })).max(1000000),
  daily_entries: z.array(z.object({
    id: z.number().int().positive(), account_id: z.number().int().positive(),
    entry_date: z.string(), session: z.string(), mood: z.string(), behavior_tags: z.string(),
    market_context: z.string(), reflection: z.string(), next_session_rule: z.string(),
    created_at: z.string(), updated_at: z.string(),
  })).max(100000).default([]),
  price_alerts: z.array(z.object({
    id: z.number().int().positive(), account_id: z.number().int().positive(), standard_symbol: z.string(),
    broker_symbol: z.string(), target_price: z.number().positive(), direction: z.enum(['above','below']),
    reference_price: z.number().positive(), point_size: z.number().positive(), status: z.enum(['ARMED','TRIGGERED','PAUSED']),
    created_at: z.string(), triggered_at: z.string().nullable(), trigger_price: z.number().nullable(),
  })).max(100000).default([]),
  app_settings: z.array(z.object({ key: z.string(), value: z.string() })).max(1000).default([]),
  capital_events: z.array(z.object({ id: z.number().int().positive(), account_id: z.number().int().positive(), ticket_number: z.string(), occurred_at: z.string(), amount: z.number(), kind: z.string(), comment: z.string() })).max(1000000).default([]),
  account_balances: z.array(z.object({ account_id: z.number().int().positive(), balance: z.number(), captured_at: z.string() })).max(10000).default([]),
  signal_analyses: z.array(z.object({
    id: z.number().int().positive(), account_id: z.number().int().positive(), signal_date: z.string(),
    setup_number: z.number().int().positive(), standard_symbol: z.string(), broker_symbol: z.string(),
    side: z.enum(['BUY', 'SELL']), zone_low: z.number(), zone_high: z.number(), stop_loss: z.number(),
    take_profit: z.number(), lot_size: z.literal(0.01), starting_balance: z.number(), raw_setup: z.string(),
    raw_outcome: z.string(), result_json: z.string(), created_at: z.string(), updated_at: z.string(),
  })).max(100000).default([]),
});
export function restorePackage(db, input) {
  const data = portable.parse(input);
  db.transaction(() => {
    db.exec(
      'DELETE FROM execution_log; DELETE FROM price_alerts; DELETE FROM capital_events; DELETE FROM account_balances; DELETE FROM signal_analyses; DELETE FROM daily_entries; DELETE FROM trades; DELETE FROM symbol_mappings; DELETE FROM accounts; DELETE FROM app_settings;',
    );
    for (const table of ['accounts', 'symbol_mappings', 'trades', 'daily_entries', 'price_alerts', 'capital_events', 'account_balances', 'signal_analyses', 'app_settings'])
      for (const row of data[table]) insertObject(db, table, row);
    db.prepare("INSERT OR IGNORE INTO app_settings(key,value) VALUES('alert_mode','tone')").run();
  })();
}
export function filteredTrades(db, filters = {}) {
  return db
    .prepare(
      `SELECT t.*,a.display_name,a.broker_name,a.base_currency FROM trades t JOIN accounts a ON a.id=t.account_id WHERE (@account IS NULL OR t.account_id=@account) AND (@broker IS NULL OR a.broker_name=@broker) AND (@asset IS NULL OR t.standard_symbol=@asset) AND (@since IS NULL OR t.close_time>=@since) AND (@until IS NULL OR t.close_time<@until) ORDER BY t.close_time DESC,t.id DESC`,
    )
    .all({
      account: filters.account || null,
      broker: filters.broker || null,
      asset: filters.asset || null,
      since: filters.since || null,
      until: filters.until || null,
    });
}
