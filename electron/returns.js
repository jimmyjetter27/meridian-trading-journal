function periodKey(iso, granularity) {
  const date = new Date(iso);
  if (granularity === 'yearly') return String(date.getUTCFullYear());
  if (granularity === 'monthly') return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  if (granularity === 'weekly') {
    const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = monday.getUTCDay() || 7;
    monday.setUTCDate(monday.getUTCDate() - day + 1);
    return monday.toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

export function calculatePeriodReturns(accounts, trades, capitalEvents, balanceSnapshots, granularity) {
  const allowed = new Set(['daily', 'weekly', 'monthly', 'yearly']);
  if (!allowed.has(granularity)) throw Error('Unsupported return period');
  const currencies = [...new Set(accounts.map((account) => account.base_currency))];
  if (currencies.length > 1) return { mixed: true, currency: null, current_capital: null, periods: [] };
  const snapshots = new Map(balanceSnapshots.map((row) => [row.account_id, Number(row.balance || 0)]));
  const currentCapital = accounts.reduce((sum, account) => {
    if (snapshots.has(account.id)) return sum + snapshots.get(account.id);
    const accountPnl = trades.filter((trade) => trade.account_id === account.id).reduce((total, trade) => total + Number(trade.net_pnl || 0), 0);
    const accountFlows = capitalEvents.filter((event) => event.account_id === account.id).reduce((total, event) => total + Number(event.amount || 0), 0);
    return sum + Number(account.starting_balance || 0) + accountPnl + accountFlows;
  }, 0);
  const totalPnl = trades.reduce((sum, trade) => sum + Number(trade.net_pnl || 0), 0);
  const totalFlows = capitalEvents.reduce((sum, event) => sum + Number(event.amount || 0), 0);
  let capital = currentCapital - totalPnl - totalFlows;
  const groups = new Map();
  const groupFor = (iso) => {
    const key = periodKey(iso, granularity);
    if (!groups.has(key)) groups.set(key, { key, pnl: 0, capital_flow: 0, trade_count: 0 });
    return groups.get(key);
  };
  for (const trade of trades) {
    const key = periodKey(trade.close_time, granularity);
    const group = groupFor(trade.close_time);
    group.pnl += Number(trade.net_pnl || 0);
    group.trade_count += 1;
  }
  for (const event of capitalEvents) groupFor(event.occurred_at).capital_flow += Number(event.amount || 0);
  const periods = [];
  for (const group of [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const opening_capital = capital;
    capital += group.pnl + group.capital_flow;
    const capital_basis = opening_capital + group.capital_flow;
    periods.push({
      ...group,
      opening_capital,
      capital_basis,
      closing_capital: capital,
      return_pct: capital_basis > 0 ? (group.pnl / capital_basis) * 100 : null,
    });
  }
  return { mixed: false, currency: currencies[0] || 'USD', current_capital: currentCapital, periods };
}
