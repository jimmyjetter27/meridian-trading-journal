import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDatabase,
  insertObject,
  publicAccounts,
  packageData,
  restorePackage,
  filteredTrades,
} from '../electron/database.js';
import { parseTrades, importCsv } from '../electron/importer.js';
import { analytics } from '../electron/analytics.js';
import { ExecutionEngine } from '../electron/execution.js';
import { diagnose } from '../electron/diagnostics.js';
import { syncMt5History } from '../electron/mt5Sync.js';
import { calculatePeriodReturns } from '../electron/returns.js';
function fixture() {
  const db = openDatabase(':memory:');
  insertObject(db, 'accounts', {
    id: 1,
    broker_name: 'Exness',
    account_type: 'Standard',
    base_currency: 'USD',
    display_name: 'Main',
    starting_balance: 10000,
    login_id: '123',
    server_name: 'Demo',
  });
  insertObject(db, 'symbol_mappings', {
    broker_name: 'Exness',
    standard_symbol: 'XAUUSD',
    broker_symbol: 'XAUUSDm',
  });
  return db;
}
const csv =
  'Ticket,Symbol,Type,Volume,Open Price,Close Price,Open Time,Close Time,Profit,Commission,Swap\n90071992547409999,XAUUSDm,buy,0.1,2000,2010,2026.09.01 10:00:00,2026.09.01 11:00:00,100,-3,-2';
