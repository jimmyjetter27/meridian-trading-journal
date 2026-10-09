export function analytics(trades, accounts, context = {}) {
  const currencies = [...new Set(accounts.map((a) => a.base_currency))];
  if (currencies.length > 1)
    return {
      mixed: true,
      count: trades.length,
      winRate: trades.length
        ? (trades.filter((t) => t.net_pnl > 0).length / trades.length) * 100
        : 0,
    };
  const wins = trades.filter((t) => t.net_pnl > 0),
    gains = wins.reduce((n, t) => n + t.net_pnl, 0),
    losses = -trades.filter((t) => t.net_pnl < 0).reduce((n, t) => n + t.net_pnl, 0),
    net = gains - losses;
  if (!context.balanceSnapshots && !context.capitalEvents && !context.allTrades) {
    const capital = accounts.reduce((sum, account) => sum + Number(account.starting_balance || 0), 0);
    return {
      mixed: false, currency: currencies[0] || 'USD', count: trades.length,
      winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
      profitFactor: losses ? gains / losses : gains ? null : 0,
      noLosses: !losses && gains > 0, net,
      roi: capital ? (net / capital) * 100 : null,
      capital, balance: capital + net, currentCapital: capital + net, capitalFlow: 0,
    };
  }
  const ids = new Set(accounts.map((account) => account.id));
  const allTrades = (context.allTrades || trades).filter((trade) => ids.has(trade.account_id));
  const allEvents = (context.capitalEvents || []).filter((event) => ids.has(event.account_id));
  const snapshots = new Map((context.balanceSnapshots || []).map((row) => [row.account_id, Number(row.balance || 0)]));
  const currentCapital = accounts.reduce((sum, account) => {
    if (snapshots.has(account.id)) return sum + snapshots.get(account.id);
    const accountPnl = allTrades.filter((trade) => trade.account_id === account.id).reduce((total, trade) => total + Number(trade.net_pnl || 0), 0);
    const accountFlows = allEvents.filter((event) => event.account_id === account.id).reduce((total, event) => total + Number(event.amount || 0), 0);
    return sum + Number(account.starting_balance || 0) + accountPnl + accountFlows;
  }, 0);
  const initialCapital = currentCapital
    - allTrades.reduce((sum, trade) => sum + Number(trade.net_pnl || 0), 0)
    - allEvents.reduce((sum, event) => sum + Number(event.amount || 0), 0);
  const before = (iso, boundary) => !boundary || iso < boundary;
  const openingCapital = initialCapital
    + allTrades.filter((trade) => context.since && before(trade.close_time, context.since)).reduce((sum, trade) => sum + Number(trade.net_pnl || 0), 0)
    + allEvents.filter((event) => context.since && before(event.occurred_at, context.since)).reduce((sum, event) => sum + Number(event.amount || 0), 0);
  const periodEvents = allEvents.filter((event) =>
    (!context.since || event.occurred_at >= context.since) && (!context.until || event.occurred_at < context.until));
  const capitalFlow = periodEvents.reduce((sum, event) => sum + Number(event.amount || 0), 0);
  const capital = openingCapital + capitalFlow;
  const balance = openingCapital + capitalFlow + net;
  return {
    mixed: false,
    currency: currencies[0] || 'USD',
    count: trades.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: losses ? gains / losses : gains ? null : 0,
    noLosses: !losses && gains > 0,
    net,
    roi: capital ? (net / capital) * 100 : null,
    capital,
    balance,
    currentCapital,
    capitalFlow,
  };
}

export function addTradeReturnPercentages(trades, accounts, allTrades, capitalEvents, balanceSnapshots) {
  const snapshots = new Map(balanceSnapshots.map((row) => [row.account_id, Number(row.balance || 0)]));
  const percentages = new Map();
  for (const account of accounts) {
    const accountTrades = allTrades.filter((trade) => trade.account_id === account.id);
    const accountEvents = capitalEvents.filter((event) => event.account_id === account.id);
    const current = snapshots.has(account.id)
      ? snapshots.get(account.id)
      : Number(account.starting_balance || 0)
        + accountTrades.reduce((sum, trade) => sum + Number(trade.net_pnl || 0), 0)
        + accountEvents.reduce((sum, event) => sum + Number(event.amount || 0), 0);
    let capital = current
      - accountTrades.reduce((sum, trade) => sum + Number(trade.net_pnl || 0), 0)
      - accountEvents.reduce((sum, event) => sum + Number(event.amount || 0), 0);
    const ledger = [
      ...accountEvents.map((event) => ({ type: 'flow', at: event.occurred_at, amount: Number(event.amount || 0), id: event.id })),
      ...accountTrades.map((trade) => ({ type: 'trade', at: trade.close_time, amount: Number(trade.net_pnl || 0), id: trade.id })),
    ].sort((a, b) => a.at.localeCompare(b.at)
      || (a.type === 'flow' ? 0 : 1) - (b.type === 'flow' ? 0 : 1)
      || a.id - b.id);
    for (const entry of ledger) {
      if (entry.type === 'trade') percentages.set(entry.id, {
        capital_at_trade: capital,
        trade_return_pct: capital > 0 ? (entry.amount / capital) * 100 : null,
      });
      capital += entry.amount;
    }
  }
  return trades.map((trade) => ({ ...trade, ...(percentages.get(trade.id) || { capital_at_trade: null, trade_return_pct: null }) }));
}
