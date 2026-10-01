export function analytics(trades, accounts) {
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
    net = gains - losses,
    capital = accounts.reduce((n, a) => n + a.starting_balance, 0);
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
    balance: capital + net,
  };
}
