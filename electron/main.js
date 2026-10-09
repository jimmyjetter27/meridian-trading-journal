import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import {
  openDatabase,
  publicAccounts,
  insertObject,
  filteredTrades,
  packageData,
  restorePackage,
} from './database.js';
import { accountSchema, mappingSchema } from '../shared/contracts.js';
import { addTradeReturnPercentages, analytics } from './analytics.js';
import { importCsv } from './importer.js';
import { Bridge } from './bridge.js';
import { ExecutionEngine } from './execution.js';
import { Alerts } from './alerts.js';
import { diagnose } from './diagnostics.js';
import { Mt5AdapterManager } from './mt5Adapter.js';
import { syncMt5History } from './mt5Sync.js';
import { calculatePeriodReturns } from './returns.js';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
let db, win, engine, alerts;
let restoring = false;
let autoSyncTimer;
let autoSyncBusy = false;
let lastAutoSyncKey = '';
let lastAutoSyncAt = 0;
const bridge = new Bridge();
let status = 'Disconnected';
let adapter;
if (!app.requestSingleInstanceLock()) app.quit();
else
  app.whenReady().then(() => {
    db = openDatabase(join(app.getPath('userData'), 'journal.db'));
    engine = new ExecutionEngine(db, bridge);
    adapter = new Mt5AdapterManager(bridge, root);
    const existingAccounts = publicAccounts(db);
    if (existingAccounts.length === 1) engine.select(existingAccounts[0].id);
    db.prepare("INSERT OR IGNORE INTO app_settings(key,value) VALUES('alert_mode','tone')").run();
    alerts = new Alerts(
      db,
      bridge,
      () => engine.activeAccount?.id || null,
      (payload) => win?.webContents.send('price-alert', payload),
    );
    const dev = !app.isPackaged && process.argv.includes('--dev');
    const url = dev ? 'http://127.0.0.1:5173' : pathToFileURL(join(root, 'dist/index.html')).href;
    const handle = (channel, fn) =>
      ipcMain.handle(channel, async (event, input) => {
        if (
          event.sender !== win.webContents ||
          event.senderFrame !== win.webContents.mainFrame ||
          (event.senderFrame.url.split('#')[0] !== url &&
            event.senderFrame.url.split('#')[0] !== url + '/')
        )
          throw Error('Untrusted IPC sender');
        try {
          if (restoring) throw Error('Journal restore is in progress');
          return { ok: true, data: await fn(input) };
        } catch (e) {
          return { ok: false, error: e.message, diagnostic: diagnose(e) };
        }
      });
    handle('journal:read', (input) => {
      const f = z
        .object({
          account: z.number().int().positive().optional(),
          broker: z.string().optional(),
          asset: z.string().optional(),
          since: z.string().datetime().optional(),
          until: z.string().datetime().optional(),
        })
        .parse(input || {});
      const balances = db.prepare('SELECT account_id,balance,captured_at FROM account_balances').all();
      const balanceMap = new Map(balances.map((row) => [row.account_id, row]));
      const tradeTotals = new Map(db.prepare('SELECT account_id,SUM(net_pnl) AS total FROM trades GROUP BY account_id').all().map((row) => [row.account_id, Number(row.total || 0)]));
      const flowTotals = new Map(db.prepare('SELECT account_id,SUM(amount) AS total FROM capital_events GROUP BY account_id').all().map((row) => [row.account_id, Number(row.total || 0)]));
      const accounts = publicAccounts(db).map((account) => ({
          ...account,
          current_balance: balanceMap.get(account.id)?.balance ?? Number(account.starting_balance || 0) + (tradeTotals.get(account.id) || 0) + (flowTotals.get(account.id) || 0),
          balance_captured_at: balanceMap.get(account.id)?.captured_at || null,
        })),
        selected = accounts.filter(
          (a) => (!f.account || a.id === f.account) && (!f.broker || a.broker_name === f.broker),
        );
      const filtered = filteredTrades(db, f);
      const selectedIds = new Set(selected.map((account) => account.id));
      const allTrades = db.prepare('SELECT account_id,close_time,net_pnl FROM trades ORDER BY close_time,id').all()
        .filter((trade) => selectedIds.has(trade.account_id));
      const capitalEvents = db.prepare(
        `SELECT c.*,a.display_name,a.broker_name,a.base_currency
         FROM capital_events c JOIN accounts a ON a.id=c.account_id
         WHERE (@account IS NULL OR c.account_id=@account)
           AND (@broker IS NULL OR a.broker_name=@broker)
         ORDER BY c.occurred_at DESC,c.id DESC`,
      ).all({ account: f.account || null, broker: f.broker || null });
      const visibleCashFlows = capitalEvents.filter((event) =>
        (!f.since || event.occurred_at >= f.since) && (!f.until || event.occurred_at < f.until));
      const trades = addTradeReturnPercentages(filtered, selected, db.prepare('SELECT id,account_id,close_time,net_pnl FROM trades ORDER BY close_time,id').all().filter((trade) => selectedIds.has(trade.account_id)), capitalEvents, balances);
      return {
        accounts,
        trades,
        metrics: analytics(trades, selected, {
          allTrades,
          capitalEvents,
          balanceSnapshots: balances,
          since: f.since,
          until: f.until,
        }),
        cashFlows: visibleCashFlows,
        mappings: db.prepare('SELECT * FROM symbol_mappings').all(),
        activeAccount: engine.activeAccount?.id || null,
        status,
        logs: db
          .prepare(
            'SELECT * FROM execution_log WHERE (? IS NULL OR account_id=?) ORDER BY created_at DESC LIMIT 100',
          )
          .all(engine.activeAccount?.id || null, engine.activeAccount?.id || null),
        dailyEntries: db.prepare(
          `SELECT d.*,a.display_name,a.broker_name FROM daily_entries d JOIN accounts a ON a.id=d.account_id
           WHERE (@account IS NULL OR d.account_id=@account) ORDER BY d.entry_date DESC LIMIT 180`,
        ).all({ account: f.account || null }),
        priceAlerts: alerts.list(),
        alertMode: db.prepare("SELECT value FROM app_settings WHERE key='alert_mode'").get()?.value || 'tone',
      };
    });
    handle(
      'accounts:add',
      (input) => insertObject(db, 'accounts', accountSchema.parse(input)).lastInsertRowid,
    );
    handle('accounts:update', (input) => {
      if (engine.busy) throw Error('Wait for execution to finish');
      const row = accountSchema.extend({ id: z.number().int().positive() }).parse(input);
      const result = db
        .prepare(
          `UPDATE accounts SET broker_name=@broker_name,account_type=@account_type,
          base_currency=@base_currency,display_name=@display_name,starting_balance=@starting_balance,
          login_id=@login_id,server_name=@server_name,terminal_path=@terminal_path,
          tracking_since=@tracking_since WHERE id=@id`,
        )
        .run(row);
      if (!result.changes) throw Error('Account not found');
      if (engine.activeAccount?.id === row.id) engine.select(row.id);
      return result.changes;
    });
    handle('accounts:select', (input) => engine.select(z.number().int().positive().parse(input)));
    handle('accounts:choose-terminal', async () => {
      const choice = await dialog.showOpenDialog(win, {
        title: 'Choose a MetaTrader 5 terminal',
        properties: ['openFile'],
        defaultPath: 'C:\\Program Files\\MetaTrader 5\\terminal64.exe',
        filters: [{ name: 'MetaTrader 5 terminal', extensions: ['exe'] }],
      });
      if (choice.canceled) return null;
      const terminalPath = choice.filePaths[0];
      if (basename(terminalPath).toLowerCase() !== 'terminal64.exe')
        throw Error('Choose an MT5 terminal64.exe file');
      return terminalPath;
    });
    handle('accounts:launch-terminal', async (input) => {
      const id = z.number().int().positive().parse(input);
      const account = db.prepare('SELECT terminal_path FROM accounts WHERE id=?').get(id);
      if (!account?.terminal_path) throw Error('Configure this account’s MT5 terminal path first');
      if (basename(account.terminal_path).toLowerCase() !== 'terminal64.exe')
        throw Error('Configured path must point to terminal64.exe');
      const terminal = await stat(account.terminal_path);
      if (!terminal.isFile()) throw Error('The configured MT5 terminal was not found');
      const child = spawn(account.terminal_path, [], {
        cwd: dirname(account.terminal_path),
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
      return account.terminal_path;
    });
    handle('mt5:connect-sync', async (input) => {
      if (engine.busy) throw Error('Execution is in progress');
      const id = z.number().int().positive().parse(input);
      const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
      if (!account) throw Error('Account not found');
      engine.select(id);
      status = 'Connecting to MT5…';
      win?.webContents.send('bridge:status', status);
      try {
        const snapshot = await adapter.start(account);
        const result = await syncMt5History(db, bridge, account, snapshot);
        engine.select(id);
        status = 'Connected · read-only';
        win?.webContents.send('bridge:status', status);
        return result;
      } catch (error) {
        adapter.stop();
        status = 'Disconnected';
        win?.webContents.send('bridge:status', status);
        throw error;
      }
    });
    async function ensureAdapter(account) {
      if (adapter.connectedFor(account.id)) return;
      status = 'Connecting to MT5…';
      win?.webContents.send('bridge:status', status);
      try {
        await adapter.start(account);
        status = 'Connected · read-only';
        win?.webContents.send('bridge:status', status);
      } catch (error) {
        adapter.stop();
        status = 'Disconnected';
        win?.webContents.send('bridge:status', status);
        throw error;
      }
    }
    const liveAccount = async (input) => {
      const id = z.number().int().positive().parse(input);
      const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
      if (!account) throw Error('Account not found');
      engine.select(id);
      await ensureAdapter(account);
      return account;
    };
    async function discoverCurrentMt5Account() {
      if (autoSyncBusy || restoring || engine.busy) return;
      autoSyncBusy = true;
      try {
        const accounts = db.prepare('SELECT * FROM accounts ORDER BY id').all();
        if (!accounts.length) return;
        let snapshot;
        if (bridge.socket?.readyState === 1) {
          try { snapshot = await bridge.request('account.snapshot', {}, undefined, 5000); }
          catch { adapter.stop(); }
        }
        if (!snapshot) {
          const candidates = [...accounts].sort((a, b) => Number(b.id === engine.activeAccount?.id) - Number(a.id === engine.activeAccount?.id));
          const tried = new Set();
          for (const candidate of candidates) {
            if (tried.has(candidate.terminal_path)) continue;
            tried.add(candidate.terminal_path);
            try { snapshot = await adapter.start(candidate); break; } catch { /* Try the next configured terminal. */ }
          }
        }
        if (!snapshot) return;
        const matched = accounts.find((account) => String(account.login_id) === String(snapshot.login_id) && account.server_name === snapshot.server_name);
        if (!matched) {
          status = `MT5 account ${snapshot.login_id} is not configured`;
          win?.webContents.send('bridge:status', status);
          return;
        }
        adapter.accountId = matched.id;
        const accountChanged = engine.activeAccount?.id !== matched.id;
        if (accountChanged) engine.select(matched.id);
        status = 'Connected · read-only';
        win?.webContents.send('bridge:status', status);
        const identity = `${matched.id}:${snapshot.login_id}:${snapshot.server_name}`;
        if (identity !== lastAutoSyncKey || Date.now() - lastAutoSyncAt >= 60000) {
          const result = await syncMt5History(db, bridge, matched, snapshot);
          lastAutoSyncKey = identity;
          lastAutoSyncAt = Date.now();
          win?.webContents.send('journal:changed', {
            account_id: matched.id, inserted: result.inserted, duplicates: result.duplicates,
            reason: accountChanged ? 'account-switch' : 'refresh',
          });
        } else if (accountChanged) {
          win?.webContents.send('journal:changed', { account_id: matched.id, inserted: 0, reason: 'account-detected' });
        }
      } finally { autoSyncBusy = false; }
    }
    handle('mt5:positions', async (input) => {
      const account = await liveAccount(input);
      const result = await bridge.request('positions.active', {});
      if (String(result.login_id) !== String(account.login_id) || result.server_name !== account.server_name)
        throw Error('MT5 returned data for a different account');
      return result;
    });
    handle('mt5:chart', async (input) => {
      const request = z.object({
        account_id: z.number().int().positive(),
        asset: z.string().min(1).max(30),
        timeframe: z.enum(['M1', 'M5', 'M15', 'H1', 'H4', 'D1']),
        date_from: z.string().datetime(),
        date_to: z.string().datetime(),
      }).parse(input);
      const account = await liveAccount(request.account_id);
      const mapping = db.prepare(
        'SELECT broker_symbol FROM symbol_mappings WHERE broker_name=? AND standard_symbol=?',
      ).get(account.broker_name, request.asset);
      if (!mapping) throw Error(`No ${request.asset} symbol mapping is configured for ${account.broker_name}`);
      const result = await bridge.request('chart.snapshot', {
        symbol: mapping.broker_symbol,
        timeframe: request.timeframe,
        date_from: request.date_from,
        date_to: request.date_to,
      }, undefined, 15000);
      if (String(result.login_id) !== String(account.login_id) || result.server_name !== account.server_name)
        throw Error('MT5 returned chart data for a different account');
      const trades = db.prepare(
        `SELECT t.*,a.display_name,a.broker_name,a.base_currency
         FROM trades t JOIN accounts a ON a.id=t.account_id
         WHERE t.account_id=? AND t.standard_symbol=? ORDER BY t.open_time`,
      ).all(account.id, request.asset);
      return { ...result, standard_symbol: request.asset, trades };
    });
    handle('mt5:fx-rate', async (input) => {
      const request = z.object({ account_id: z.number().int().positive(), quote: z.literal('GHS') }).parse(input);
      const account = await liveAccount(request.account_id);
      const result = await bridge.request('fx.rate', { base: account.base_currency, quote: request.quote });
      if (String(result.login_id) !== String(account.login_id) || result.server_name !== account.server_name)
        throw Error('MT5 returned a conversion quote for a different account');
      return result;
    });
    handle('daily:save', (input) => {
      const row = z.object({
        account_id: z.number().int().positive(),
        entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        session: z.string().max(100), mood: z.string().max(100),
        behavior_tags: z.array(z.string().min(1).max(100)).max(30),
        market_context: z.string().max(10000), reflection: z.string().max(20000),
        next_session_rule: z.string().max(10000),
      }).parse(input);
      const now = new Date().toISOString();
      return db.prepare(
        `INSERT INTO daily_entries(account_id,entry_date,session,mood,behavior_tags,market_context,reflection,next_session_rule,created_at,updated_at)
         VALUES(@account_id,@entry_date,@session,@mood,@behavior_tags,@market_context,@reflection,@next_session_rule,@now,@now)
         ON CONFLICT(account_id,entry_date) DO UPDATE SET session=excluded.session,mood=excluded.mood,behavior_tags=excluded.behavior_tags,
         market_context=excluded.market_context,reflection=excluded.reflection,next_session_rule=excluded.next_session_rule,updated_at=excluded.updated_at`,
      ).run({ ...row, behavior_tags: JSON.stringify(row.behavior_tags), now }).changes;
    });
    handle('returns:read', (input) => {
      const request = z.object({
        account: z.number().int().positive().optional(),
        broker: z.string().max(100).optional(),
        granularity: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
      }).parse(input || {});
      const accounts = publicAccounts(db).filter((account) =>
        (!request.account || account.id === request.account) &&
        (!request.broker || account.broker_name === request.broker));
      const ids = new Set(accounts.map((account) => account.id));
      const trades = db.prepare('SELECT account_id,close_time,net_pnl FROM trades ORDER BY close_time,id').all()
        .filter((trade) => ids.has(trade.account_id));
      const capitalEvents = db.prepare('SELECT account_id,occurred_at,amount FROM capital_events ORDER BY occurred_at,id').all()
        .filter((event) => ids.has(event.account_id));
      const balances = db.prepare('SELECT account_id,balance,captured_at FROM account_balances').all()
        .filter((balance) => ids.has(balance.account_id));
      return calculatePeriodReturns(accounts, trades, capitalEvents, balances, request.granularity);
    });
    handle('mappings:save', (input) => {
      if (engine.busy) throw Error('Wait for execution to finish');
      const row = mappingSchema.parse(input);
      engine.confirmations.clear();
      engine.revision++;
      return db
        .prepare(
          'INSERT INTO symbol_mappings(broker_name,standard_symbol,broker_symbol) VALUES(@broker_name,@standard_symbol,@broker_symbol) ON CONFLICT(broker_name,standard_symbol) DO UPDATE SET broker_symbol=excluded.broker_symbol',
        )
        .run(row).changes;
    });
    handle('csv:import', (input) => {
      const p = z
        .object({ text: z.string().max(20000000), account_id: z.number().int().positive() })
        .parse(input);
      return importCsv(db, p.text, p.account_id);
    });
    handle('trade:annotate', (input) => {
      const p = z
        .object({
          id: z.number().int().positive(),
          notes: z.string().max(50000),
          setup_tags: z.array(z.string().max(100)).max(100),
          mistake_tags: z.array(z.string().max(100)).max(100),
        })
        .parse(input);
      return db
        .prepare('UPDATE trades SET notes=?,setup_tags=?,mistake_tags=? WHERE id=?')
        .run(p.notes, JSON.stringify(p.setup_tags), JSON.stringify(p.mistake_tags), p.id).changes;
    });
    handle('journal:export', async () => {
      const choice = await dialog.showSaveDialog(win, {
        defaultPath: 'meridian-journal.json',
        filters: [{ name: 'Portable journal', extensions: ['json'] }],
      });
      if (choice.canceled) return null;
      await writeFile(choice.filePath, JSON.stringify(packageData(db), null, 2), 'utf8');
      return choice.filePath;
    });
    handle('journal:restore', async () => {
      if (engine.busy) throw Error('Execution is in progress');
      const choice = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: 'Portable journal', extensions: ['json'] }],
      });
      if (choice.canceled) return null;
      const path = choice.filePaths[0];
      if ((await stat(path)).size > 100000000) throw Error('Backup exceeds 100 MB');
      const data = JSON.parse(await readFile(path, 'utf8'));
      const confirm = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Cancel', 'Restore journal'],
        defaultId: 0,
        cancelId: 0,
        message: 'Replace this journal with the selected backup?',
        detail:
          'Current data will be saved to a recovery JSON in your application data directory. Credentials must be reconfigured.',
      });
      if (confirm.response !== 1) return null;
      if (
        engine.busy ||
        db
          .prepare("SELECT id FROM execution_log WHERE state IN ('SENDING','UNKNOWN') LIMIT 1")
          .get()
      )
        throw Error('Reconcile outstanding executions before restoring');
      engine.invalidate();
      restoring = true;
      try {
        await writeFile(
          join(app.getPath('userData'), `before-restore-${Date.now()}.json`),
          JSON.stringify(packageData(db)),
        );
        restorePackage(db, data);
        bridge.disconnect();
        status = 'Disconnected';
        return true;
      } finally {
        restoring = false;
      }
    });
    handle('bridge:connect', (input) => {
      if (engine.busy) throw Error('Execution is in progress');
      const c = z.object({ url: z.string().max(200), token: z.string().max(4096) }).parse(input);
      engine.confirmations.clear();
      adapter.stop();
      return bridge.connect(c.url, c.token).then(() => true);
    });
    handle('alerts:add', (input) => {
      const a = engine.account();
      const p = z
        .object({
          asset: z.string(),
          bound: z.number().positive(),
        })
        .parse(input);
      const m = db
        .prepare(
          'SELECT broker_symbol FROM symbol_mappings WHERE broker_name=? AND standard_symbol=?',
        )
        .get(a.broker_name, p.asset);
      if (!m) throw Error('Configure a symbol mapping first');
      return ensureAdapter(a).then(async () => {
        const quote = await bridge.request('symbol.snapshot', { symbol: m.broker_symbol });
        return alerts.setRule({
          account_id: a.id, standard_symbol: p.asset, broker_symbol: m.broker_symbol,
          target_price: p.bound, direction: p.bound >= quote.bid ? 'above' : 'below', reference_price: quote.bid,
          point_size: quote.tick_size,
        });
      });
    });
    handle('alerts:delete', (input) => alerts.remove(z.number().int().positive().parse(input)));
    handle('alerts:rearm', async (input) => {
      const id = z.number().int().positive().parse(input);
      const rule = db.prepare('SELECT * FROM price_alerts WHERE id=?').get(id);
      if (!rule) throw Error('Price alert not found');
      const account = await liveAccount(rule.account_id);
      const quote = await bridge.request('symbol.snapshot', { symbol: rule.broker_symbol });
      return alerts.rearm(id, quote.bid);
    });
    handle('alerts:preference', (input) => {
      const mode = z.enum(['tone', 'voice']).parse(input);
      db.prepare("INSERT INTO app_settings(key,value) VALUES('alert_mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(mode);
      return mode;
    });
    handle('alerts:email', (input) => {
      alerts.configureEmail(input);
      return true;
    });
    bridge.on('status', (s) => {
      status = s;
      win?.webContents.send('bridge:status', s);
    });
    if (existingAccounts.length === 1 && db.prepare("SELECT id FROM price_alerts WHERE account_id=? AND status='ARMED' LIMIT 1").get(existingAccounts[0].id)) {
      void ensureAdapter(existingAccounts[0]).catch(() => {});
    }
    function createWindow() {
      win = new BrowserWindow({
        width: 1480,
        height: 940,
        minWidth: 1000,
        minHeight: 700,
        backgroundColor: '#0b1018',
        title: 'Meridian',
        icon: join(root, 'build/icon.png'),
        webPreferences: {
          preload: join(root, 'electron/preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (event, target) => {
        if (target !== url) event.preventDefault();
      });
      win.webContents.session.setPermissionRequestHandler((_w, _p, cb) => cb(false));
      win.loadURL(url);
    }
    createWindow();
    setTimeout(() => void discoverCurrentMt5Account(), 1200);
    autoSyncTimer = setInterval(() => void discoverCurrentMt5Account(), 10000);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  clearInterval(autoSyncTimer);
  alerts?.close();
  adapter?.stop();
  bridge.disconnect();
  db?.close();
});
