# Local MT5 adapter contract

Meridian is an execution **client**. An MT5 adapter/Expert Advisor is not bundled. The protocol below is the boundary an adapter must implement and test on a demo terminal before use. Merely running Meridian cannot place a trade.

Connect a WebSocket server on loopback (default `ws://127.0.0.1:8787`). Require a random token of at least 16 characters in the HTTP `Authorization: Bearer …` upgrade header. Bind only to loopback and reject unauthorized upgrades. The token lives in Meridian main-process memory until exit. The adapter should use the locally signed-in terminal; do not transmit master passwords.

Requests: `{ "id": "UUID", "method": "symbol.snapshot", "params": { ... } }`.
Success: `{ "id": "same UUID", "result": { ... } }`.
Failure: `{ "id": "same UUID", "error": { "code": "10017", "message": "Trading disabled" } }`.
All account-bound requests include `account_id`, `login_id` (string), and `server_name`. Verify login **and** server at the adapter immediately before every MT5 operation. Never switch credentials silently. Return errors without secrets.

## Methods

- `symbol.snapshot`: accepts exact `symbol`. Returns `login_id`, `server_name`, `symbol`, `bid`, `ask`, `timestamp` (UTC epoch milliseconds), `volume_min`, `volume_max`, `volume_step`, `tick_size`, `tick_value` (one lot, account currency, loss-side value), and `stops_level` (**absolute price distance**, not points). Snapshots must be less than 5 seconds old.
- `position.snapshot`: accepts string `position_id`. Returns the same ID, `login_id`, `server_name`, `symbol`, `type` (`BUY`/`SELL`), `lots`, and `stop_loss` (0 if absent). Read the position from the terminal, never a client-provided volume.
- `trade.place`: includes `request_id`, `expires_at` (epoch milliseconds), `symbol`, `asset` (internal label), `type`, `kind` (`MARKET`, `BUY_LIMIT`, `SELL_LIMIT`, `BUY_STOP`, `SELL_STOP`), `lots`, `stop_loss`, optional `price`, and informational `entry`. Use exact `symbol`; never fall back to fuzzy matching. `entry` is a preview quote, not permission to bypass broker price checks.
- `trade.close`: includes `request_id`, `expires_at`, `position_id`, `symbol`, `lots`, and `stop_loss`. Re-read the position and reject if its identity, direction, or volume changed since preview. Close only the specified position, accounting for MT5 hedging versus netting mode.
- `trade.status`: accepts original `request_id` and account identity. Returns `login_id`, `server_name`, `state` (`EXECUTED`, `REJECTED`, `NOT_SUBMITTED`, or `UNKNOWN`) and optionally broker ticket details. `NOT_SUBMITTED` must be proven from a durable idempotency ledger, never inferred from the absence of an open position.

Execution results must include numeric MT5 `retcode`. Meridian recognizes `10008` (placed), `10009` (done), and `10010` (partial) as acknowledgements, not necessarily final fills. Preserve the exact retcode, order/deal IDs, and filled volume in the result. Journal imports remain a separate source of realized trade history; acknowledgement does not create a fabricated closed trade.

## Required adapter guarantees

Persist request IDs before sending to MT5. A duplicate ID must return the existing outcome and never submit twice, including after adapter restart. Enforce expiry at receipt. Check account identity, permissions, session, current price, SL direction and distance, tick/volume increments, free margin, maximum deviation, filling policy, and symbol trade mode immediately before sending. Use MT5 OrderCheck where available. Fail closed if validation is unavailable. A client estimate is not a broker risk check.

Persist and reconcile unknown outcomes against orders, deals, and history. Never automatically retry an order or closure after a timeout. Meridian keeps SENDING/UNKNOWN requests in SQLite and blocks further submissions for that account until `trade.status` gives a definitive result.

Ticks: `{ "type": "tick", "account_id": 1, "symbol": "XAUUSDm", "bid": 2000.5, "timestamp": 1790000000000 }`. Send fresh ticks for all armed instruments/accounts; the client rejects stale ticks. For an adapter polling MT5, a 250–1000 ms tick loop is a reasonable configurable starting point, not an execution-latency guarantee. The client consumes pushed ticks without renderer polling.

## Diagnostics references

[MQL5 trade return codes](https://www.mql5.com/en/docs/constants/errorswarnings/enum_trade_return_codes) distinguish 10017 (trading disabled), 10026 (server disables autotrading), and 10027 (client disables autotrading). A WebRequest allowlist is relevant only to an EA using HTTP WebRequest; it does not authorize a separate Python or WebSocket adapter. Terminal permissions cannot override broker restrictions.