test('closed-position import preserves string tickets, costs, deduplication, and mappings', () => {
  const db = fixture();
  try {
    assert.deepEqual(importCsv(db, csv, 1), { inserted: 1, duplicates: 0, errors: [] });
    assert.equal(importCsv(db, csv, 1).duplicates, 1);
    const t = db.prepare('SELECT * FROM trades').get();
    assert.equal(t.ticket_number, '90071992547409999');
    assert.equal(t.net_pnl, 95);
    assert.equal(t.standard_symbol, 'XAUUSD');
    assert.equal(t.pips, null);
  } finally {
    db.close();
  }
});
test('journal date filters support closed-open day boundaries', () => {
  const db = fixture();
  try {
    importCsv(db, csv, 1);
    assert.equal(filteredTrades(db, { since: '2026-09-01T00:00:00.000Z', until: '2026-09-02T00:00:00.000Z' }).length, 1);
    assert.equal(filteredTrades(db, { since: '2026-09-02T00:00:00.000Z' }).length, 0);
    assert.equal(filteredTrades(db, { until: '2026-09-01T00:00:00.000Z' }).length, 0);
  } finally {
    db.close();
  }
});
test('account schema migration provides an account-specific MT5 terminal path', () => {
  const db = fixture();
  try {
    const account = publicAccounts(db)[0];
    assert.equal(account.terminal_path, 'C:\\Program Files\\MetaTrader 5\\terminal64.exe');
    assert.equal(account.tracking_since, '2000-01-01T00:00:00.000Z');
    assert.equal(db.pragma('user_version', { simple: true }), 6);
  } finally {
    db.close();
  }
});
test('price alerts and sound preferences persist in the journal database', () => {
  const db = fixture();
  try {
    db.prepare("INSERT INTO app_settings(key,value) VALUES('alert_mode','voice')").run();
    db.prepare(`INSERT INTO price_alerts(account_id,standard_symbol,broker_symbol,target_price,direction,reference_price,point_size,status,created_at)
      VALUES(1,'XAUUSD','XAUUSDm',4000,'above',3990,0.01,'ARMED','2026-09-25T00:00:00.000Z')`).run();
    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='alert_mode'").get().value, 'voice');
    assert.equal(db.prepare('SELECT status FROM price_alerts').get().status, 'ARMED');
  } finally { db.close(); }
});
test('unknown symbols and malformed amounts are reported without inserting', () => {
  const db = fixture();
  try {
    const result = importCsv(db, csv.replace('XAUUSDm', 'UNMAPPED'), 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.inserted, 0);
    assert.equal(importCsv(db, csv.replace(',0.1,', ',oops,'), 1).errors.length, 1);
  } finally {
    db.close();
  }
});
test('semicolon CSV, decimal comma, duplicate MT headers and quoted fields', () => {
  const raw =
    'Ticket;Symbol;Type;Volume;Price;Price;Time;Time;Profit\n42;Gold;sell;"0,1";2000;1990;2026.09.01 10:00:00;2026.09.01 11:00:00;"10,5"';
  const r = parseTrades(raw, { id: 1 }, [{ broker_symbol: 'Gold', standard_symbol: 'XAUUSD' }]);
  assert.equal(r.errors.length, 0);
  assert.equal(r.trades[0].net_pnl, 10.5);
  assert.equal(r.trades[0].close_price, 1990);
});
test('MT5 deals ledger is not silently interpreted as a round trip', () => {
  assert.throws(
    () =>
      parseTrades(
        'Deal,Time,Symbol,Type,Volume,Price,Profit\n1,2026.09.01 10:00:00,Gold,buy,1,2000,5',
        { id: 1 },
        [],
      ),
    /closed positions/,
  );
});
test('restore validates first, strips secrets, and rolls back broken references', () => {
  const db = fixture();
  try {
    importCsv(db, csv, 1);
    db.prepare("UPDATE accounts SET master_password_encrypted='secret'").run();
    const backup = packageData(db);
    assert.equal(backup.accounts[0].master_password_encrypted, undefined);
    restorePackage(db, backup);
    assert.equal(
      db.prepare('SELECT master_password_encrypted FROM accounts').get().master_password_encrypted,
      '',
    );
    const broken = structuredClone(backup);
    broken.trades[0].account_id = 999;
    assert.throws(() => restorePackage(db, broken));
    assert.equal(db.prepare('SELECT count(*) AS n FROM trades').get().n, 1);
    assert.throws(() => restorePackage(db, { ...backup, version: 2 }));
  } finally {
    db.close();
  }
});
test('analytics handles breakeven, zero capital, no loss and mixed currencies', () => {
  const a = [{ base_currency: 'USD', starting_balance: 1000 }];
  const m = analytics([{ net_pnl: 100 }, { net_pnl: -50 }, { net_pnl: 0 }], a);
  assert.ok(Math.abs(m.winRate - 100 / 3) < 1e-9);
  assert.equal(m.profitFactor, 2);
  assert.equal(m.roi, 5);
  assert.equal(m.balance, 1050);
  assert.equal(analytics([{ net_pnl: 10 }], a).noLosses, true);
  assert.equal(analytics([], []).roi, null);
  assert.equal(analytics([], [...a, { base_currency: 'EUR', starting_balance: 1 }]).mixed, true);
});
test('period returns use each period opening capital and roll realized P&L forward', () => {
  const accounts = [{ id: 1, base_currency: 'USD', starting_balance: 50 }];
  const trades = [
    { account_id: 1, close_time: '2026-10-01T10:00:00.000Z', net_pnl: 5 },
    { account_id: 1, close_time: '2026-10-02T10:00:00.000Z', net_pnl: -11 },
  ];
  const daily = calculatePeriodReturns(accounts, trades, [], [{ account_id: 1, balance: 44 }], 'daily');
  assert.equal(daily.periods[0].opening_capital, 50);
  assert.equal(daily.periods[0].return_pct, 10);
  assert.equal(daily.periods[1].opening_capital, 55);
  assert.equal(daily.periods[1].return_pct, -20);
  assert.equal(daily.periods[1].closing_capital, 44);
  const monthly = calculatePeriodReturns(accounts, trades, [], [{ account_id: 1, balance: 44 }], 'monthly');
  assert.equal(monthly.periods.length, 1);
  assert.equal(monthly.periods[0].pnl, -6);
  assert.equal(monthly.periods[0].return_pct, -12);
});
function execution(db, send) {
  const bridge = {
    request: async (method, params, id) =>
      method === 'symbol.snapshot'
        ? {
            login_id: '123',
            server_name: 'Demo',
            symbol: 'XAUUSDm',
            bid: 1999,
            ask: 2000,
            timestamp: Date.now(),
            volume_min: 0.01,
            volume_max: 10,
            volume_step: 0.01,
            tick_size: 0.01,
            tick_value: 1,
            stops_level: 0.1,
          }
        : send(method, params, id),
  };
  const engine = new ExecutionEngine(db, bridge, { executionEnabled: true });
  engine.select(1);
  return engine;
}
const order = { asset: 'XAUUSD', type: 'BUY', kind: 'MARKET', lots: 0.1, stop_loss: 1990 };
test('execution is disabled by default for the journal application', async () => {
  const db = fixture();
  try {
    const engine = new ExecutionEngine(db, { request: async () => { throw Error('must not call bridge'); } });
    engine.select(1);
    await assert.rejects(engine.prepare('place', order), /journal-only/);
  } finally { db.close(); }
});
test('confirmation binds exact symbol, risk, account, and single-use request ID', async () => {
  const db = fixture();
  let calls = 0;
  try {
    const e = execution(db, async (_m, p, id) => {
      calls++;
      assert.equal(p.symbol, 'XAUUSDm');
      assert.equal(p.login_id, '123');
      assert.equal(p.request_id, id);
      return { retcode: 10009 };
    });
    const q = await e.prepare('place', order);
    assert.equal(q.estimated_risk, 100);
    assert.equal((await e.execute('place', q.token)).ok, true);
    await assert.rejects(e.execute('place', q.token), /already used/);
    assert.equal(calls, 1);
  } finally {
    db.close();
  }
});
test('account switching invalidates pending confirmations', async () => {
  const db = fixture();
  try {
    const e = execution(db, () => {
      throw Error('Must not send');
    });
    const q = await e.prepare('place', order);
    e.select(1);
    await assert.rejects(e.execute('place', q.token), /expired/);
  } finally {
    db.close();
  }
});
test('timeout persists UNKNOWN and blocks resubmission until reconciliation', async () => {
  const db = fixture();
  try {
    const e = execution(db, async (method) => {
      if (method === 'trade.status')
        return { login_id: '123', server_name: 'Demo', state: 'NOT_SUBMITTED' };
      throw Object.assign(Error('Timed out'), { code: 'BRIDGE_TIMEOUT' });
    });
    const q = await e.prepare('place', order);
    assert.equal((await e.execute('place', q.token)).ok, false);
    assert.equal(db.prepare('SELECT state FROM execution_log').get().state, 'UNKNOWN');
    const q2 = await e.prepare('place', order);
    await assert.rejects(e.execute('place', q2.token), /unknown outcome/);
    await e.reconcile(q.token);
    assert.equal(db.prepare('SELECT state FROM execution_log').get().state, 'NOT_SUBMITTED');
  } finally {
    db.close();
  }
});
test('volume, protective stops and pending price constraints reject before confirmation', async () => {
  const db = fixture();
  try {
    const e = execution(db, () => {});
    await assert.rejects(e.prepare('place', { ...order, lots: 0.015 }), /10014/);
    await assert.rejects(e.prepare('place', { ...order, stop_loss: 2001 }), /protective/);
    await assert.rejects(
      e.prepare('place', { ...order, kind: 'BUY_LIMIT', price: 2002 }),
      /wrong side/,
    );
  } finally {
    db.close();
  }
});
test('position closures fetch exact server-side volume and require their own confirmation', async () => {
  const db = fixture();
  try {
    const e = execution(db, async (method, p) =>
      method === 'position.snapshot'
        ? {
            position_id: p.position_id,
            symbol: 'XAUUSDm',
            lots: 0.2,
            stop_loss: 1990,
            type: 'BUY',
            login_id: '123',
            server_name: 'Demo',
          }
        : { retcode: 10009 },
    );
    const q = await e.prepare('close', { position_id: '42' });
    assert.equal(q.lots, 0.2);
    assert.equal(q.symbol, 'XAUUSDm');
    assert.equal((await e.execute('close', q.token)).ok, true);
  } finally {
    db.close();
  }
});
test('diagnostics distinguish server restrictions from client permissions', () => {
  assert.equal(diagnose({ code: '10014' }).title, 'Invalid volume');
  assert.match(diagnose({ code: '10026' }).steps[0], /broker/);
  assert.equal(diagnose({ code: '10027' }).steps.length, 5);
});
test('expired and wrong-action confirmations cannot transmit', async () => {
  const db = fixture();
  try {
    const e = execution(db, () => {
      throw Error('Must not transmit');
    });
    let q = await e.prepare('place', order);
    e.confirmations.get(q.token).expires_at = Date.now() - 1;
    await assert.rejects(e.execute('place', q.token), /expired/);
    q = await e.prepare('place', order);
    await assert.rejects(e.execute('close', q.token), /expired/);
  } finally {
    db.close();
  }
});
test('stale quotes and mismatched terminal identities cannot create confirmations', async () => {
  const db = fixture();
  try {
    const e = execution(db, () => {});
    const original = e.bridge.request;
    e.bridge.request = async (...args) => ({ ...(await original(...args)), login_id: 'different' });
    await assert.rejects(e.prepare('place', order), /does not match/);
    e.bridge.request = async (...args) => ({
      ...(await original(...args)),
      timestamp: Date.now() - 10000,
    });
    await assert.rejects(e.prepare('place', order), /Stale/);
  } finally {
    db.close();
  }
});
test('broker rejections persist a rejected state and return targeted diagnostics', async () => {
  const db = fixture();
  try {
    const e = execution(db, async () => ({ retcode: 10017, message: 'Trade disabled' }));
    const q = await e.prepare('place', order);
    const r = await e.execute('place', q.token);
    assert.equal(r.ok, false);
    assert.equal(r.diagnostic.code, '10017');
    assert.equal(db.prepare('SELECT state FROM execution_log').get().state, 'REJECTED');
  } finally {
    db.close();
  }
});
test('MT5 history sync verifies identity, maps symbols, and deduplicates positions', async () => {
  const db = fixture();
  try {
    const account = db.prepare('SELECT * FROM accounts WHERE id=1').get();
    const snapshot = {
      login_id: '123',
      server_name: 'Demo',
      broker_company: 'Broker',
      account_name: 'Trader',
      currency: 'USD',
      balance: 10000,
      equity: 10000,
      trade_allowed: true,
      trade_expert: true,
      terminal_connected: true,
      terminal_path: account.terminal_path,
      adapter_mode: 'read-only',
    };
    const history = {
      login_id: '123',
      server_name: 'Demo',
      current_balance: 10000,
      balance_events: [],
      deal_count: 2,
      skipped_open_positions: 0,
      skipped_complex_positions: 0,
      trades: [
        {
          ticket_number: '123:42',
          broker_position_id: '42',
          broker_symbol: 'XAUUSDm',
          standard_symbol: 'XAUUSD',
          type: 'BUY',
          lot_size: 0.1,
          open_price: 2000,
          close_price: 2010,
          open_time: '2026-09-01T10:00:00.000Z',
          close_time: '2026-09-01T11:00:00.000Z',
          net_pnl: 95,
          pips: null,
          status: 'WIN',
          setup_tags: '[]',
          mistake_tags: '[]',
          notes: 'Synced from MetaTrader 5',
        },
      ],
    };
    const bridge = { request: async () => history };
    assert.equal((await syncMt5History(db, bridge, account, snapshot)).inserted, 1);
    assert.equal((await syncMt5History(db, bridge, account, snapshot)).duplicates, 1);
    assert.equal(db.prepare('SELECT count(*) AS total FROM trades').get().total, 1);
    assert.equal(
      db.prepare('SELECT broker_symbol FROM symbol_mappings').get().broker_symbol,
      'XAUUSDm',
    );
    await assert.rejects(
      syncMt5History(db, bridge, account, { ...snapshot, login_id: '999' }),
      /does not match/,
    );
  } finally {
    db.close();
  }
});
