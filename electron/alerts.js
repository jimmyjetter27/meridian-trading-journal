import { Notification } from 'electron';
import nodemailer from 'nodemailer';
import { z } from 'zod';

export class Alerts {
  constructor(db, bridge, getActiveAccountId, onPriceAlert) {
    this.db = db;
    this.bridge = bridge;
    this.getActiveAccountId = getActiveAccountId;
    this.onPriceAlert = onPriceAlert;
    this.smtp = null;
    this.polling = false;
    this.timer = setInterval(() => void this.poll(), 1000);
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
    const rules = this.db.prepare("SELECT * FROM price_alerts WHERE account_id=? AND status='ARMED'").all(accountId);
    if (!rules.length) return;
    this.polling = true;
    try {
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
    } finally { this.polling = false; }
  }
  close() { clearInterval(this.timer); }
}
