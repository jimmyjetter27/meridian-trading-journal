import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CandlestickSeries, ColorType, CrosshairMode, createChart, createSeriesMarkers } from 'lightweight-charts';
import { disclaimer } from '../shared/contracts.js';
import './styles.css';
const assets = ['XAUUSD', 'USOIL', 'XAGUSD', 'NAS100'];
async function call(channel, input) {
  if (!window.journal) throw Error('Open Meridian in Electron to access your local journal.');
  const r = await window.journal.call(channel, input);
  if (!r.ok) throw Object.assign(Error(r.error), { diagnostic: r.diagnostic });
  return r.data;
}
const money = (n, c = 'USD') =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: c,
    maximumFractionDigits: 2,
  }).format(n || 0);
const ghsMoney = (n) => new Intl.NumberFormat('en-GH', { style: 'currency', currency: 'GHS', maximumFractionDigits: 2 }).format(n || 0);
const moneyPairText = (value, currency, fx) => {
  const primary = money(value, currency);
  if (currency !== 'USD' || !fx) return primary;
  const rate = Number(value) < 0 ? fx.ask : fx.bid;
  return `${primary} · ${ghsMoney(Number(value || 0) * rate)}`;
};
function MoneyValue({ value, currency = 'USD', fx }) {
  return <>{money(value, currency)}{currency === 'USD' && fx && <small className="ghs-equivalent">{ghsMoney(Number(value || 0) * (Number(value) < 0 ? fx.ask : fx.bid))}</small>}</>;
}
function playSoftTone() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const context = new AudioContext();
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 1.15);
  gain.connect(context.destination);
  [523.25, 659.25].forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    oscillator.type = 'sine'; oscillator.frequency.value = frequency;
    oscillator.connect(gain); oscillator.start(context.currentTime + index * 0.16); oscillator.stop(context.currentTime + 1.2);
  });
  setTimeout(() => void context.close(), 1500);
}
function speakAlert(message) {
  if (!window.speechSynthesis) { playSoftTone(); return; }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(message);
  const voices = window.speechSynthesis.getVoices();
  utterance.voice = voices.find((voice) => /Natural|Online/i.test(voice.name) && voice.lang.startsWith('en')) || voices.find((voice) => voice.lang.startsWith('en')) || null;
  utterance.rate = 0.92; utterance.pitch = 1; utterance.volume = 0.85;
  window.speechSynthesis.speak(utterance);
}
const previewAlert = (mode) => {
  const message = 'XAUUSD price has moved up 25 points. Your target has been reached.';
  if (mode === 'voice') speakAlert(message); else playSoftTone();
};
function Field({ label, children, ...props }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children || <input {...props} />}
    </label>
  );
}
function Modal({ title, onClose, children }) {
  return (
    <div className="overlay" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <h2>{title}</h2>
          <button aria-label="Close dialog" onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
const number = (value, digits = 2) =>
  value == null ? '—' : Number(value).toLocaleString('en-US', { maximumFractionDigits: digits });

function ActiveTrades({ account, onError, fx }) {
  const [snapshot, setSnapshot] = useState(null);
  const [selectedPosition, setSelectedPosition] = useState(null);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [loading, setLoading] = useState(false);
  async function load() {
    if (!account) return;
    try {
      setLoading(true);
      setSnapshot(await call('mt5:positions', account.id));
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    setSnapshot(null);
    if (!account) return;
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [account?.id]);
  const positions = snapshot?.positions || [];
  const pendingOrders = snapshot?.pending_orders || [];
  const protectedRisk = positions.reduce((sum, position) => sum + Number(position.risk_amount || 0), 0);
  const unprotected = positions.filter((position) => !position.stop_loss).length;
  return (
    <>
      <section className="panel live-summary">
        <div>
          <div className="live-indicator"><span /> LIVE FROM MT5</div>
          <h2>{positions.length} active · {pendingOrders.length} pending</h2>
          <p className="muted mt-2">{account ? `${account.display_name} · ${account.server_name}` : 'Select an account above.'}</p>
        </div>
        <div className="live-totals">
          <small>Floating P&amp;L</small>
          <strong className={(positions.reduce((sum, p) => sum + p.current_pnl, 0)) < 0 ? 'negative' : 'positive'}>
            <MoneyValue value={positions.reduce((sum, p) => sum + p.current_pnl, 0)} currency={snapshot?.currency || account?.base_currency} fx={fx} />
          </strong>
          <small>Risk at stop</small>
          <strong className={unprotected ? 'negative' : ''}>
            {unprotected ? `${unprotected} without SL` : <MoneyValue value={protectedRisk} currency={snapshot?.currency || account?.base_currency} fx={fx} />}
          </strong>
          <button onClick={load} disabled={!account || loading}>{loading ? 'Refreshing…' : '↻ Refresh'}</button>
        </div>
      </section>
      <section className="panel table-panel pending-orders-panel">
        <div className="table-heading"><div><h2>Pending orders <span className="count">{pendingOrders.length}</span></h2><p className="muted text-xs mt-2">Read-only orders waiting for their entry price. Click a row for details.</p></div><small className="muted">Auto-refreshes every 5 seconds</small></div>
        <div className="table-scroll"><table><thead><tr><th>Created / ticket</th><th>Symbol</th><th>Order</th><th>Lots</th><th>Entry</th><th>Current</th><th>Distance</th><th>Risk at SL</th></tr></thead><tbody>{pendingOrders.map((order) => <tr key={order.order_id} onClick={() => setSelectedOrder(order)}><td>{new Date(order.created_at).toLocaleString()}<small>#{order.order_id}</small></td><td className="font-semibold">{order.standard_symbol}<small>{order.symbol}</small></td><td><span className={order.side === 'BUY' ? 'buy' : 'sell'}>{order.type}</span></td><td>{order.lots}</td><td>{number(order.entry, 6)}</td><td>{number(order.current_price, 6)}</td><td>{number(order.distance_to_entry_points, 1)} pts</td><td className={!order.stop_loss ? 'negative' : ''}>{order.stop_loss ? <><MoneyValue value={order.risk_amount || 0} currency={snapshot?.currency} fx={fx} /><small>{number(order.risk_pct, 2)}% of balance</small></> : 'No stop loss'}</td></tr>)}</tbody></table>{!loading && account && !pendingOrders.length && <div className="empty-table">No pending orders on this MT5 account.</div>}</div>
      </section>
      <section className="panel table-panel">
        <div className="table-heading"><div><h2>Open positions</h2><p className="muted text-xs mt-2">Click any row for full position details.</p></div><small className="muted">Auto-refreshes every 5 seconds</small></div>
        <div className="table-scroll">
          <table><thead><tr><th>Opened / ticket</th><th>Symbol</th><th>Side</th><th>Lots</th><th>Entry</th><th>Current</th><th>Risk at SL</th><th>Spread</th><th>Floating P&amp;L</th></tr></thead>
            <tbody>{positions.map((p) => <tr key={p.position_id} onClick={() => setSelectedPosition(p)}>
              <td>{new Date(p.open_time).toLocaleString()}<small>#{p.position_id}</small></td>
              <td className="font-semibold">{p.standard_symbol}<small>{p.symbol}</small></td>
              <td><span className={p.type === 'BUY' ? 'buy' : 'sell'}>{p.type}</span></td><td>{p.lots}</td>
              <td>{number(p.entry, 6)}</td><td>{number(p.current_price, 6)}</td><td className={!p.stop_loss ? 'negative' : ''}>{p.stop_loss ? <><MoneyValue value={p.risk_amount || 0} currency={snapshot?.currency} fx={fx} /><small>{number(p.risk_pct, 2)}% of balance</small></> : 'No stop loss'}</td><td>{number(p.spread_points, 1)} pts</td>
              <td className={p.current_pnl < 0 ? 'negative' : 'positive'}><MoneyValue value={p.current_pnl} currency={snapshot?.currency} fx={fx} /></td>
            </tr>)}</tbody></table>
          {!loading && account && !positions.length && <div className="empty-table">No open positions on this MT5 account.</div>}
          {!account && <div className="empty-table">Select an account from the top bar to view its open positions.</div>}
        </div>
      </section>
      {selectedPosition && <Modal title={`${selectedPosition.standard_symbol} · position #${selectedPosition.position_id}`} onClose={() => setSelectedPosition(null)}>
        <dl className="review position-review">{Object.entries({
          'Side': selectedPosition.type, 'Opened': new Date(selectedPosition.open_time).toLocaleString(), 'Broker symbol': selectedPosition.symbol,
          'Volume': `${selectedPosition.lots} lots`, 'Entry price': number(selectedPosition.entry, 6), 'Current price': number(selectedPosition.current_price, 6),
          'Take profit': selectedPosition.take_profit ? number(selectedPosition.take_profit, 6) : 'Not set', 'Stop loss': selectedPosition.stop_loss ? number(selectedPosition.stop_loss, 6) : 'Not set',
          'Risk at stop': selectedPosition.stop_loss ? `${moneyPairText(selectedPosition.risk_amount || 0, snapshot?.currency, fx)} · ${number(selectedPosition.risk_pct, 2)}% of balance` : 'Unbounded — no stop loss',
          'Bid / Ask': `${number(selectedPosition.bid, 6)} / ${number(selectedPosition.ask, 6)}`, 'Current spread': `${number(selectedPosition.spread_points, 1)} points`,
          'Price movement': `${number(selectedPosition.points_pnl, 1)} points`, 'Floating P&L': moneyPairText(selectedPosition.current_pnl, snapshot?.currency, fx),
          'Swap': moneyPairText(selectedPosition.swap, snapshot?.currency, fx), 'Comment': selectedPosition.comment || '—',
        }).map(([key, value]) => <React.Fragment key={key}><dt>{key}</dt><dd>{value}</dd></React.Fragment>)}</dl>
      </Modal>}
      {selectedOrder && <Modal title={`${selectedOrder.type} · order #${selectedOrder.order_id}`} onClose={() => setSelectedOrder(null)}><dl className="review position-review">{Object.entries({
        'Status': 'Pending — read only', 'Created': new Date(selectedOrder.created_at).toLocaleString(), 'Broker symbol': selectedOrder.symbol,
        'Volume': `${selectedOrder.lots} lots`, 'Requested entry': number(selectedOrder.entry, 6), 'Current price': number(selectedOrder.current_price, 6),
        'Distance to entry': `${number(selectedOrder.distance_to_entry_points, 1)} points`, 'Take profit': selectedOrder.take_profit ? number(selectedOrder.take_profit, 6) : 'Not set',
        'Stop loss': selectedOrder.stop_loss ? number(selectedOrder.stop_loss, 6) : 'Not set', 'Risk at stop': selectedOrder.stop_loss ? `${moneyPairText(selectedOrder.risk_amount || 0, snapshot?.currency, fx)} · ${number(selectedOrder.risk_pct, 2)}% of balance` : 'Unbounded — no stop loss',
        'Expiration': selectedOrder.expiration ? new Date(selectedOrder.expiration).toLocaleString() : 'Good till cancelled', 'Comment': selectedOrder.comment || '—',
      }).map(([key, value]) => <React.Fragment key={key}><dt>{key}</dt><dd>{value}</dd></React.Fragment>)}</dl></Modal>}
    </>
  );
}

const principles = [
  'Never risk more than 1–2% of your account on any single trade.',
  'Never have more than 2–3 trades open simultaneously.',
  'After 3 consecutive losses, stop trading for the day.',
  'Review your performance weekly to detect drift from your system.',
];
function CorePrinciples() {
  return <section className="panel principles-panel"><div><div className="eyebrow">NON-NEGOTIABLES</div><h2>Core principles</h2></div><ul>{principles.map((principle) => <li key={principle}><span>◆</span>{principle}</li>)}</ul></section>;
}

function GrowthSummary({ accountId, broker, fx, onError }) {
  const [periods, setPeriods] = useState(null);
  useEffect(() => {
    let current = true;
    Promise.all(['daily', 'weekly', 'monthly'].map((granularity) => call('returns:read', { account: accountId, broker, granularity })))
      .then((values) => { if (current) setPeriods(Object.fromEntries(['daily', 'weekly', 'monthly'].map((key, index) => [key, values[index].periods.at(-1)]))); })
      .catch((error) => { if (current) onError(error); });
    return () => { current = false; };
  }, [accountId, broker]);
  return <section className="panel growth-summary"><div className="table-heading"><div><h2>Realized growth</h2><p className="muted text-xs mt-2">Trading P&amp;L relative to the capital available in each current period.</p></div></div><div className="growth-cards">{['daily', 'weekly', 'monthly'].map((key) => { const period = periods?.[key]; return <div className="growth-card" key={key}><small>{key === 'daily' ? 'Today' : key === 'weekly' ? 'This week' : 'This month'}</small><strong className={(period?.pnl || 0) < 0 ? 'negative' : 'positive'}>{period ? <MoneyValue value={period.pnl} currency="USD" fx={fx} /> : '—'}</strong><span className={(period?.return_pct || 0) < 0 ? 'negative' : 'positive'}>{period?.return_pct == null ? '—' : `${period.return_pct.toFixed(2)}%`}</span></div>; })}</div></section>;
}

function CashFlowPage({ flows, fx }) {
  const deposits = flows.filter((flow) => flow.amount > 0).reduce((sum, flow) => sum + flow.amount, 0);
  const withdrawals = flows.filter((flow) => flow.amount < 0).reduce((sum, flow) => sum + Math.abs(flow.amount), 0);
  const currency = flows[0]?.base_currency || 'USD';
  return <><div className="metrics cashflow-metrics"><section className="metric"><div className="metric-label">Deposits</div><strong className="positive"><MoneyValue value={deposits} currency={currency} fx={fx} /></strong><small>{flows.filter((flow) => flow.amount > 0).length} entries</small></section><section className="metric"><div className="metric-label">Withdrawals</div><strong className="negative"><MoneyValue value={withdrawals} currency={currency} fx={fx} /></strong><small>{flows.filter((flow) => flow.amount < 0).length} entries</small></section><section className="metric"><div className="metric-label">Net cash flow</div><strong><MoneyValue value={deposits - withdrawals} currency={currency} fx={fx} /></strong><small>Excluded from trading performance</small></section></div><section className="panel table-panel"><div className="table-heading"><div><h2>Deposits &amp; withdrawals <span className="count">{flows.length}</span></h2><p className="muted text-xs mt-2">Cash movements reported by MT5.</p></div></div><div className="table-scroll"><table><thead><tr><th>Date</th><th>Account</th><th>Type</th><th>Amount</th><th>Broker reference</th><th>Comment</th></tr></thead><tbody>{flows.map((flow) => <tr key={flow.id}><td>{new Date(flow.occurred_at).toLocaleString()}</td><td>{flow.display_name}<small>{flow.broker_name}</small></td><td><span className={`result ${flow.amount > 0 ? 'win' : 'loss'}`}>{flow.amount > 0 ? 'DEPOSIT' : 'WITHDRAWAL'}</span></td><td className={flow.amount > 0 ? 'positive' : 'negative'}><MoneyValue value={flow.amount} currency={flow.base_currency} fx={fx} /></td><td>#{flow.ticket_number}</td><td>{flow.comment || '—'}</td></tr>)}</tbody></table>{!flows.length && <div className="empty-table">No deposits or withdrawals in this selection.</div>}</div></section></>;
}

function ProjectionPage({ accounts, activeAccountId, fx }) {
  const [accountId, setAccountId] = useState(activeAccountId || accounts[0]?.id || '');
  const [direction, setDirection] = useState('growth');
  const [rate, setRate] = useState(5);
  const [months, setMonths] = useState(2);
  useEffect(() => { if (activeAccountId) setAccountId(activeAccountId); }, [activeAccountId]);
  const account = accounts.find((candidate) => candidate.id === Number(accountId));
  const start = Number(account?.current_balance || 0);
  const signedRate = Math.min(100, Math.max(0, Number(rate) || 0)) * (direction === 'loss' ? -1 : 1);
  const count = Math.min(120, Math.max(1, Number(months) || 1));
  const rows = Array.from({ length: count }, (_, index) => ({ month: index + 1, balance: start * ((1 + signedRate / 100) ** (index + 1)) }));
  const ending = rows.at(-1)?.balance || start;
  return <><section className="panel projection-controls"><div><div className="eyebrow">COMPOUNDING SCENARIO</div><h2>Account growth &amp; loss calculator</h2><p className="muted text-xs mt-2">A mathematical projection for planning. It does not predict trading results.</p></div><div className="projection-fields"><Field label="Account"><select value={accountId} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((item) => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></Field><Field label="Scenario"><select value={direction} onChange={(event) => setDirection(event.target.value)}><option value="growth">Growth</option><option value="loss">Loss</option></select></Field><Field label="Monthly percentage"><input type="number" min="0" max="100" step="0.1" value={rate} onChange={(event) => setRate(event.target.value)} /></Field><Field label="Months"><input type="number" min="1" max="120" value={months} onChange={(event) => setMonths(event.target.value)} /></Field></div></section><div className="metrics projection-metrics"><section className="metric"><div className="metric-label">Starting balance</div><strong><MoneyValue value={start} currency={account?.base_currency} fx={fx} /></strong><small>{account?.display_name || 'Select an account'}</small></section><section className="metric"><div className="metric-label">Projected balance</div><strong className={ending < start ? 'negative' : 'positive'}><MoneyValue value={ending} currency={account?.base_currency} fx={fx} /></strong><small>After {count} {count === 1 ? 'month' : 'months'}</small></section><section className="metric"><div className="metric-label">Projected change</div><strong className={ending < start ? 'negative' : 'positive'}><MoneyValue value={ending - start} currency={account?.base_currency} fx={fx} /></strong><small>{signedRate.toFixed(2)}% compounded monthly</small></section></div><section className="panel table-panel"><div className="table-heading"><h2>Month-by-month projection</h2></div><div className="table-scroll"><table><thead><tr><th>Month</th><th>Starting balance</th><th>{direction === 'growth' ? 'Growth' : 'Loss'}</th><th>Ending balance</th></tr></thead><tbody>{rows.map((row, index) => { const prior = index ? rows[index - 1].balance : start; return <tr key={row.month}><td>Month {row.month}</td><td><MoneyValue value={prior} currency={account?.base_currency} fx={fx} /></td><td className={row.balance < prior ? 'negative' : 'positive'}><MoneyValue value={row.balance - prior} currency={account?.base_currency} fx={fx} /></td><td><MoneyValue value={row.balance} currency={account?.base_currency} fx={fx} /></td></tr>; })}</tbody></table></div></section></>;
}

function CalculatorsPage({ accounts, activeAccountId, fx }) {
  const [accountId, setAccountId] = useState(activeAccountId || accounts[0]?.id || '');
  const [amount, setAmount] = useState(20);
  useEffect(() => { if (activeAccountId) setAccountId(activeAccountId); }, [activeAccountId]);
  const account = accounts.find((candidate) => candidate.id === Number(accountId));
  const capital = Number(account?.current_balance || 0);
  const value = Math.max(0, Number(amount) || 0);
  const percentage = capital > 0 ? value / capital * 100 : null;
  return <div className="calculators-layout"><section className="panel calculator-card"><div><div className="eyebrow">CAPITAL CALCULATOR</div><h2>Dollar amount as a percentage</h2><p className="muted mt-2">Find out how much a dollar amount represents relative to the selected account’s current capital.</p></div><div className="calculator-fields"><Field label="Account"><select value={accountId} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((item) => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></Field><Field label="Dollar amount"><input type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} /></Field></div><div className="calculator-result"><small>{money(value, account?.base_currency)} is</small><strong>{percentage == null ? '—' : `${percentage.toFixed(2)}%`}</strong><span>of <MoneyValue value={capital} currency={account?.base_currency} fx={fx} /> current capital</span></div><div className="calculator-reference">{[1, 2, 5, 10].map((rate) => <div key={rate}><small>{rate}% of capital</small><b><MoneyValue value={capital * rate / 100} currency={account?.base_currency} fx={fx} /></b></div>)}</div></section><section className="panel future-calculators"><h2>More calculators</h2><p className="muted mt-2">Additional trading and risk calculations can be added here later.</p></section></div>;
}

function RiskAnalysisPage({ accounts, activeAccountId, fx, onError }) {
  const [accountId, setAccountId] = useState(activeAccountId || accounts[0]?.id || '');
  const [capital, setCapital] = useState('');
  const [customEntry, setCustomEntry] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const account = accounts.find((candidate) => candidate.id === Number(accountId));
  useEffect(() => { if (activeAccountId) setAccountId(activeAccountId); }, [activeAccountId]);
  useEffect(() => { setCapital(String(account?.current_balance ?? 0)); setResult(null); }, [account?.id]);
  return <div className="risk-analysis-page">
    <section className="panel signal-form-panel"><div><div className="eyebrow">PRE-TRADE CHECK</div><h2>Risk analysis</h2><p className="muted mt-2">Compare both ends of an entry zone and an optional custom entry. Results use 0.01 lot, the broker’s current spread, MT5 profit calculations, and your selected capital. Nothing is saved.</p></div>
      <form className="signal-form" onSubmit={async (event) => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); try { setLoading(true); setResult(await call('signals:risk', { account_id: Number(accountId), setup_text: values.setup, capital: Number(capital), ...(customEntry === '' ? {} : { custom_entry: Number(customEntry) }) })); } catch (error) { onError(error); } finally { setLoading(false); } }}>
        <div className="risk-fields"><Field label="Broker account"><select value={accountId} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((item) => <option key={item.id} value={item.id}>{item.display_name} · {item.broker_name}</option>)}</select></Field><Field label="Account capital"><input type="number" min="0.01" step="0.01" value={capital} onChange={(event) => setCapital(event.target.value)} required /></Field><Field label="Custom entry inside zone"><input type="number" min="0" step="0.01" value={customEntry} onChange={(event) => setCustomEntry(event.target.value)} placeholder="Optional" /></Field><Field label="Lot size"><input value="0.01" disabled /></Field></div>
        <Field label="Trade setup text"><textarea name="setup" rows="8" required placeholder={'BUY XAUUSD ZONE : 4173 - 4176\nSL: 4168\nTP: 4188 - 4195'} /></Field>
        <button className="primary" disabled={loading || !account}>{loading ? 'Calculating with MT5…' : 'Calculate risk'}</button>
      </form>
    </section>
    {result && <section className="panel risk-results"><div className={`risk-verdict ${result.within_limit ? 'safe' : 'blocked'}`}><div><div className="eyebrow">2% RISK RULE</div><h2>{result.within_limit ? 'Within your risk limit' : 'Do not take this trade'}</h2></div><strong>{number(Math.max(...result.entries.map((entry) => entry.loss_pct)), 2)}% worst-case risk</strong></div>
      <div className="table-heading"><div><h2>{result.parsed.side} {result.parsed.standard_symbol}</h2><p className="muted text-xs mt-2">Zone {number(result.parsed.zone_low, 6)}–{number(result.parsed.zone_high, 6)} · SL {number(result.parsed.stop_loss, 6)} · TP1 {number(result.parsed.take_profit, 6)}</p></div><span className="count">0.01 lot</span></div>
      <div className="table-scroll"><table><thead><tr><th>Entry option</th><th>Broker-adjusted entry</th><th>Loss at SL</th><th>Risk %</th><th>Profit at TP1</th><th>Profit %</th><th>Risk : reward</th></tr></thead><tbody>{result.entries.map((entry) => <tr key={entry.label} className={entry.highest_risk ? 'highest-risk-row' : ''}><td><b>{entry.label}</b><small>{number(entry.signal_entry, 6)}{entry.highest_risk ? ' · highest SL distance' : ''}</small></td><td>{number(entry.execution_entry, 6)}</td><td className="negative"><MoneyValue value={entry.loss_pnl} currency={result.currency} fx={fx} /></td><td className={entry.loss_pct > 2 ? 'negative' : 'positive'}>{number(entry.loss_pct, 2)}%</td><td className={entry.profit_pnl < 0 ? 'negative' : 'positive'}><MoneyValue value={entry.profit_pnl} currency={result.currency} fx={fx} /></td><td className={entry.profit_pct < 0 ? 'negative' : 'positive'}>{number(entry.profit_pct, 2)}%</td><td>1 : {number(entry.risk_reward, 2)}</td></tr>)}</tbody></table></div>
      <div className="signal-method"><span>Current spread: {number(result.spread_points, 1)} points</span><span>{result.fee_sample_size ? `Fees estimated from ${result.fee_sample_size} completed trades` : 'No comparable commission history'}</span><span>Results are calculations only and are not saved</span></div>
    </section>}
  </div>;
}

function SignalAnalysisPage({ accounts, activeAccountId, analyses, fx, onRefresh, onError, onToast }) {
  const [accountId, setAccountId] = useState(activeAccountId || accounts[0]?.id || '');
  const [date, setDate] = useState(localDateKey());
  const [startingBalance, setStartingBalance] = useState('');
  const [latest, setLatest] = useState(null);
  const [historyDate, setHistoryDate] = useState('all');
  const [loading, setLoading] = useState(false);
  const account = accounts.find((candidate) => candidate.id === Number(accountId));
  useEffect(() => { if (activeAccountId) setAccountId(activeAccountId); }, [activeAccountId]);
  useEffect(() => { setStartingBalance(String(account?.current_balance ?? 0)); setLatest(null); setHistoryDate('all'); }, [account?.id]);
  const saved = analyses.filter((item) => item.account_id === Number(accountId));
  const availableDates = [...new Set(saved.map((item) => item.signal_date))].sort().reverse();
  const savedHistory = latest
    ? saved.filter((item) => item.signal_date !== latest.signal_date || item.setup_number !== latest.setup_number)
    : saved;
  const filteredHistory = savedHistory.filter((item) => historyDate === 'all' || item.signal_date === historyDate);
  const dailySummaries = Object.values(saved.reduce((days, item) => {
    const day = days[item.signal_date] ||= { date: item.signal_date, setups: 0, trades: 0, pnl: 0 };
    day.setups += 1;
    day.trades += item.result?.trades?.length || 0;
    day.pnl += Number(item.result?.total_pnl || 0);
    return days;
  }, {})).sort((a, b) => b.date.localeCompare(a.date));
  const visibleDays = dailySummaries.filter((day) => historyDate === 'all' || day.date === historyDate);
  const filteredTotals = visibleDays.reduce((total, day) => ({ days: total.days + 1, setups: total.setups + day.setups, trades: total.trades + day.trades, pnl: total.pnl + day.pnl }), { days: 0, setups: 0, trades: 0, pnl: 0 });
  const deleteAnalysis = async (item) => {
    if (!window.confirm(`Delete Setup #${item.setup_number || item.result?.parsed?.setup_number} for ${item.signal_date}?`)) return;
    try {
      await call('signals:delete', item.id);
      if (latest?.id === item.id) setLatest(null);
      await onRefresh();
      onToast('Signal analysis deleted.');
    } catch (error) { onError(error); }
  };
  const renderAnalysis = (item, key) => {
    const result = item.result || item;
    const currency = item.base_currency || account?.base_currency || result.currency || 'USD';
    return <section className="panel signal-result" key={key}>
      <div className="table-heading"><div><div className="eyebrow">{item.signal_date || date} · SETUP #{item.setup_number || result.parsed?.setup_number}</div><h2>{item.side || result.parsed?.side} {item.standard_symbol || result.parsed?.standard_symbol}</h2><p className="muted text-xs mt-2">Zone {number(item.zone_low ?? result.parsed?.zone_low, 6)}–{number(item.zone_high ?? result.parsed?.zone_high, 6)} · SL {number(item.stop_loss ?? result.parsed?.stop_loss, 6)} · TP1 {number(item.take_profit ?? result.parsed?.take_profit, 6)} · 0.01 lot per entry</p></div>{item.id && <button className="danger" onClick={() => deleteAnalysis(item)}>Delete signal</button>}</div>
      <div className="signal-totals"><div><small>Total estimated P&amp;L</small><strong className={result.total_pnl < 0 ? 'negative' : 'positive'}><MoneyValue value={result.total_pnl} currency={currency} fx={fx} /></strong></div><div><small>Starting balance</small><strong><MoneyValue value={item.starting_balance ?? Number(startingBalance)} currency={currency} fx={fx} /></strong></div><div><small>Approximate balance</small><strong className={result.projected_balance < (item.starting_balance ?? Number(startingBalance)) ? 'negative' : 'positive'}><MoneyValue value={result.projected_balance} currency={currency} fx={fx} /></strong></div></div>
      {result.trades?.length ? <div className="table-scroll"><table><thead><tr><th>Trade</th><th>Entry</th><th>Exit</th><th>Outcome</th><th>Gross</th><th>Est. fees</th><th>Net P&amp;L</th></tr></thead><tbody>{result.trades.map((trade, index) => <tr key={`${trade.entry}-${index}`}><td>Entry {index + 1}<small>{trade.source?.startsWith('selected') ? 'Selected result + broker pricing' : trade.source?.startsWith('confirmed') ? 'Copied update + broker spread' : 'Broker tick replay'}</small></td><td>{number(trade.entry, 6)}{trade.signal_entry != null && <small>Signal {number(trade.signal_entry, 6)}</small>}{trade.reported_pips != null && <small>{number(trade.reported_pips, 1)} reported pips</small>}</td><td>{number(trade.exit, 6)}</td><td><span className={`result ${trade.net_pnl < 0 ? 'loss' : trade.status === 'OPEN_AT_DAY_END' ? 'be' : 'win'}`}>{trade.status}</span></td><td className={trade.gross_pnl < 0 ? 'negative' : 'positive'}>{money(trade.gross_pnl, currency)}</td><td>{money(trade.estimated_fees, currency)}</td><td className={trade.net_pnl < 0 ? 'negative' : 'positive'}><MoneyValue value={trade.net_pnl} currency={currency} fx={fx} /></td></tr>)}</tbody></table></div> : <div className="empty-table">The entry zone was not reached in the broker’s available tick history for this date.</div>}
      <div className="signal-method"><span>{number(result.tick_count, 0)} broker ticks checked</span><span>Median spread: {number(result.spread_points, 1)} points</span><span>{result.fee_sample_size ? `Fees estimated from ${result.fee_sample_size} completed ${result.symbol} trades` : 'No comparable fee history; commission estimate is $0.00'}</span></div>
    </section>;
  };
  return <div className="signal-page">
    <section className="panel signal-form-panel"><div><div className="eyebrow">TP1 / SL SIGNAL REPLAY</div><h2>Analyze a trade signal</h2><p className="muted mt-2">Paste one setup and choose whether TP1 or SL was hit. Meridian accepts your selected result and uses the broker’s historical pricing to calculate it.</p></div>
      <form onSubmit={async (event) => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); try { setLoading(true); const result = await call('signals:analyze', { account_id: Number(accountId), signal_date: date, setup_text: values.setup, outcome: values.outcome, starting_balance: Number(startingBalance) }); setLatest({ ...result, signal_date: date, setup_number: result.parsed.setup_number, starting_balance: Number(startingBalance), side: result.parsed.side, standard_symbol: result.parsed.standard_symbol, zone_low: result.parsed.zone_low, zone_high: result.parsed.zone_high, stop_loss: result.parsed.stop_loss, take_profit: result.parsed.take_profit, base_currency: account?.base_currency }); setHistoryDate(date); await onRefresh(); onToast(`Setup #${result.parsed.setup_number} analyzed and saved.`); } catch (error) { onError(error); } finally { setLoading(false); } }} className="signal-form">
        <div className="signal-fields"><Field label="Broker account"><select value={accountId} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((item) => <option key={item.id} value={item.id}>{item.display_name} · {item.broker_name}</option>)}</select></Field><Field label="Signal date"><input type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></Field><Field label="Starting account balance"><input type="number" min="0" step="0.01" value={startingBalance} onChange={(event) => setStartingBalance(event.target.value)} required /></Field><Field label="Lot size"><input value="0.01" disabled /></Field></div>
        <Field label="Trade setup text"><textarea name="setup" rows="8" required placeholder={'TRADE SETUP #4 – October 8, 2026\n\nSELL XAUUSD ZONE : 4140 - 4143\nSL: 4148\nTP: 4135 - 4130 - 4020'} /></Field>
        <Field label="What was hit first?"><select name="outcome" defaultValue="TP1"><option value="TP1">TP1 hit</option><option value="SL">Stop loss hit</option></select></Field>
        <button className="primary" disabled={loading || !account}>{loading ? 'Checking broker history…' : 'Analyze and save signal'}</button>
      </form>
      <p className="notice">The header date must match the selected date. BUY signals require SL below the zone and TP1 above it; SELL signals require the opposite. Duplicate setup numbers and repeated signals are rejected.</p>
    </section>
    <section className="panel signal-daily-summary"><div className="table-heading"><div><div className="eyebrow">DAILY RESULTS</div><h2>Profit and loss by date</h2><p className="muted text-xs mt-2">Choose a date to narrow both this summary and the individual trade results below.</p></div><Field label="Date filter"><select value={historyDate} onChange={(event) => { setHistoryDate(event.target.value); setLatest(null); }}><option value="all">All dates</option>{availableDates.map((item) => <option key={item} value={item}>{new Date(`${item}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}</option>)}</select></Field></div>
      <div className="signal-filter-totals"><div><small>Days</small><strong>{filteredTotals.days}</strong></div><div><small>Setups</small><strong>{filteredTotals.setups}</strong></div><div><small>Trades</small><strong>{filteredTotals.trades}</strong></div><div><small>Net P&amp;L</small><strong className={filteredTotals.pnl < 0 ? 'negative' : 'positive'}><MoneyValue value={filteredTotals.pnl} currency={account?.base_currency} fx={fx} /></strong></div></div>
      <div className="table-scroll"><table><thead><tr><th>Date</th><th>Signal setups</th><th>Individual trades</th><th>Daily profit / loss</th></tr></thead><tbody>{visibleDays.map((day) => <tr key={day.date}><td><button className="date-link" onClick={() => { setHistoryDate(day.date); setLatest(null); }}>{new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}</button></td><td>{day.setups}</td><td>{day.trades}</td><td className={day.pnl < 0 ? 'negative' : 'positive'}><MoneyValue value={day.pnl} currency={account?.base_currency} fx={fx} /></td></tr>)}</tbody></table>{!visibleDays.length && <div className="empty-table">No saved signal results for this date.</div>}</div>
    </section>
    {latest && (historyDate === 'all' || latest.signal_date === historyDate) && renderAnalysis(latest, 'latest')}
    <div className="signal-history"><div className="table-heading"><div><h2>{historyDate === 'all' ? 'Saved signal analyses' : `Trades for ${new Date(`${historyDate}T12:00:00`).toLocaleDateString()}`}</h2><p className="muted text-xs mt-2">Each setup shows the profit or loss for every 0.01-lot entry.</p></div><span className="count">{filteredHistory.length + (latest && (historyDate === 'all' || latest.signal_date === historyDate) ? 1 : 0)}</span></div>{filteredHistory.map((item) => renderAnalysis(item, item.id))}{!filteredHistory.length && !latest && <div className="empty-table">No signal analyses saved for this date.</div>}</div>
  </div>;
}

function PriceChart({ candles, markers }) {
  const container = useRef(null);
  useEffect(() => {
    if (!container.current || !candles.length) return;
    const chart = createChart(container.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#0b1119' }, textColor: '#8795a8', attributionLogo: true },
      grid: { vertLines: { color: '#17212d' }, horzLines: { color: '#17212d' } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#566679' }, horzLine: { color: '#566679' } },
      rightPriceScale: { borderColor: '#283443' }, timeScale: { borderColor: '#283443', timeVisible: true, secondsVisible: false },
    });
    const series = chart.addSeries(CandlestickSeries, { upColor: '#57d6ad', downColor: '#ef6b81', borderVisible: false, wickUpColor: '#57d6ad', wickDownColor: '#ef6b81' });
    series.setData(candles);
    createSeriesMarkers(series, markers.map(({ detail, ...marker }) => marker));
    const markerMap = new Map(markers.map((marker) => [String(marker.time), marker]));
    const tooltip = document.createElement('div');
    tooltip.className = 'trade-tooltip';
    container.current.appendChild(tooltip);
    const move = (param) => {
      const marker = param.time ? markerMap.get(String(param.time)) : null;
      if (!marker || !param.point) { tooltip.style.display = 'none'; return; }
      tooltip.style.display = 'block';
      tooltip.replaceChildren();
      for (const [tag, value, className] of [
        ['b', marker.detail.title, ''], ['span', marker.detail.time, ''],
        ['span', marker.detail.price, ''], ['span', marker.detail.lots, ''],
        ['strong', marker.detail.pnl, marker.detail.negative ? 'negative' : 'positive'],
      ]) {
        const line = document.createElement(tag);
        line.textContent = value;
        if (className) line.className = className;
        tooltip.appendChild(line);
      }
      tooltip.style.left = `${Math.min(param.point.x + 14, container.current.clientWidth - 225)}px`;
      tooltip.style.top = `${Math.max(12, param.point.y - 72)}px`;
    };
    chart.subscribeCrosshairMove(move);
    chart.timeScale().fitContent();
    return () => { chart.unsubscribeCrosshairMove(move); chart.remove(); };
  }, [candles, markers]);
  return <div className="price-chart" ref={container} />;
}

function ReturnsView({ accountId, broker, accounts, scopeValue, onScopeChange, fx, onError }) {
  const [granularity, setGranularity] = useState('daily');
  const [result, setResult] = useState({ periods: [], currency: 'USD', mixed: false });
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let current = true;
    (async () => {
      try {
        setLoading(true);
        const value = await call('returns:read', { account: accountId, broker, granularity });
        if (current) setResult(value);
      } catch (error) { if (current) onError(error); }
      finally { if (current) setLoading(false); }
    })();
    return () => { current = false; };
  }, [accountId, broker, granularity]);
  const periods = result.periods || [];
  const recent = periods.slice(-30);
  const max = Math.max(1, ...recent.map((period) => Math.abs(period.return_pct || 0)));
  const latest = periods.at(-1);
  const valid = periods.filter((period) => period.return_pct != null);
  const average = valid.length ? valid.reduce((sum, period) => sum + period.return_pct, 0) / valid.length : null;
  const label = (key) => granularity === 'weekly' ? `Week of ${new Date(`${key}T12:00:00Z`).toLocaleDateString()}` : granularity === 'monthly' ? new Date(`${key}-01T12:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : granularity === 'yearly' ? key : new Date(`${key}T12:00:00Z`).toLocaleDateString();
  return <>
    <section className="panel returns-controls">
      <div><h2>Return on capital</h2><p className="muted text-xs mt-2">Each percentage uses the capital available at the beginning of that period.</p></div>
      <div className="flex gap-3">
        <select value={scopeValue} onChange={(event) => onScopeChange(event.target.value)} aria-label="Returns account scope"><option value="active">Active MT5 account</option><option value="all">All accounts</option>{accounts.map((account) => <option key={account.id} value={String(account.id)}>{account.display_name}</option>)}</select>
        <select value={granularity} onChange={(event) => setGranularity(event.target.value)} aria-label="Return period"><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select>
      </div>
    </section>
    {result.mixed ? <p className="notice mt-4">Select accounts with the same base currency. Meridian does not combine percentage returns across currencies.</p> : <>
      <div className="metrics returns-metrics">
        <section className="metric"><div className="metric-label">Latest period</div><strong className={(latest?.return_pct || 0) < 0 ? 'negative' : 'positive'}>{latest?.return_pct == null ? '—' : `${latest.return_pct.toFixed(2)}%`}</strong><small>{latest ? label(latest.key) : 'No closed trades'}</small></section>
        <section className="metric"><div className="metric-label">Average period</div><strong className={(average || 0) < 0 ? 'negative' : 'positive'}>{average == null ? '—' : `${average.toFixed(2)}%`}</strong><small>{valid.length} measured periods</small></section>
        <section className="metric"><div className="metric-label">Current capital</div><strong><MoneyValue value={result.current_capital ?? 0} currency={result.currency} fx={fx} /></strong><small>Latest balance reported by MT5</small></section>
      </div>
      <section className="panel returns-chart-panel"><h2>{granularity[0].toUpperCase() + granularity.slice(1)} returns</h2><div className="returns-bars">{recent.map((period) => <div className="return-bar-column" key={period.key} title={`${label(period.key)}: ${period.return_pct?.toFixed(2) ?? '—'}%`}><span>{period.return_pct == null ? '—' : `${period.return_pct.toFixed(1)}%`}</span><div className="return-bar-track"><i className={period.return_pct < 0 ? 'negative-bar' : 'positive-bar'} style={{ height: `${Math.max(3, Math.abs(period.return_pct || 0) / max * 100)}%` }} /></div><small>{period.key}</small></div>)}</div>{!periods.length && <div className="empty-table">{loading ? 'Calculating returns…' : 'No closed trades are available for this account selection.'}</div>}</section>
      <section className="panel table-panel"><div className="table-heading"><div><h2>Period breakdown <span className="count">{periods.length}</span></h2><p className="muted text-xs mt-2">Capital used includes cash added during the period. Deposits and withdrawals never count as trading profit.</p></div></div><div className="table-scroll"><table><thead><tr><th>Period</th><th>Capital used</th><th>Realized P&amp;L / return</th><th>Deposits / withdrawals</th><th>Closing capital</th><th>Trades</th></tr></thead><tbody>{[...periods].reverse().slice(0, 500).map((period) => <tr key={period.key}><td>{label(period.key)}</td><td><MoneyValue value={period.capital_basis} currency={result.currency} fx={fx} /></td><td className={period.pnl < 0 ? 'negative' : 'positive'}><MoneyValue value={period.pnl} currency={result.currency} fx={fx} /> <small>({period.return_pct == null ? '—' : `${period.return_pct.toFixed(2)}%`})</small></td><td><MoneyValue value={period.capital_flow} currency={result.currency} fx={fx} /></td><td><MoneyValue value={period.closing_capital} currency={result.currency} fx={fx} /></td><td>{period.trade_count}</td></tr>)}</tbody></table></div></section>
    </>}
  </>;
}

function TradeChart({ account, mappings, onError, fx }) {
  const accountAssets = [...new Set(mappings.filter((m) => !account || m.broker_name === account.broker_name).map((m) => m.standard_symbol))];
  const [asset, setAsset] = useState('XAUUSD');
  const [timeframe, setTimeframe] = useState('M15');
  const [range, setRange] = useState('7');
  const [chartData, setChartData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showTrades, setShowTrades] = useState(true);
  const [replay, setReplay] = useState(false);
  const [replayIndex, setReplayIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState('1');
  useEffect(() => { if (accountAssets.length && !accountAssets.includes(asset)) setAsset(accountAssets[0]); }, [account?.id, mappings.length]);
  useEffect(() => {
    if (!account || !asset) return;
    let current = true;
    (async () => {
      setLoading(true);
      try {
        const dateTo = new Date();
        const dateFrom = range === 'all' ? new Date('2000-01-01T00:00:00.000Z') : new Date(dateTo.getTime() - Number(range) * 86400000);
        const result = await call('mt5:chart', { account_id: account.id, asset, timeframe, date_from: dateFrom.toISOString(), date_to: dateTo.toISOString() });
        if (current) { setChartData(result); setReplay(false); setPlaying(false); setReplayIndex(0); }
      } catch (error) { if (current) onError(error); } finally { if (current) setLoading(false); }
    })();
    return () => { current = false; };
  }, [account?.id, asset, timeframe, range]);
  const candles = chartData?.candles || [];
  useEffect(() => {
    if (!replay || !playing || !candles.length) return;
    const timer = setInterval(() => setReplayIndex((index) => {
      if (index >= candles.length) { setPlaying(false); return candles.length; }
      return index + 1;
    }), { '0.5': 1400, '1': 750, '2': 375, '5': 150 }[replaySpeed]);
    return () => clearInterval(timer);
  }, [replay, playing, replaySpeed, candles.length]);
  const interval = { M1: 60, M5: 300, M15: 900, H1: 3600, H4: 14400, D1: 86400 }[timeframe];
  const times = new Set(candles.map((c) => c.time));
  const snap = (iso) => { const raw = Math.floor(new Date(iso).getTime() / 1000 / interval) * interval; if (times.has(raw)) return raw; return candles.reduce((best, c) => Math.abs(c.time - raw) < Math.abs(best - raw) ? c.time : best, candles[0]?.time || raw); };
  const visibleTrades = (chartData?.trades || []).filter((t) => candles.length && new Date(t.open_time).getTime() / 1000 >= candles[0].time && new Date(t.close_time).getTime() / 1000 <= candles.at(-1).time);
  const markers = visibleTrades.flatMap((t) => [
    { time: snap(t.open_time), position: t.type === 'BUY' ? 'belowBar' : 'aboveBar', color: t.type === 'BUY' ? '#57d6ad' : '#ef6b81', shape: t.type === 'BUY' ? 'arrowUp' : 'arrowDown', text: `${t.type} ${t.lot_size}`, detail: { title: `${t.type} entry · #${t.ticket_number}`, time: new Date(t.open_time).toLocaleString(), price: `Entry ${number(t.open_price, 6)}`, lots: `${t.lot_size} lots`, pnl: moneyPairText(t.net_pnl, t.base_currency, fx), negative: t.net_pnl < 0 } },
    { time: snap(t.close_time), position: t.type === 'BUY' ? 'aboveBar' : 'belowBar', color: t.net_pnl < 0 ? '#ef6b81' : '#57d6ad', shape: 'circle', text: 'Exit', detail: { title: `Exit · #${t.ticket_number}`, time: new Date(t.close_time).toLocaleString(), price: `Exit ${number(t.close_price, 6)}`, lots: `${t.lot_size} lots`, pnl: moneyPairText(t.net_pnl, t.base_currency, fx), negative: t.net_pnl < 0 } },
  ]).sort((a, b) => a.time - b.time);
  const displayedCandles = replay ? candles.slice(0, Math.max(1, replayIndex)) : candles;
  const lastDisplayedTime = displayedCandles.at(-1)?.time || 0;
  const displayedMarkers = showTrades ? markers.filter((marker) => marker.time <= lastDisplayedTime) : [];
  const startReplay = () => {
    const start = Math.min(candles.length, Math.max(20, Math.floor(candles.length * 0.15)));
    setReplayIndex(start); setReplay(true); setPlaying(false);
  };
  return <section className="panel market-chart-panel">
    <div className="chart-toolbar"><div><h2>{asset || 'Trade'} chart</h2><p className="muted text-xs mt-2">Live broker candles with journal entry and exit markers.</p></div><div className="flex gap-3">
      <select value={asset} onChange={(e) => setAsset(e.target.value)} aria-label="Chart asset">{accountAssets.map((name) => <option key={name}>{name}</option>)}</select>
      <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)} aria-label="Chart timeframe">{['M1','M5','M15','H1','H4','D1'].map((name) => <option key={name}>{name}</option>)}</select>
      <select value={range} onChange={(e) => { setRange(e.target.value); if (e.target.value === 'all') setTimeframe('D1'); }} aria-label="Chart range"><option value="1">1 day</option><option value="7">1 week</option><option value="30">1 month</option><option value="90">3 months</option><option value="365">1 year</option><option value="all">All history</option></select>
    </div></div>
    {candles.length > 0 && <div className="chart-actions">
      <button className={showTrades ? 'chart-action active' : 'chart-action'} onClick={() => setShowTrades((shown) => !shown)}>{showTrades ? '◉ Trades shown' : '○ Trades hidden'}</button>
      {!replay ? <button className="chart-action" onClick={startReplay}>▶ Start replay</button> : <>
        <button className="chart-action active" onClick={() => setPlaying((value) => !value)}>{playing ? 'Ⅱ Pause' : '▶ Play'}</button>
        <button className="chart-action" onClick={() => setReplayIndex((index) => Math.min(candles.length, index + 1))}>Step +1</button>
        <select value={replaySpeed} onChange={(e) => setReplaySpeed(e.target.value)} aria-label="Replay speed"><option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option><option value="5">5×</option></select>
        <button className="chart-action" onClick={() => { setReplay(false); setPlaying(false); }}>Exit replay</button>
      </>}
    </div>}
    {replay && candles.length > 0 && <div className="replay-timeline"><input type="range" min="1" max={candles.length} value={Math.max(1, replayIndex)} onChange={(e) => { setReplayIndex(Number(e.target.value)); setPlaying(false); }} aria-label="Replay position" /><span>{replayIndex} / {candles.length} candles · {new Date((displayedCandles.at(-1)?.time || 0) * 1000).toLocaleString()}</span></div>}
    {!account ? <div className="empty-chart"><h3>Select an account to open its chart.</h3></div> : loading && !candles.length ? <div className="empty-chart"><h3>Loading candles from MT5…</h3></div> : candles.length ? <><PriceChart candles={displayedCandles} markers={displayedMarkers} /><div className="chart-footer"><span>{showTrades ? <><i className="legend-dot entry" /> Entry <i className="legend-dot exit" /> Exit</> : 'Trade markers are hidden'}</span><span>{replay ? 'Replay mode · future candles hidden' : `${visibleTrades.length} completed trades in view · Hover a marker for details`}</span></div></> : <div className="empty-chart"><h3>No candle data in this period.</h3><p>Try a wider range or timeframe.</p></div>}
    <p className="chart-attribution">Charts by TradingView Lightweight Charts™</p>
  </section>;
}
function localDateKey(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}
function DailyJournal({ account, entries, trades, fx, onSave }) {
  const [date, setDate] = useState(localDateKey());
  const entry = entries.find((item) => item.account_id === account?.id && item.entry_date === date);
  const dayTrades = trades.filter((trade) => trade.account_id === account?.id && localDateKey(new Date(trade.close_time)) === date);
  const dayPnl = dayTrades.reduce((sum, trade) => sum + trade.net_pnl, 0);
  return <div className="daily-grid">
    <section className="panel daily-editor">
      <div className="table-heading"><div><h2>Daily reflection</h2><p className="muted text-xs mt-2">Capture the market context and the decisions behind the result.</p></div><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
      <div className="day-result"><span>{dayTrades.length} closed trades</span><strong className={dayPnl < 0 ? 'negative' : 'positive'}><MoneyValue value={dayPnl} currency={account?.base_currency} fx={fx} /></strong></div>
      {!account ? <div className="empty-table">Select an account before writing a daily entry.</div> : <form key={`${date}-${entry?.updated_at || 'new'}`} onSubmit={(event) => {
        event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget));
        onSave({ account_id: account.id, entry_date: date, session: values.session, mood: values.mood, behavior_tags: values.behaviors.split(',').map((tag) => tag.trim()).filter(Boolean), market_context: values.context, reflection: values.reflection, next_session_rule: values.rule });
      }} className="daily-form">
        <div className="form-grid"><Field label="Trading session"><select name="session" defaultValue={entry?.session || 'Asia'}><option>Asia</option><option>London</option><option>New York</option><option>Multiple sessions</option><option>Did not trade</option></select></Field>
        <Field label="Emotional state"><select name="mood" defaultValue={entry?.mood || 'Frustrated'}><option>Calm</option><option>Focused</option><option>Confident</option><option>Anxious</option><option>Frustrated</option><option>Angry</option><option>Fatigued</option><option>Overconfident</option></select></Field></div>
        <Field label="Behavior tags (comma separated)" name="behaviors" defaultValue={entry ? JSON.parse(entry.behavior_tags).join(', ') : ''} placeholder="Rushed entry, Revenge trading, FOMO" />
        <Field label="Market context"><textarea name="context" rows="3" defaultValue={entry?.market_context || ''} placeholder="Holiday conditions, session liquidity, major news…" /></Field>
        <Field label="What happened and why?"><textarea name="reflection" rows="5" defaultValue={entry?.reflection || ''} placeholder="Describe the sequence of decisions without judging yourself." /></Field>
        <Field label="Rule for the next session"><textarea name="rule" rows="3" defaultValue={entry?.next_session_rule || ''} placeholder="A specific action you can follow before the next trade." /></Field>
        <button className="primary">Save daily reflection</button>
      </form>}
    </section>
    <section className="panel daily-history"><h2>Recent entries</h2><p className="muted text-xs mt-2">Select a day to review or update it.</p>
      <div className="daily-list">{entries.filter((item) => item.account_id === account?.id).map((item) => <button key={item.id} className={item.entry_date === date ? 'daily-card selected' : 'daily-card'} onClick={() => setDate(item.entry_date)}><span><b>{new Date(`${item.entry_date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</b><small>{item.session} · {item.mood}</small></span><span className="tag-count">{JSON.parse(item.behavior_tags).length} tags</span></button>)}</div>
      {!entries.some((item) => item.account_id === account?.id) && <div className="empty-table">Your saved daily reflections will appear here.</div>}
    </section>
  </div>;
}

function App() {
  const [data, setData] = useState({
      accounts: [],
      trades: [],
      metrics: {},
      mappings: [],
      logs: [],
      dailyEntries: [],
      priceAlerts: [],
      alertMode: 'tone',
      cashFlows: [],
      signalAnalyses: [],
    }),
    [filters, setFilters] = useState({}),
    [accountScope, setAccountScope] = useState('active'),
    [datePreset, setDatePreset] = useState('all'),
    [tab, setTab] = useState('Overview'),
    [settings, setSettings] = useState(false),
    [error, setError] = useState(''),
    [toast, setToast] = useState(''),
    [diagnostic, setDiagnostic] = useState(null),
    [search, setSearch] = useState(''),
    [sort, setSort] = useState({ key: 'close_time', asc: false }),
    [selected, setSelected] = useState(null),
    [report, setReport] = useState(null);
  const [fx, setFx] = useState(null);
  async function refresh() {
    setData(await call('journal:read', filters));
  }
  function fail(e) {
    setError(e.message);
    if (
      e.diagnostic &&
      ['10014', '10017', '10026', '10027', 'BRIDGE_TIMEOUT', 'ERR_TRADE_SEND_FAILED'].includes(
        e.diagnostic.code,
      )
    )
      setDiagnostic(e.diagnostic);
  }
  async function task(fn) {
    setError('');
    try {
      await fn();
    } catch (e) {
      fail(e);
    }
  }
  useEffect(() => {
    task(refresh);
  }, [filters]);
  useEffect(() => window.journal?.onStatus((status) => setData((d) => ({ ...d, status }))), []);
  useEffect(() => window.journal?.onPriceAlert((alert) => {
    if (data.alertMode === 'voice') speakAlert(alert.message); else playSoftTone();
    setToast(alert.message);
    void refresh();
  }), [data.alertMode]);
  useEffect(() => window.journal?.onJournalChanged((change) => {
    if (accountScope === 'active') setFilters((current) => ({ ...current, account: change.account_id, broker: undefined }));
    else void task(refresh);
  }), [accountScope, filters]);
  const active = data.accounts.find((a) => a.id === data.activeAccount),
    m = data.metrics;
  useEffect(() => {
    if (accountScope === 'active' && data.activeAccount && filters.account !== data.activeAccount)
      setFilters((current) => ({ ...current, account: data.activeAccount, broker: undefined }));
  }, [accountScope, data.activeAccount]);
  const journalTab = tab === 'Overview' || tab === 'Trade journal' || tab === 'Deposits & withdrawals';
  function setDateRange(preset) {
    setDatePreset(preset);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let since;
    let until;
    if (preset === 'today') since = today;
    if (preset === 'yesterday') {
      since = new Date(today.getTime() - 86400000);
      until = today;
    }
    const days = { week: 7, '30': 30, '90': 90, '365': 365 }[preset];
    if (days) since = new Date(Date.now() - days * 86400000);
    setFilters((f) => ({ ...f, since: since?.toISOString(), until: until?.toISOString() }));
  }
  function changeAccountScope(value) {
    if (value === 'active') { setAccountScope('active'); setFilters((current) => ({ ...current, account: data.activeAccount || undefined, broker: undefined })); }
    else if (value === 'all') { setAccountScope('all'); setFilters((current) => ({ ...current, account: undefined, broker: undefined })); }
    else { setAccountScope('specific'); setFilters((current) => ({ ...current, account: Number(value), broker: undefined })); }
  }
  useEffect(() => {
    if (!active || active.base_currency !== 'USD') { setFx(null); return; }
    let mounted = true;
    const loadRate = async () => {
      try { const rate = await call('mt5:fx-rate', { account_id: active.id, quote: 'GHS' }); if (mounted) setFx(rate); } catch { if (mounted) setFx(null); }
    };
    loadRate();
    const timer = setInterval(loadRate, 60000);
    return () => { mounted = false; clearInterval(timer); };
  }, [active?.id, active?.base_currency]);
  async function importFile(file) {
    if (!file) return;
    if (!active) throw Error('Select an account from the top dropdown before importing.');
    if (file.size > 20000000) throw Error('CSV must be under 20 MB');
    setReport(await call('csv:import', { text: await file.text(), account_id: active.id }));
    await refresh();
  }
  const trades = data.trades
    .filter((t) =>
      `${t.standard_symbol} ${t.ticket_number} ${t.display_name}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    )
    .sort(
      (a, b) =>
        (a[sort.key] > b[sort.key] ? 1 : a[sort.key] < b[sort.key] ? -1 : 0) * (sort.asc ? 1 : -1),
    );
  const curve = [...data.trades].reverse().reduce(
    (arr, t) => {
      arr.push((arr.at(-1) || 0) + t.net_pnl);
      return arr;
    },
    [0],
  );
  const lo = curve.reduce((a, n) => Math.min(a, n), 0),
    hi = curve.reduce((a, n) => Math.max(a, n), 0),
    range = hi - lo || 1;
  const points = curve
    .map((n, i) => `${(i / Math.max(curve.length - 1, 1)) * 900},${150 - ((n - lo) / range) * 125}`)
    .join(' ');
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">m</span> meridian<span className="brand-dot">.</span>
        </div>
        <div className="workspace-label">PERSONAL WORKSPACE</div>
        <nav>
          {['Overview', 'Trade journal', 'Returns', 'Deposits & withdrawals', 'Daily journal', 'Active trades', 'Trade chart', 'Growth calculator', 'Calculators', 'Risk analysis', 'Signal analysis'].map((name, i) => (
            <button
              key={name}
              className={tab === name ? 'nav active' : 'nav'}
              onClick={() => setTab(name)}
            >
              <span>{['◫', '☷', '%', '↕', '✎', '●', '⌁', '∿', '÷', '△', '⌕'][i]}</span>
              {name}
            </button>
          ))}
        </nav>
        <div className="workspace-label mt-8">BROKER ACCOUNTS</div>
        {[
          'All',
          ...new Set(['Exness', 'VTMarkets', 'XM', 'Vantage', ...data.accounts.map((a) => a.broker_name)]),
        ].map((broker, i) => (
          <button
            key={broker}
            className={`nav ${(!filters.broker && i === 0) || filters.broker === broker ? 'selected' : ''}`}
            onClick={() =>
              (setAccountScope('all'), setFilters((f) => ({ ...f, broker: i ? broker : undefined, account: undefined })))
            }
          >
            <span className={`broker-dot dot-${i % 4}`} />
            {broker === 'All' ? 'All accounts' : broker}
            <small>
              {broker === 'All'
                ? data.accounts.length
                : data.accounts.filter((a) => a.broker_name === broker).length}
            </small>
          </button>
        ))}
        <div className="workspace-label mt-8">WATCH YOUR EDGE</div>
        {['All assets', ...assets].map((asset, i) => (
          <button
            key={asset}
            className={`nav ${(!filters.asset && !i) || filters.asset === asset ? 'selected' : ''}`}
            onClick={() => setFilters((f) => ({ ...f, asset: i ? asset : undefined }))}
          >
            <span className="asset-icon">{['◇', 'Au', 'Oil', 'Ag', 'Nq'][i]}</span>
            {asset}
          </button>
        ))}
        <div className="sidebar-bottom">
          <button className="nav" onClick={() => setSettings(true)}>
            <span>⚙</span>Settings & data
          </button>
          <div className="local-badge">
            <span className="broker-dot dot-1" />
            Local-first · Your data stays here
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span> <b>{tab}</b>
          </div>
          <div className="flex gap-3 items-center">
            <span className={`connection ${data.status?.startsWith('Connected') ? 'connected' : ''}`}>
              ● {data.status || 'Offline'}
            </span>
            <select
              aria-label="Active journal and import account"
              value={data.activeAccount || ''}
              onChange={(e) =>
                task(async () => {
                  await call('accounts:select', Number(e.target.value));
                  await refresh();
                })
              }
            >
              <option value="" disabled>
                Select account
              </option>
              {data.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.display_name} · {a.broker_name}
                </option>
              ))}
            </select>
            <span className="avatar">MJ</span>
          </div>
        </header>
        <div className="page">
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR PROCESS. YOUR PROGRESS.</div>
              <h1>
                {{ Overview: 'Performance overview', 'Trade journal': 'Trade journal', Returns: 'Returns on capital', 'Deposits & withdrawals': 'Deposits & withdrawals', 'Daily journal': 'Daily journal', 'Active trades': 'Active trades', 'Trade chart': 'Trade chart', 'Growth calculator': 'Account growth & loss calculator', Calculators: 'Trading calculators', 'Risk analysis': 'Pre-trade risk analysis', 'Signal analysis': 'Signal profit & loss analysis' }[tab]}
              </h1>
              <p className="muted mt-2">
                {tab === 'Returns' ? 'Measure each period’s realized result against its available capital.' : tab === 'Deposits & withdrawals' ? 'See every cash movement separately from trading performance.' : tab === 'Daily journal' ? 'Review the behavior and context behind each trading day.' : tab === 'Active trades' ? 'Your open MT5 positions, floating P&L, and risk at stop.' : tab === 'Trade chart' ? 'See each entry and exit in its market context.' : tab === 'Growth calculator' ? 'Explore compounded growth and loss scenarios for each account.' : tab === 'Calculators' ? 'Quick calculations based on your live account capital.' : tab === 'Risk analysis' ? 'Check risk, reward, and your 2% limit before taking a trade.' : tab === 'Signal analysis' ? 'Replay copied signals against your broker’s historical market data.' : 'A clearer view of every trade, across every account.'}
              </p>
            </div>
            {journalTab && <div className="flex gap-3">
              <select
                aria-label="Journal account filter"
                value={accountScope === 'active' ? 'active' : accountScope === 'all' ? 'all' : String(filters.account || '')}
                onChange={(e) => {
                  const value = e.target.value;
                  changeAccountScope(value);
                }}
              >
                <option value="active">Active MT5 account</option>
                <option value="all">All accounts</option>
                {data.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.display_name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Date range"
                value={datePreset}
                onChange={(e) => setDateRange(e.target.value)}
              >
                <option value="all">All time</option>
                <option value="today">Today</option>
                <option value="yesterday">Yesterday</option>
                <option value="week">Last week</option>
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
                <option value="365">Last 365 days</option>
              </select>
              {active && (
                <button
                  onClick={() =>
                    task(async () => {
                      const result = await call('mt5:connect-sync', active.id);
                      await refresh();
                      setToast(
                        `Synced ${result.inserted} new closed trades from ${result.account.server_name}; ${result.duplicates} already existed.`,
                      );
                    })
                  }
                >
                  ↻ Sync MT5
                </button>
              )}
              <button className="primary" onClick={() => setSettings(true)}>
                ＋ Import trades
              </button>
            </div>}
          </div>
          {error && (
            <div role="alert" className="error mb-4">
              {error}
              <button onClick={() => setError('')}>Dismiss</button>
            </div>
          )}
          {toast && (
            <div role="status" className="success mb-4">
              {toast}
              <button onClick={() => setToast('')}>Dismiss</button>
            </div>
          )}
          {tab === 'Overview' || tab === 'Trade journal' ? (
            <>
              <div className="metrics">
                {[
                  [
                    'Net performance',
                    m.mixed ? 'Mixed currencies' : <MoneyValue value={m.net} currency={m.currency} fx={fx} />,
                    'Realized P&L, after fees',
                    'net',
                  ],
                  [
                    'Win rate',
                    `${(m.winRate || 0).toFixed(1)}%`,
                    `${m.count || 0} closed trades`,
                    'win',
                  ],
                  [
                    'Profit factor',
                    m.mixed ? '—' : m.noLosses ? '∞' : (m.profitFactor || 0).toFixed(2),
                    'Gross profit / gross loss',
                    'pf',
                  ],
                  [
                    'Net ROI',
                    m.mixed || m.roi == null ? '—' : `${m.roi.toFixed(2)}%`,
                    'P&L / capital available for trading',
                    'roi',
                  ],
                ].map(([label, value, sub, key]) => (
                  <section className="metric" key={key}>
                    <div className="metric-label">
                      {label}
                      <span>↗</span>
                    </div>
                    <strong className={key === 'net' ? (m.net < 0 ? 'negative' : 'positive') : ''}>
                      {value}
                    </strong>
                    <small>{sub}</small>
                  </section>
                ))}
              </div>
              {m.mixed && (
                <p className="notice mt-4">
                  Select accounts with the same base currency to view combined monetary performance.
                  Currency conversion is not assumed.
                </p>
              )}
              {tab === 'Overview' && (<>
                <section className="panel chart-panel">
                  <div className="flex justify-between items-start">
                    <div>
                      <h2>Cumulative performance</h2>
                      <p className="muted text-xs mt-2">
                        Realized results · {filters.asset || 'All assets'} ·{' '}
                        {filters.broker || 'All brokers'}
                      </p>
                    </div>
                    <div className="text-right">
                      <strong className="text-xl">
                        {m.mixed ? '—' : <MoneyValue value={m.balance} currency={m.currency} fx={fx} />}
                      </strong>
                      <p className="muted text-xs">Capital, cash flows, and filtered P&amp;L</p>
                    </div>
                  </div>
                  {data.trades.length && !m.mixed ? (
                    <div className="chart">
                      <div className="chart-labels">
                        <span><MoneyValue value={hi} currency={m.currency} fx={fx} /></span>
                        <span><MoneyValue value={lo} currency={m.currency} fx={fx} /></span>
                      </div>
                      <svg
                        viewBox="0 0 900 175"
                        preserveAspectRatio="none"
                        role="img"
                        aria-label="Cumulative realized profit and loss"
                      >
                        <defs>
                          <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#67dabc" stopOpacity=".22" />
                            <stop offset="100%" stopColor="#67dabc" stopOpacity="0" />
                          </linearGradient>
                        </defs>
                        {[25, 75, 125].map((y) => (
                          <line
                            key={y}
                            x1="0"
                            x2="900"
                            y1={y}
                            y2={y}
                            stroke="#26313d"
                            strokeDasharray="3 6"
                          />
                        ))}
                        <polygon points={`0,175 ${points} 900,175`} fill="url(#fill)" />
                        <polyline
                          points={points}
                          fill="none"
                          stroke="#67dabc"
                          strokeWidth="2.5"
                          vectorEffect="non-scaling-stroke"
                        />
                      </svg>
                    </div>
                  ) : (
                    <div className="empty-chart">
                      <div className="empty-symbol">↗</div>
                      <h3>Your next chapter starts with a trade.</h3>
                      <p>Import your closed positions to see your performance take shape.</p>
                      <button onClick={() => setSettings(true)}>Set up your journal →</button>
                    </div>
                  )}
                  <div className="chart-footer">
                    <span>● Net P&L</span>
                    <span>
                      {data.trades.length
                        ? 'Closed trades in chronological order'
                        : 'No simulated results. Only your trading history.'}
                    </span>
                  </div>
                </section>
                <CorePrinciples />
              </>)}
              {tab === 'Trade journal' && <GrowthSummary accountId={filters.account} broker={filters.broker} fx={fx} onError={fail} />}
              <section className="panel table-panel">
                <div className="table-heading">
                  <div>
                    <h2>
                      Trade history <span className="count">{trades.length}</span>
                    </h2>
                    <p className="muted text-xs mt-2">
                      Every entry tells a story. Click a trade to reflect.
                    </p>
                  </div>
                  <input
                    className="search"
                    placeholder="Search symbol, ticket, account…"
                    aria-label="Search trades"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        {[
                          ['close_time', 'Closed / ticket'],
                          ['standard_symbol', 'Asset'],
                          ['display_name', 'Account'],
                          ['type', 'Side'],
                          ['lot_size', 'Lots'],
                          ['net_pnl', 'Net P&L'],
                          ['trade_return_pct', 'P/L %'],
                          ['status', 'Result'],
                          ['close_reason', 'Closed by'],
                        ].map(([key, label]) => (
                          <th key={key}>
                            <button
                              onClick={() =>
                                setSort({ key, asc: sort.key === key ? !sort.asc : true })
                              }
                            >
                              {label} {sort.key === key ? (sort.asc ? '↑' : '↓') : ''}
                            </button>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {trades.slice(0, 500).map((t) => (
                        <tr key={t.id} onClick={() => setSelected(t)}>
                          <td>
                            <button className="trade-link" onClick={() => setSelected(t)}>
                              {new Date(t.close_time).toLocaleDateString()}
                            </button>
                            <small>#{t.ticket_number}</small>
                          </td>
                          <td className="font-semibold">{t.standard_symbol}</td>
                          <td>
                            {t.display_name}
                            <small>{t.broker_name}</small>
                          </td>
                          <td>
                            <span className={t.type === 'BUY' ? 'buy' : 'sell'}>{t.type}</span>
                          </td>
                          <td>{t.lot_size}</td>
                          <td className={t.net_pnl < 0 ? 'negative' : 'positive'}>
                            <MoneyValue value={t.net_pnl} currency={t.base_currency} fx={fx} />
                          </td>
                          <td className={t.net_pnl < 0 ? 'negative' : 'positive'}>{t.trade_return_pct == null ? '—' : `${t.trade_return_pct.toFixed(2)}%`}<small>of {money(t.capital_at_trade, t.base_currency)}</small></td>
                          <td>
                            <span className={`result ${t.status.toLowerCase()}`}>{t.status}</span>
                          </td>
                          <td><span className={`close-reason ${(t.close_reason || 'UNKNOWN').toLowerCase()}`}>{t.close_reason === 'MANUAL' ? 'Manual' : t.close_reason || 'Unknown'}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!trades.length && (
                    <div className="empty-table">
                      No trades to show. Add an account and import an MT4 / MT5 closed-position CSV.
                    </div>
                  )}
                </div>
                {trades.length > 500 && (
                  <p className="notice">
                    Showing the first 500 matching trades. Narrow the date, account, or search
                    filter.
                  </p>
                )}
              </section>
            </>
          ) : tab === 'Returns' ? (
            <ReturnsView accountId={filters.account} broker={filters.broker} accounts={data.accounts} scopeValue={accountScope === 'active' ? 'active' : accountScope === 'all' ? 'all' : String(filters.account || '')} onScopeChange={changeAccountScope} fx={fx} onError={fail} />
          ) : tab === 'Daily journal' ? (
            <DailyJournal account={active} entries={data.dailyEntries || []} trades={data.trades} fx={fx} onSave={(entry) => task(async () => { await call('daily:save', entry); await refresh(); setToast('Daily reflection saved.'); })} />
          ) : tab === 'Active trades' ? (
            <ActiveTrades account={active} onError={fail} fx={fx} />
          ) : tab === 'Trade chart' ? (
            <TradeChart account={active} mappings={data.mappings} onError={fail} fx={fx} />
          ) : tab === 'Deposits & withdrawals' ? (
            <CashFlowPage flows={data.cashFlows || []} fx={fx} />
          ) : tab === 'Growth calculator' ? (
            <ProjectionPage accounts={data.accounts} activeAccountId={data.activeAccount} fx={fx} />
          ) : tab === 'Calculators' ? (
            <CalculatorsPage accounts={data.accounts} activeAccountId={data.activeAccount} fx={fx} />
          ) : tab === 'Risk analysis' ? (
            <RiskAnalysisPage accounts={data.accounts} activeAccountId={data.activeAccount} fx={fx} onError={fail} />
          ) : tab === 'Signal analysis' ? (
            <SignalAnalysisPage accounts={data.accounts} activeAccountId={data.activeAccount} analyses={data.signalAnalyses || []} fx={fx} onRefresh={refresh} onError={fail} onToast={setToast} />
          ) : null}
          <footer className="page-footer">
            <span>MERIDIAN JOURNAL</span>
            <span>{fx ? <span className="fx-source">USD/GHS {number(fx.bid, 4)} bid · {number(fx.ask, 4)} ask · {fx.symbol} via {fx.source}</span> : 'Stored on this device · SQLite'}</span>
          </footer>
        </div>
        <div className="risk-banner">{disclaimer}</div>
      </main>
      {settings && (
        <Modal title="Workspace settings" onClose={() => setSettings(false)}>
          <Settings
            data={data}
            active={active}
            task={task}
            refresh={refresh}
            importFile={importFile}
            report={report}
            setToast={setToast}
          />
        </Modal>
      )}
      {diagnostic && (
        <Modal title={diagnostic.title} onClose={() => setDiagnostic(null)}>
          <p className="notice mb-4">
            {diagnostic.code}: {diagnostic.message}
          </p>
          <ol className="list-decimal pl-5 space-y-3">
            {diagnostic.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <p className="muted mt-5">{diagnostic.note}</p>
        </Modal>
      )}
      {selected && (
        <Modal title={`Trade #${selected.ticket_number}`} onClose={() => setSelected(null)}>
          <dl className="review trade-result-review"><dt>Realized P&amp;L</dt><dd className={selected.net_pnl < 0 ? 'negative' : 'positive'}>{moneyPairText(selected.net_pnl, selected.base_currency, fx)}</dd><dt>Profit / loss percentage</dt><dd className={selected.net_pnl < 0 ? 'negative' : 'positive'}>{selected.trade_return_pct == null ? '—' : `${selected.trade_return_pct.toFixed(2)}%`}</dd><dt>Closed by</dt><dd>{selected.close_reason === 'MANUAL' ? 'Manual close' : selected.close_reason === 'TP' ? 'Take profit trigger' : selected.close_reason === 'SL' ? 'Stop loss trigger' : 'Unknown (imported trade)'}</dd><dt>Capital before close</dt><dd>{moneyPairText(selected.capital_at_trade, selected.base_currency, fx)}</dd></dl>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = Object.fromEntries(new FormData(e.currentTarget));
              task(async () => {
                await call('trade:annotate', {
                  id: selected.id,
                  notes: f.notes,
                  setup_tags: f.setup
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                  mistake_tags: f.mistakes
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                });
                setSelected(null);
                await refresh();
              });
            }}
          >
            <Field
              label="Setup tags (comma separated)"
              name="setup"
              defaultValue={JSON.parse(selected.setup_tags).join(', ')}
            />
            <Field
              label="Mistake tags (comma separated)"
              name="mistakes"
              defaultValue={JSON.parse(selected.mistake_tags).join(', ')}
            />
            <Field label="Trade reflection">
              <textarea name="notes" rows="5" defaultValue={selected.notes} />
            </Field>
            <button className="primary mt-4">Save reflection</button>
          </form>
        </Modal>
      )}
    </div>
  );
}
function Settings({ data, active, task, refresh, importFile, report, setToast }) {
  const [section, setSection] = useState('Journal');
  const [accountMode, setAccountMode] = useState('edit');
  const account = accountMode === 'edit' ? active : null;
  const defaultTerminalPath = 'C:\\Program Files\\MetaTrader 5\\terminal64.exe';
  const [terminalPath, setTerminalPath] = useState(account?.terminal_path || defaultTerminalPath);
  useEffect(() => {
    setTerminalPath(account?.terminal_path || defaultTerminalPath);
  }, [accountMode, active?.id, active?.terminal_path]);
  function submit(e, channel, transform = (x) => x) {
    e.preventDefault();
    const form = e.currentTarget,
      values = Object.fromEntries(new FormData(form));
    task(async () => {
      await call(channel, transform(values));
      await refresh();
      setToast('Settings saved.');
      form.reset();
    });
  }
  return (
    <>
      <div className="tabs mb-6">
        {['Journal', 'Accounts', 'Symbols', 'Bridge', 'Alerts'].map((s) => (
          <button
            key={s}
            className={s === section ? 'tab-active' : ''}
            onClick={() => setSection(s)}
          >
            {s}
          </button>
        ))}
      </div>
      {section === 'Journal' && (
        <>
          <p className="muted mb-4">
            Import destination: <b>{active?.display_name || 'Select an account in the top bar'}</b>
          </p>
          <label
            className="dropzone"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              task(() => importFile(e.dataTransfer.files[0]));
            }}
          >
            <span className="text-3xl">⇧</span>
            <b>Drop an MT4 / MT5 CSV here</b>
            <span>or click to choose a file · closed positions · up to 20 MB</span>
            <input
              type="file"
              accept=".csv,.tsv,.txt"
              onChange={(e) => task(() => importFile(e.target.files[0]))}
            />
          </label>
          <p className="muted text-xs mt-3">
            Unzoned timestamps are interpreted as UTC. Normalize broker-server time before import.
            Fees and commissions must retain their signed values.
          </p>
          {report && (
            <div className="notice mt-4">
              Imported {report.inserted} · Duplicates {report.duplicates} · Rejected{' '}
              {report.errors.length}
              {report.errors.slice(0, 20).map((e) => (
                <div key={e.row}>
                  Row {e.row}: {e.message}
                </div>
              ))}
            </div>
          )}
          <div className="setting-block">
            <h3>Take your journal with you</h3>
            <p className="muted my-3">
              Portable JSON includes accounts, mappings, trades, tags, and notes. Connection secrets
              and execution logs stay on this device.
            </p>
            <button
              className="primary"
              onClick={() =>
                task(async () => {
                  const path = await call('journal:export');
                  if (path) setToast('Journal exported: ' + path);
                })
              }
            >
              Backup & Export Journal Data
            </button>
            <button
              className="ml-3"
              onClick={() =>
                task(async () => {
                  await call('journal:restore');
                  await refresh();
                })
              }
            >
              Restore backup
            </button>
          </div>
        </>
      )}
      {section === 'Accounts' && (
        <>
          <div className="flex gap-3 mb-5">
            <button
              className={accountMode === 'edit' ? 'tab-active' : ''}
              disabled={!active}
              onClick={() => setAccountMode('edit')}
            >
              Edit selected account
            </button>
            <button
              className={accountMode === 'create' ? 'tab-active' : ''}
              onClick={() => setAccountMode('create')}
            >
              Add another account
            </button>
          </div>
          {!account && accountMode === 'edit' ? (
            <p className="notice">
              Select an account in the top bar to edit or launch its terminal.
            </p>
          ) : (
            <form
              key={`${accountMode}-${account?.id || 'new'}`}
              onSubmit={(e) =>
                submit(e, account ? 'accounts:update' : 'accounts:add', (f) => ({
                  ...f,
                  ...(account ? { id: account.id } : {}),
                  starting_balance: Number(f.starting_balance),
                  tracking_since: f.tracking_since || '2000-01-01T00:00:00.000Z',
                }))
              }
              className="form-grid"
            >
              <Field
                label="Display name"
                name="display_name"
                placeholder="My trading account"
                defaultValue={account?.display_name || ''}
                required
              />
              <Field
                label="Broker"
                name="broker_name"
                placeholder="Exness"
                defaultValue={account?.broker_name || 'Exness'}
                required
              />
              <Field
                label="Account type"
                name="account_type"
                defaultValue={account?.account_type || 'Standard'}
                required
              />
              <Field
                label="Base currency"
                name="base_currency"
                defaultValue={account?.base_currency || 'USD'}
                pattern="[A-Z]{3}"
                required
              />
              <Field
                label="Opening capital (ROI basis)"
                name="starting_balance"
                type="number"
                min="0"
                step="any"
                defaultValue={account?.starting_balance || 0}
                required
              />
              <Field label="MT5 login ID" name="login_id" defaultValue={account?.login_id || ''} />
              <input type="hidden" name="tracking_since" value={account?.tracking_since || '2000-01-01T00:00:00.000Z'} />
              <Field
                label="MT5 server name"
                name="server_name"
                placeholder="Exness-MT5Real10"
                defaultValue={account?.server_name || ''}
              />
              <Field label="MT5 terminal executable">
                <div className="path-picker">
                  <input
                    name="terminal_path"
                    value={terminalPath}
                    onChange={(e) => setTerminalPath(e.target.value)}
                    required
                  />
                  <button
                    type="button"
                    onClick={() =>
                      task(async () => {
                        const path = await call('accounts:choose-terminal');
                        if (path) setTerminalPath(path);
                      })
                    }
                  >
                    Browse…
                  </button>
                </div>
              </Field>
              <p className="notice col-span-2">
                This profile opens its own terminal path. Several account profiles may reuse one MT5
                installation, but that terminal can expose only its currently signed-in account. Use
                separate MT5 installations when accounts must stay signed in simultaneously.
              </p>
              <div className="col-span-2 flex gap-3">
                <button className="primary">
                  {account ? 'Save account profile' : 'Create account profile'}
                </button>
                {account && (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        task(async () => {
                          const result = await call('mt5:connect-sync', account.id);
                          await refresh();
                          setToast(
                            `Connected to ${result.account.server_name}. Imported ${result.inserted} closed trades; ${result.duplicates} already existed.`,
                          );
                        })
                      }
                    >
                      Connect & sync MT5 history
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        task(async () => {
                          const path = await call('accounts:launch-terminal', account.id);
                          setToast(`Opened MT5: ${path}`);
                        })
                      }
                    >
                      Launch this MT5 terminal
                    </button>
                  </>
                )}
              </div>
            </form>
          )}
        </>
      )}
      {section === 'Symbols' && (
        <>
          <form className="form-grid" onSubmit={(e) => submit(e, 'mappings:save')}>
            <Field label="Broker" name="broker_name" placeholder="Exness" required />
            <Field label="Standard symbol" name="standard_symbol" placeholder="XAUUSD" required />
            <Field
              label="Exact broker symbol"
              name="broker_symbol"
              placeholder="XAUUSDm"
              required
            />
            <button className="primary self-end">Save mapping</button>
          </form>
          <div className="mt-6">
            {data.mappings.map((m) => (
              <div key={m.id} className="log-row">
                <span>
                  {m.broker_name} · {m.standard_symbol}
                </span>
                <code>{m.broker_symbol}</code>
              </div>
            ))}
          </div>
        </>
      )}
      {section === 'Bridge' && (
        <form onSubmit={(e) => submit(e, 'bridge:connect')}>
          <p className="notice mb-5">
            Connect to a local MT5 adapter implementing the protocol in docs/BRIDGE.md. No bridge or
            live execution is enabled by default.
          </p>
          <Field
            label="Loopback WebSocket URL"
            name="url"
            defaultValue="ws://127.0.0.1:8787"
            required
          />
          <Field
            label="Bridge token (kept in memory for this session)"
            name="token"
            type="password"
            minLength="16"
            autoComplete="off"
            required
          />
          <button className="primary mt-5">Connect local bridge</button>
        </form>
      )}
      {section === 'Alerts' && (
        <>
          <section className="alert-preference">
            <div><h3>Alert sound</h3><p className="muted text-xs mt-2">Choose how Meridian gets your attention when a target is reached.</p></div>
            <div className="alert-mode-controls">
              <select value={data.alertMode || 'tone'} onChange={(e) => task(async () => { await call('alerts:preference', e.target.value); await refresh(); setToast('Alert sound preference saved.'); })} aria-label="Price alert sound">
                <option value="tone">Soft tone</option><option value="voice">Human-like voice</option>
              </select>
              <button type="button" onClick={() => previewAlert(data.alertMode || 'tone')}>▶ Play test</button>
            </div>
          </section>
          <form
            className="form-grid setting-block"
            onSubmit={(e) => submit(e, 'alerts:add', (f) => ({ ...f, bound: Number(f.bound) }))}
          >
            <Field label="Asset">
              <select name="asset">
                {[...new Set(data.mappings.filter((m) => !active || m.broker_name === active.broker_name).map((m) => m.standard_symbol))].map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </Field>
            <Field label="Target price" name="bound" type="number" min="0" step="any" required />
            <button className="primary self-end" disabled={!active}>Arm alert</button>
          </form>
          <p className="muted text-xs mt-3">
            Alerts remain saved after restart. Meridian checks the selected account’s live MT5 bid price once per second while the app and terminal are running.
          </p>
          <div className="setting-block">
            <h3>Price alerts <span className="count">{(data.priceAlerts || []).length}</span></h3>
            <div className="alert-list">
              {(data.priceAlerts || []).map((alert) => <div className="alert-rule" key={alert.id}>
                <div className={`alert-state ${alert.status.toLowerCase()}`} />
                <div><b>{alert.standard_symbol} {alert.direction === 'above' ? '≥' : '≤'} {number(alert.target_price, 6)}</b><small>{alert.display_name} · created {new Date(alert.created_at).toLocaleString()}</small>{alert.status === 'TRIGGERED' && <small>Triggered at {number(alert.trigger_price, 6)} · {new Date(alert.triggered_at).toLocaleString()}</small>}</div>
                <span className={`result ${alert.status === 'ARMED' ? 'win' : 'be'}`}>{alert.status}</span>
                {alert.status === 'TRIGGERED' && <button type="button" onClick={() => task(async () => { await call('alerts:rearm', alert.id); await refresh(); setToast(`${alert.standard_symbol} alert re-armed.`); })}>Re-arm</button>}
                <button type="button" className="danger-quiet" onClick={() => task(async () => { await call('alerts:delete', alert.id); await refresh(); })}>Remove</button>
              </div>)}
              {!(data.priceAlerts || []).length && <p className="empty-table">No price alerts yet. Add as many targets as you need.</p>}
            </div>
          </div>
          <details className="setting-block">
            <summary>Optional SMTP email delivery</summary>
            <form
              className="form-grid mt-4"
              onSubmit={(e) =>
                submit(e, 'alerts:email', (f) => ({
                  ...f,
                  port: Number(f.port),
                  secure: f.secure === 'true',
                }))
              }
            >
              {[
                ['host', 'SMTP host'],
                ['port', 'Port'],
                ['user', 'Username'],
                ['password', 'Password'],
                ['from', 'From address'],
                ['to', 'Destination address'],
              ].map(([name, label]) => (
                <Field
                  key={name}
                  label={label}
                  name={name}
                  type={
                    name === 'password'
                      ? 'password'
                      : name === 'port'
                        ? 'number'
                        : ['from', 'to'].includes(name)
                          ? 'email'
                          : 'text'
                  }
                  required
                />
              ))}
              <Field label="TLS mode">
                <select name="secure">
                  <option value="true">Implicit TLS (465)</option>
                  <option value="false">Required STARTTLS (587)</option>
                </select>
              </Field>
              <button className="primary self-end">Enable email this session</button>
            </form>
          </details>
        </>
      )}
    </>
  );
}
createRoot(document.getElementById('root')).render(<App />);
