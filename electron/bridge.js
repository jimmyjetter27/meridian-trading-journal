import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
export class Bridge extends EventEmitter {
  constructor() {
    super();
    this.pending = new Map();
    this.socket = null;
  }
  connect(url, token) {
    const u = new URL(url);
    if (
      u.protocol !== 'ws:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      throw Error('Use a loopback ws:// address without embedded credentials');
    if (typeof token !== 'string' || token.length < 16 || token.length > 4096)
      throw Error('A bridge token of at least 16 characters is required');
    this.disconnect();
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
        maxPayload: 1024 * 1024,
        handshakeTimeout: 5000,
      });
      this.socket = socket;
      socket.on('message', (raw) => {
        if (this.socket !== socket) return;
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'tick') {
            this.emit('tick', msg);
            return;
          }
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error)
            p.reject(
              Object.assign(Error(String(msg.error.message || 'Bridge error')), {
                code: String(msg.error.code || ''),
              }),
            );
          else p.resolve(msg.result);
        } catch {
          /* Malformed frames never execute commands. */
        }
      });
      socket.once('error', (error) => {
        this.emit('status', 'Connection failed');
        reject(error);
      });
      socket.once('open', () => {
        if (this.socket === socket) {
          this.emit('status', 'Connected');
          resolve();
        }
      });
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.rejectPending();
        this.emit('status', 'Disconnected');
      });
    });
  }
  rejectPending() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(
        Object.assign(Error('Bridge disconnected; outcome may be unknown'), {
          code: 'BRIDGE_TIMEOUT',
        }),
      );
    }
    this.pending.clear();
  }
  disconnect() {
    this.rejectPending();
    if (this.socket) {
      this.socket.terminate();
      this.socket = null;
    }
  }
  request(method, params, id = randomUUID(), timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (this.socket?.readyState !== WebSocket.OPEN)
        return reject(Error('Bridge is not connected'));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          Object.assign(Error('Bridge timed out; reconcile in MT5 before any retry'), {
            code: 'BRIDGE_TIMEOUT',
          }),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), (e) => {
        if (e) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(
            Object.assign(Error('Bridge send failed; reconcile in MT5'), {
              code: 'BRIDGE_TIMEOUT',
            }),
          );
        }
      });
    });
  }
}
