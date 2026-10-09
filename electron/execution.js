import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { orderSchema } from '../shared/contracts.js';
import { diagnose } from './diagnostics.js';
const quoteSchema = z.object({
  login_id: z.string(),
  server_name: z.string(),
  symbol: z.string(),
  bid: z.number().positive(),
  ask: z.number().positive(),
  timestamp: z.number(),
  volume_min: z.number().positive(),
  volume_max: z.number().positive(),
  volume_step: z.number().positive(),
  tick_size: z.number().positive(),
  tick_value: z.number().positive(),
  stops_level: z.number().nonnegative(),
});
const positionSchema = z.object({
  position_id: z.string().min(1),
  symbol: z.string().min(1),
  lots: z.number().positive(),
  stop_loss: z.number().nonnegative(),
  type: z.enum(['BUY', 'SELL']),
  login_id: z.string(),
  server_name: z.string(),
});
export class ExecutionEngine {
  constructor(db, bridge, { executionEnabled = false } = {}) {
    this.db = db;
    this.bridge = bridge;
    this.executionEnabled = executionEnabled;
    this.activeAccount = null;
    this.revision = 0;
    this.confirmations = new Map();
    this.busy = false;
  }
  select(id) {
    if (this.busy) throw Error('Wait for the current execution request');
    const a = this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
    if (!a) throw Error('Account not found');
    this.activeAccount = a;
    this.revision++;
    this.confirmations.clear();
    return a.id;
  }
  invalidate() {
    if (this.busy) throw Error('Execution is in progress');
    this.confirmations.clear();
    this.activeAccount = null;
    this.revision++;
  }
  account() {
    if (!this.activeAccount?.login_id || !this.activeAccount?.server_name)
      throw Error('Select an execution account with login and server configured');
    return this.activeAccount;
  }
  assertIdentity(data, a) {
    if (data.login_id !== a.login_id || data.server_name !== a.server_name)
      throw Error('Bridge terminal account does not match the selected account');
  }
  context(a) {
    return { account_id: a.id, login_id: a.login_id, server_name: a.server_name };
  }
  async prepare(action, input) {
    if (!this.executionEnabled) throw Error('Meridian is journal-only; trade execution is disabled');
    const a = this.account(),
      revision = this.revision;
    let payload, summary;
    if (action === 'place') {
      const order = orderSchema.parse(input);
      const mapping = this.db
        .prepare(
          'SELECT broker_symbol FROM symbol_mappings WHERE broker_name=? AND standard_symbol=?',
        )
        .get(a.broker_name, order.asset);
      if (!mapping) throw Error('Exact broker symbol mapping required');
      const symbol = mapping.broker_symbol;
      const quote = quoteSchema.parse(
        await this.bridge.request('symbol.snapshot', { ...this.context(a), symbol }),
      );
      this.assertIdentity(quote, a);
      if (quote.symbol !== symbol || Math.abs(Date.now() - quote.timestamp) > 5000)
        throw Error('Stale or mismatched quote');
      if (
        order.lots < quote.volume_min ||
        order.lots > quote.volume_max ||
        Math.abs(order.lots / quote.volume_step - Math.round(order.lots / quote.volume_step)) > 1e-7
      )
        throw Object.assign(Error('10014: Volume is outside broker limits or step'), {
          code: '10014',
        });
      const entry =
        order.kind === 'MARKET' ? (order.type === 'BUY' ? quote.ask : quote.bid) : order.price;
      const slDistance = order.type === 'BUY' ? entry - order.stop_loss : order.stop_loss - entry;
      if (slDistance <= 0 || slDistance < quote.stops_level)
        throw Error('Stop loss must be on the protective side and meet broker minimum distance');
      if (
        (order.kind === 'BUY_LIMIT' && entry >= quote.ask) ||
        (order.kind === 'SELL_LIMIT' && entry <= quote.bid) ||
        (order.kind === 'BUY_STOP' && entry <= quote.ask) ||
        (order.kind === 'SELL_STOP' && entry >= quote.bid)
      )
        throw Error('Pending price is on the wrong side of the market');
      const risk = (slDistance / quote.tick_size) * quote.tick_value * order.lots;
      payload = { ...this.context(a), symbol, ...order, entry };
      summary = {
        symbol,
        lots: order.lots,
        stop_loss: order.stop_loss,
        estimated_risk: risk,
        currency: a.base_currency,
        entry,
        type: order.type,
        kind: order.kind,
      };
    } else if (action === 'close') {
      const id = z.string().min(1).max(100).parse(input.position_id);
      const p = positionSchema.parse(
        await this.bridge.request('position.snapshot', { ...this.context(a), position_id: id }),
      );
      this.assertIdentity(p, a);
      if (p.position_id !== id) throw Error('Position mismatch');
      payload = {
        ...this.context(a),
        position_id: id,
        symbol: p.symbol,
        type: p.type,
        lots: p.lots,
        stop_loss: p.stop_loss,
      };
      summary = {
        symbol: p.symbol,
        lots: p.lots,
        stop_loss: p.stop_loss,
        position_id: id,
        type: p.type,
        kind: 'CLOSE',
        estimated_risk: null,
        currency: a.base_currency,
      };
    } else throw Error('Invalid execution action');
    if (this.revision !== revision) throw Error('Account changed; prepare again');
    const token = randomUUID(),
      expires_at = Date.now() + 15000;
    this.confirmations.clear();
    this.confirmations.set(token, { action, payload, revision, expires_at });
    return {
      token,
      expires_at,
      action,
      account: a.display_name,
      broker: a.broker_name,
      ...summary,
    };
  }
  async execute(action, token) {
    if (!this.executionEnabled) throw Error('Meridian is journal-only; trade execution is disabled');
    if (this.busy) throw Error('An execution request is already in progress');
    const c = this.confirmations.get(token);
    this.confirmations.delete(token);
    if (!c || c.action !== action || c.revision !== this.revision || Date.now() > c.expires_at)
      throw Error('Confirmation expired or already used. Review a new quote.');
    const unresolved = this.db
      .prepare("SELECT id FROM execution_log WHERE account_id=? AND state IN ('SENDING','UNKNOWN')")
      .get(c.payload.account_id);
    if (unresolved)
      throw Error(
        'An earlier execution has an unknown outcome. Reconcile its request ID with the bridge first.',
      );
    this.busy = true;
    try {
      this.db
        .prepare(
          'INSERT INTO execution_log(id,account_id,created_at,action,payload,state) VALUES(?,?,?,?,?,?)',
        )
        .run(
          token,
          c.payload.account_id,
          new Date().toISOString(),
          action,
          JSON.stringify(c.payload),
          'SENDING',
        );
      const result = await this.bridge.request(
        action === 'place' ? 'trade.place' : 'trade.close',
        { ...c.payload, request_id: token, expires_at: c.expires_at },
        token,
      );
      if (!result || !['10008', '10009', '10010'].includes(String(result.retcode))) {
        if (result?.retcode)
          throw Object.assign(Error(String(result.message || result.retcode)), {
            code: String(result.retcode),
          });
        throw Object.assign(Error('Malformed execution acknowledgement'), {
          code: 'BRIDGE_TIMEOUT',
        });
      }
      this.db
        .prepare("UPDATE execution_log SET state='ACKNOWLEDGED',detail=? WHERE id=?")
        .run(JSON.stringify(result), token);
      return { ok: true, result };
    } catch (e) {
      const unknown =
        ['BRIDGE_TIMEOUT', '10012', '10031', 'ERR_TRADE_SEND_FAILED'].includes(String(e.code)) ||
        !e.code;
      this.db
        .prepare('UPDATE execution_log SET state=?,detail=? WHERE id=?')
        .run(unknown ? 'UNKNOWN' : 'REJECTED', String(e.code || e.message), token);
      return { ok: false, diagnostic: diagnose(e) };
    } finally {
      this.busy = false;
    }
  }
  async reconcile(id) {
    if (!this.executionEnabled) throw Error('Meridian is journal-only; trade execution is disabled');
    const row = this.db
      .prepare("SELECT * FROM execution_log WHERE id=? AND state IN ('UNKNOWN','SENDING')")
      .get(z.string().uuid().parse(id));
    if (!row) throw Error('No unresolved request');
    const a = this.account();
    if (a.id !== row.account_id) throw Error('Select the original account');
    const result = await this.bridge.request('trade.status', {
      ...this.context(a),
      request_id: id,
    });
    this.assertIdentity(result, a);
    if (!['EXECUTED', 'REJECTED', 'NOT_SUBMITTED'].includes(result.state))
      throw Error('Bridge has not resolved the outcome');
    this.db
      .prepare('UPDATE execution_log SET state=?,detail=? WHERE id=?')
      .run(result.state, JSON.stringify(result), id);
    return result;
  }
}
