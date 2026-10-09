const numberPattern = String.raw`([0-9]+(?:\.[0-9]+)?)`;
const months = new Map([
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
].map((month, index) => [month, index + 1]));

function dateFromHeader(value) {
  const match = value.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i);
  if (!match) return null;
  const month = months.get(match[1].toLowerCase());
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function stripSignalDecorations(value) {
  return String(value || '')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D]/gu, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

export function parseSignalText(setupText, outcomeText = '', { requireHeader = true } = {}) {
  const setup = stripSignalDecorations(setupText);
  const outcome = stripSignalDecorations(outcomeText);
  const setupHeaders = [...setup.matchAll(/TRADE\s+SETUP\s*#\s*(\d+)\s*[-–—]\s*([^\n]+)/gi)];
  const zones = [...setup.matchAll(new RegExp(`\\b(BUY|SELL)\\s+([A-Z][A-Z0-9._-]*)\\s+ZONE\\s*:\\s*${numberPattern}\\s*[-–—]\\s*${numberPattern}`, 'gi'))];
  const setupNumber = setupHeaders[0]?.[1];
  const zone = zones[0];
  const stopLoss = setup.match(new RegExp(`\\bSL\\s*:\\s*${numberPattern}`, 'i'))?.[1];
  const tpLine = setup.match(/\bTP\s*:\s*([^\n]+)/i)?.[1] || '';
  const targets = [...tpLine.matchAll(/[0-9]+(?:\.[0-9]+)?/g)].map((match) => Number(match[0]));
  if (setupHeaders.length > 1 || (requireHeader && setupHeaders.length !== 1))
    throw Error('Paste exactly one complete TRADE SETUP with its number and date.');
  if (setupHeaders.length && Number(setupNumber) < 1) throw Error('The trade setup number must be greater than zero.');
  const embeddedDate = setupHeaders.length ? dateFromHeader(setupHeaders[0][2]) : null;
  if (setupHeaders.length && !embeddedDate) throw Error('The setup header must contain a valid date such as October 8, 2026.');
  if (zones.length !== 1) throw Error('The signal must contain exactly one BUY or SELL entry zone.');
  if (!zone) throw Error('The signal must include BUY or SELL, a symbol, and an entry zone.');
  if (!stopLoss) throw Error('The signal must include an SL price.');
  if (!targets.length) throw Error('The signal must include at least one TP price.');
  const entries = [...outcome.matchAll(/([+-]?\d+(?:\.\d+)?)\s+PIPS?\s+from\s+entry\s+([0-9]+(?:\.[0-9]+)?)/gi)]
    .map((match) => ({ reported_pips: Number(match[1]), entry: Number(match[2]) }));
  const parsed = {
    setup_number: setupNumber ? Number(setupNumber) : null,
    embedded_date: embeddedDate,
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
  if (!(parsed.zone_low > 0) || parsed.zone_low >= parsed.zone_high) throw Error('The entry zone must contain two different positive prices.');
  if (!(parsed.stop_loss > 0) || !(parsed.take_profit > 0)) throw Error('SL and TP1 must be positive prices.');
  if (parsed.side === 'BUY' && parsed.stop_loss >= parsed.zone_low) throw Error('A BUY signal’s SL must be below its entry zone.');
  if (parsed.side === 'BUY' && parsed.take_profit <= parsed.zone_high) throw Error('A BUY signal’s TP1 must be above its entry zone.');
  if (parsed.side === 'SELL' && parsed.stop_loss <= parsed.zone_high) throw Error('A SELL signal’s SL must be above its entry zone.');
  if (parsed.side === 'SELL' && parsed.take_profit >= parsed.zone_low) throw Error('A SELL signal’s TP1 must be below its entry zone.');
  if (parsed.tp1_confirmed && parsed.stop_confirmed) throw Error('The result text cannot say that both TP1 and SL were hit.');
  if (outcome && !parsed.tp1_confirmed && !parsed.stop_confirmed) throw Error('The result text must contain either “TP1 HIT” or “SL HIT”.');
  if (parsed.reported_entries.some((entry) => !(entry.entry > 0))) throw Error('Every reported entry must contain a positive price.');
  if (parsed.tp1_confirmed && parsed.reported_entries.some((entry) => entry.reported_pips <= 0)) throw Error('A TP1 result cannot contain zero or negative reported pips.');
  return parsed;
}

export function validateSignalDate(parsed, selectedDate) {
  if (parsed.embedded_date !== selectedDate)
    throw Error(`The pasted setup date is ${parsed.embedded_date}, but the selected date is ${selectedDate}.`);
  return parsed;
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
