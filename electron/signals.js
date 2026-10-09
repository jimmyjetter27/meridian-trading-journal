const numberPattern = String.raw`([0-9]+(?:\.[0-9]+)?)`;

export function stripSignalDecorations(value) {
  return String(value || '')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D]/gu, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

export function parseSignalText(setupText, outcomeText = '') {
  const setup = stripSignalDecorations(setupText);
  const outcome = stripSignalDecorations(outcomeText);
  const setupNumber = setup.match(/TRADE\s+SETUP\s*#\s*(\d+)/i)?.[1];
  const zone = setup.match(new RegExp(`\\b(BUY|SELL)\\s+([A-Z][A-Z0-9._-]*)\\s+ZONE\\s*:\\s*${numberPattern}\\s*[-–—]\\s*${numberPattern}`, 'i'));
  const stopLoss = setup.match(new RegExp(`\\bSL\\s*:\\s*${numberPattern}`, 'i'))?.[1];
  const tpLine = setup.match(/\bTP\s*:\s*([^\n]+)/i)?.[1] || '';
  const targets = [...tpLine.matchAll(/[0-9]+(?:\.[0-9]+)?/g)].map((match) => Number(match[0]));
  if (!setupNumber) throw Error('The signal must include a setup number such as TRADE SETUP #4.');
  if (!zone) throw Error('The signal must include BUY or SELL, a symbol, and an entry zone.');
  if (!stopLoss) throw Error('The signal must include an SL price.');
  if (!targets.length) throw Error('The signal must include at least one TP price.');
  const entries = [...outcome.matchAll(/([+-]?\d+(?:\.\d+)?)\s+PIPS?\s+from\s+entry\s+([0-9]+(?:\.[0-9]+)?)/gi)]
    .map((match) => ({ reported_pips: Number(match[1]), entry: Number(match[2]) }));
  return {
    setup_number: Number(setupNumber),
    side: zone[1].toUpperCase(),
    standard_symbol: zone[2].toUpperCase().replace(/[^A-Z0-9]/g, ''),
    zone_low: Math.min(Number(zone[3]), Number(zone[4])),
    zone_high: Math.max(Number(zone[3]), Number(zone[4])),
    stop_loss: Number(stopLoss),
    take_profit: targets[0],
    targets,
    tp1_confirmed: /\bTP\s*1\s+HIT\b/i.test(outcome),
    stop_confirmed: /\b(?:SL|STOP\s*LOSS)\s+HIT\b/i.test(outcome),
    reported_entries: entries,
    clean_setup_text: setup,
    clean_outcome_text: outcome,
  };
}

export function summarizeSignalAnalysis(result, startingBalance) {
  const total = result.trades.reduce((sum, trade) => sum + Number(trade.net_pnl || 0), 0);
  return {
    total_pnl: total,
    projected_balance: Number(startingBalance) + total,
    wins: result.trades.filter((trade) => trade.net_pnl > 0).length,
    losses: result.trades.filter((trade) => trade.net_pnl < 0).length,
  };
}
