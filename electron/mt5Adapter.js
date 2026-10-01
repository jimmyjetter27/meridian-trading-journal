import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { app } from 'electron';

export class Mt5AdapterManager {
  constructor(bridge, root) {
    this.bridge = bridge;
    this.root = root;
    this.process = null;
    this.accountId = null;
  }

  executablePath() {
    return app.isPackaged
      ? join(process.resourcesPath, 'adapter', 'meridian-mt5-bridge.exe')
      : join(this.root, 'adapter', 'dist', 'meridian-mt5-bridge.exe');
  }

  connectedFor(accountId) {
    return this.accountId === accountId && this.process && !this.process.killed && this.bridge.socket?.readyState === 1;
  }

  stop() {
    this.bridge.disconnect();
    if (this.process?.pid && !this.process.killed) {
      execFile('taskkill.exe', ['/pid', String(this.process.pid), '/t', '/f'], {
        windowsHide: true,
      });
    }
    this.process = null;
    this.accountId = null;
  }

  async start(account) {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal(account);
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async startInternal(account) {
    this.stop();
    const executable = this.executablePath();
    if (!existsSync(executable)) throw Error('The packaged MT5 adapter is missing');
    const token = randomBytes(32).toString('hex');
    const args = ['--terminal', account.terminal_path, '--token', token, '--port', '0'];
    // Account identity is verified by the Electron main process. Leaving discovery
    // unpinned lets Meridian notice when the user switches login inside this terminal.
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.process = child;
    this.accountId = account.id;
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const ready = await new Promise((resolve, reject) => {
      let stdout = '';
      const timer = setTimeout(() => reject(Error('MT5 adapter startup timed out')), 20000);
      const fail = (error) => {
        clearTimeout(timer);
        reject(Error(`MT5 adapter failed: ${stderr || error?.message || 'unknown error'}`));
      };
      child.once('error', fail);
      child.once('exit', (code) => fail(Error(`process exited with code ${code}`)));
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        const newline = stdout.indexOf('\n');
        if (newline < 0) return;
        try {
          const message = JSON.parse(stdout.slice(0, newline));
          if (message.event !== 'ready' || !message.port) throw Error('Invalid startup response');
          clearTimeout(timer);
          resolve(message);
        } catch (error) {
          fail(error);
        }
      });
    });
    await this.bridge.connect(`ws://127.0.0.1:${ready.port}`, token);
    return ready.account;
  }
}
