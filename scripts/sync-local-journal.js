import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Bridge } from '../electron/bridge.js';
import { openDatabase } from '../electron/database.js';
import { syncMt5History } from '../electron/mt5Sync.js';

const userData = join(process.env.APPDATA || process.cwd(), 'meridian-trading-journal');
const db = openDatabase(join(userData, 'journal.db'));
const accounts = db.prepare('SELECT * FROM accounts ORDER BY id').all();
if (!accounts.length) throw Error('No MT5 account profile is configured');
await db.backup(join(userData, `journal-before-mt5-sync-${Date.now()}.db`));

const token = randomBytes(32).toString('hex');
const terminalPath = accounts[0].terminal_path;
const args = ['--terminal', terminalPath, '--token', token, '--port', '0'];
const child = spawn(join(process.cwd(), 'adapter', 'dist', 'meridian-mt5-bridge.exe'), args, {
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bridge;
try {
  const ready = await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(Error('Adapter startup timed out')), 30000);
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
  const account = accounts.find((candidate) =>
    String(candidate.login_id) === String(ready.account.login_id) &&
    candidate.server_name.toLowerCase() === ready.account.server_name.toLowerCase());
  if (!account) throw Error(`The open MT5 account ${ready.account.login_id} (${ready.account.server_name}) has no Meridian profile`);
  bridge = new Bridge();
  await bridge.connect(`ws://127.0.0.1:${ready.port}`, token);
  const result = await syncMt5History(db, bridge, account, ready.account);
  console.log(
    JSON.stringify({
      server: result.account.server_name,
      company: result.account.broker_company,
      mode: result.account.adapter_mode,
      imported: result.inserted,
      duplicates: result.duplicates,
      closedPositions: result.closedPositions,
      historyDeals: result.dealCount,
      skippedOpenPositions: result.skippedOpenPositions,
      skippedComplexPositions: result.skippedComplexPositions,
    }),
  );
} finally {
  bridge?.disconnect();
  db.close();
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
process.exit(0);
