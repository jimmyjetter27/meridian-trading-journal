import { Notification } from 'electron';
import nodemailer from 'nodemailer';
import { z } from 'zod';

export class Alerts {
  constructor(db, bridge, getActiveAccountId, onPriceAlert, onPendingOrderAlert) {
    this.db = db;
    this.bridge = bridge;
    this.getActiveAccountId = getActiveAccountId;
    this.onPriceAlert = onPriceAlert;
    this.onPendingOrderAlert = onPendingOrderAlert;
    this.smtp = null;
    this.polling = false;
    this.timer = setInterval(() => void this.poll(), 5000);
  }
  list() {
    return this.db.prepare(
      `SELECT p.*,a.display_name,a.broker_name FROM price_alerts p
       JOIN accounts a ON a.id=p.account_id ORDER BY p.created_at DESC`,
    ).all();
  }
  setRule(input) {
    const rule = z.object({
      account_id: z.number().int().positive(), standard_symbol: z.string().min(1).max(30),
      broker_symbol: z.string().min(1).max(100), target_price: z.number().positive().finite(),
      direction: z.enum(['above', 'below']), reference_price: z.number().positive().finite(),
      point_size: z.number().positive().finite(),
    }).parse(input);
    return Number(this.db.prepare(
      `INSERT INTO price_alerts(account_id,standard_symbol,broker_symbol,target_price,direction,reference_price,point_size,status,created_at)
       VALUES(@account_id,@standard_symbol,@broker_symbol,@target_price,@direction,@reference_price,@point_size,'ARMED',@created_at)`,
    ).run({ ...rule, created_at: new Date().toISOString() }).lastInsertRowid);
  }
  remove(id) { return this.db.prepare('DELETE FROM price_alerts WHERE id=?').run(id).changes; }
  rearm(id, referencePrice) {
    return this.db.prepare(
      `UPDATE price_alerts SET status='ARMED',reference_price=?,triggered_at=NULL,trigger_price=NULL WHERE id=?`,
    ).run(referencePrice, id).changes;
  }
  configureEmail(input) {
    const c = z.object({
      host: z.string().min(1), port: z.number().int().min(1).max(65535), secure: z.boolean(),
      user: z.string().min(1), password: z.string().min(1), from: z.email(), to: z.email(),
    }).parse(input);
    this.smtp = { transport: nodemailer.createTransport({ host: c.host, port: c.port, secure: c.secure, requireTLS: true,
      auth: { user: c.user, pass: c.password }, connectionTimeout: 5000, socketTimeout: 10000 }), from: c.from, to: c.to };
  }
  async notify(title, body) {
    if (Notification.isSupported()) new Notification({ title, body }).show();
    if (this.smtp) {
      try { await this.smtp.transport.sendMail({ from: this.smtp.from, to: this.smtp.to, subject: title, text: body }); }
      catch { if (Notification.isSupported()) new Notification({ title: 'Email delivery failed', body: 'Check the SMTP configuration. The native alert was still dispatched.' }).show(); }
    }
  }
  async poll() {
    if (this.polling) return;
    const accountId = this.getActiveAccountId();
    if (!accountId || this.bridge.socket?.readyState !== 1) return;
    this.polling = true;
    try {
      const rules = this.db.prepare("SELECT * FROM price_alerts WHERE account_id=? AND status='ARMED'").all(accountId);
      const quotes = new Map();
      for (const rule of rules) {
        let quote = quotes.get(rule.broker_symbol);
        if (!quote) {
          try { quote = await this.bridge.request('symbol.snapshot', { symbol: rule.broker_symbol }, undefined, 3000); }
          catch { continue; }
          quotes.set(rule.broker_symbol, quote);
        }
        const price = Number(quote.bid);
        const crossed = rule.direction === 'above' ? price >= rule.target_price : price <= rule.target_price;
        if (!crossed) continue;
        const movement = price >= rule.reference_price ? 'up' : 'down';
        const points = Math.abs(price - rule.reference_price) / rule.point_size;
        const message = `${rule.standard_symbol} price has moved ${movement} ${points.toLocaleString('en-US', { maximumFractionDigits: 1 })} points to ${price}. Target ${rule.target_price} reached.`;
        const now = new Date().toISOString();
        const changed = this.db.prepare(
          "UPDATE price_alerts SET status='TRIGGERED',triggered_at=?,trigger_price=? WHERE id=? AND status='ARMED'",
        ).run(now, price, rule.id).changes;
        if (!changed) continue;
        const payload = { ...rule, status: 'TRIGGERED', trigger_price: price, triggered_at: now, points, movement, message };
        this.onPriceAlert(payload);
        void this.notify('Meridian price alert', message);
      }
      await this.pollPendingOrders(accountId);
    } finally { this.polling = false; }
  }
  async pollPendingOrders(accountId) {
    let snapshot;
    try { snapshot = await this.bridge.request('positions.active', {}, undefined, 4000); }
    catch { return; }
    const now = new Date();
    const nowIso = now.toISOString();
    const active = new Map((snapshot.pending_orders || []).map((order) => [String(order.order_id), order]));
    const known = this.db.prepare('SELECT * FROM pending_order_alert_state WHERE account_id=?').all(accountId);
    const knownById = new Map(known.map((row) => [String(row.order_id), row]));
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO pending_order_alert_state(account_id,order_id,standard_symbol,broker_symbol,order_type,entry_price,first_seen_at,last_seen_at)
       VALUES(?,?,?,?,?,?,?,?)`,
    );
    const touch = this.db.prepare('UPDATE pending_order_alert_state SET last_seen_at=? WHERE account_id=? AND order_id=?');
    const remind = this.db.prepare('UPDATE pending_order_alert_state SET last_reminded_at=? WHERE account_id=? AND order_id=?');
    const triggered = this.db.prepare('UPDATE pending_order_alert_state SET triggered_at=? WHERE account_id=? AND order_id=? AND triggered_at IS NULL');
    const closeReminder = this.db.prepare('UPDATE pending_order_alert_state SET close_reminded_at=? WHERE account_id=? AND order_id=? AND close_reminded_at IS NULL');
    for (const [orderId, order] of active) {
      const state = knownById.get(orderId);
      if (!state) {
        insert.run(accountId, orderId, order.standard_symbol, order.symbol, order.type, order.entry, nowIso, nowIso);
        continue;
      }
      touch.run(nowIso, accountId, orderId);
      if (!state.last_reminded_at || now.getTime() - new Date(state.last_reminded_at).getTime() >= 15 * 60 * 1000) {
        remind.run(nowIso, accountId, orderId);
        this.dispatchPending('reminder', order, `Pending ${order.type} ${order.standard_symbol} at ${order.entry} is still waiting to trigger.`, nowIso);
      }
      // MT5 exposes a broker-set expiration reliably. It is the only close time
      // available to the read-only API, so Meridian does not guess a session close.
      if (order.expiration && !state.close_reminded_at && new Date(order.expiration).getTime() - now.getTime() <= 30 * 60 * 1000 && new Date(order.expiration).getTime() > now.getTime()) {
        closeReminder.run(nowIso, accountId, orderId);
        this.dispatchPending('close-reminder', order, `Pending ${order.type} ${order.standard_symbol} expires in less than 30 minutes. Review or cancel it in MT5 before market close.`, nowIso);
      }
    }
    const filled = new Map((snapshot.recent_order_updates || []).map((row) => [String(row.order_id), row]));
    for (const state of known) {
      if (active.has(String(state.order_id)) || state.triggered_at) continue;
      const update = filled.get(String(state.order_id));
      if (!update || !triggered.run(nowIso, accountId, state.order_id).changes) continue;
      this.dispatchPending('triggered', state, `Your pending ${state.order_type} ${state.standard_symbol} at ${state.entry_price} has been triggered.`, nowIso);
    }
  }
  dispatchPending(kind, order, message, occurredAt) {
    const payload = { kind, order_id: String(order.order_id), standard_symbol: order.standard_symbol, message, occurred_at: occurredAt };
    this.onPendingOrderAlert(payload);
    void this.notify(kind === 'triggered' ? 'Meridian order triggered' : 'Meridian pending-order reminder', message);
  }
  close() { clearInterval(this.timer); }
}
