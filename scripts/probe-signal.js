import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Bridge } from '../electron/bridge.js';

const token = randomBytes(32).toString('hex');
const child = spawn(join(process.cwd(), 'adapter', 'dist', 'meridian-mt5-bridge.exe'), [
  '--terminal', 'C:\\Program Files\\MetaTrader 5\\terminal64.exe', '--token', token, '--port', '0',
], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let bridge;
try {
  const ready = await new Promise((resolve, reject) => {
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => reject(Error('Adapter probe timed out')), 30000);
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.once('exit', (code) => reject(Error(`Adapter exited ${code}: ${stderr}`)));
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString(); const newline = stdout.indexOf('\n');
      if (newline < 0) return; clearTimeout(timer); resolve(JSON.parse(stdout.slice(0, newline)));
    });
  });
  bridge = new Bridge();
  await bridge.connect(`ws://127.0.0.1:${ready.port}`, token);
  const result = await bridge.request('signal.backtest', {
    symbol: 'XAUUSD-VIP', date_from: '2026-10-08T00:00:00.000Z', date_to: '2026-10-08T23:59:59.999Z',
    side: 'BUY', zone_low: 4117, zone_high: 4120, stop_loss: 4112, take_profit: 4125, lot_size: 0.01,
    tp1_confirmed: true, stop_confirmed: false,
    reported_entries: [{ reported_pips: 50, entry: 4117 }, { reported_pips: 80, entry: 4114 }],
  }, undefined, 60000);
  console.log(JSON.stringify(result));
} finally {
  bridge?.disconnect();
  if (child.pid) try { execFileSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); } catch { /* already stopped */ }
}
