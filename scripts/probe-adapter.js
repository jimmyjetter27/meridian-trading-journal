import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Bridge } from '../electron/bridge.js';

const executable = join(process.cwd(), 'adapter', 'dist', 'meridian-mt5-bridge.exe');
const token = randomBytes(32).toString('hex');
let bridge;
const child = spawn(
  executable,
  [
    '--terminal',
    'C:\\Program Files\\MetaTrader 5\\terminal64.exe',
    '--token',
    token,
    '--port',
    '0',
  ],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
);

try {
  const ready = await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(Error('Adapter probe timed out')), 30000);
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.once('exit', (code) => reject(Error(`Adapter exited ${code}: ${stderr}`)));
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      resolve(JSON.parse(stdout.slice(0, newline)));
    });
  });
  bridge = new Bridge();
  await bridge.connect(`ws://127.0.0.1:${ready.port}`, token);
  const account = await bridge.request('account.snapshot', {});
  const history = await bridge.request(
    'history.closed-trades',
    { date_from: '2000-01-01T00:00:00Z' },
    undefined,
    60000,
  );
  const positions = await bridge.request('positions.active', {});
  let ghs = null;
  try { ghs = await bridge.request('fx.rate', { base: 'USD', quote: 'GHS' }); } catch { /* Optional broker symbol. */ }
  const chartSymbol = positions.positions[0]?.symbol || history.trades.at(-1)?.broker_symbol;
  const chart = chartSymbol
    ? await bridge.request('chart.snapshot', {
        symbol: chartSymbol,
        timeframe: 'M1',
        date_from: new Date(Date.now() - 3 * 86400000).toISOString(),
        date_to: new Date().toISOString(),
      }, undefined, 15000)
    : { candles: [] };
  console.log(
    JSON.stringify({
      connected: account.terminal_connected,
      server: account.server_name,
      company: account.broker_company,
      currency: account.currency,
      mode: account.adapter_mode,
      closedPositions: history.trades.length,
      dealCount: history.deal_count,
      symbols: [...new Set(history.trades.map((trade) => trade.broker_symbol))].sort(),
      activePositions: positions.positions.length,
      pendingOrders: positions.pending_orders?.length || 0,
      chartSymbol,
      candles: chart.candles.length,
      chartTimeframe: chart.timeframe,
      usdGhs: ghs ? { symbol: ghs.symbol, bid: ghs.bid, ask: ghs.ask, timestamp: ghs.timestamp } : null,
    }),
  );
  bridge.disconnect();
} finally {
  bridge?.disconnect();
  if (child.pid) {
    try {
      execFileSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      // The adapter may already have exited.
    }
  }
}
