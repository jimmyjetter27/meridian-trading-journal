import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram';

export class TelegramConnector {
  constructor(db, safeStorage) { this.db = db; this.safeStorage = safeStorage; this.client = null; this.phoneCodeHash = null; }
  credentials() {
    const id = this.db.prepare("SELECT value FROM app_settings WHERE key='telegram_api_id'").get()?.value;
    const encrypted = this.db.prepare("SELECT value FROM app_settings WHERE key='telegram_api_hash'").get()?.value;
    if (!id || !encrypted) throw Error('Save your Telegram API ID and API hash in Settings first.');
    return { apiId: Number(id), apiHash: this.safeStorage.decryptString(Buffer.from(encrypted, 'base64')) };
  }
  async begin(phone) {
    const { apiId, apiHash } = this.credentials();
    const saved = this.db.prepare("SELECT value FROM app_settings WHERE key='telegram_session'").get()?.value || '';
    const session = new StringSession(saved ? this.safeStorage.decryptString(Buffer.from(saved, 'base64')) : '');
    this.client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 3 });
    await this.client.connect();
    const result = await this.client.sendCode({ apiId, apiHash }, phone);
    this.phoneCodeHash = result.phoneCodeHash;
    return { phone };
  }
  async verify(phone, code) {
    if (!this.client || !this.phoneCodeHash) throw Error('Start Telegram sign-in first.');
    await this.client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash: this.phoneCodeHash, phoneCode: code }));
    const session = this.client.session.save();
    this.db.prepare("INSERT INTO app_settings(key,value) VALUES('telegram_session',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(this.safeStorage.encryptString(session).toString('base64'));
    return { connected: true };
  }
  async connectedClient() {
    if (this.client?.connected) return this.client;
    const { apiId, apiHash } = this.credentials();
    const encrypted = this.db.prepare("SELECT value FROM app_settings WHERE key='telegram_session'").get()?.value;
    if (!encrypted) throw Error('Connect your Telegram account first.');
    this.client = new TelegramClient(new StringSession(this.safeStorage.decryptString(Buffer.from(encrypted, 'base64'))), apiId, apiHash, { connectionRetries: 3 });
    await this.client.connect();
    if (!(await this.client.checkAuthorization())) throw Error('Telegram sign-in has expired. Sign in again.');
    return this.client;
  }
  async dialogs() {
    const client = await this.connectedClient(); const rows = [];
    for await (const dialog of client.iterDialogs({ limit: 150 })) rows.push({ id: String(dialog.id), title: dialog.title || 'Untitled chat' });
    return rows;
  }
  async messages(id) {
    const client = await this.connectedClient();
    const messages = await client.getMessages(id, { limit: 60 });
    return messages.filter((message) => message.message).map((message) => ({ id: String(message.id), text: message.message, date: message.date ? new Date(message.date * 1000).toISOString() : null }));
  }
  async history(id, since) {
    const client = await this.connectedClient();
    const cutoff = Math.floor(new Date(since).getTime() / 1000);
    const rows = [];
    for await (const message of client.iterMessages(id, { reverse: true, offsetDate: cutoff, limit: 50000 })) {
      if (!message.message) continue;
      rows.push({ id: String(message.id), text: message.message, date: message.date ? new Date(message.date * 1000).toISOString() : null });
    }
    return rows;
  }
}
