# Local MT5 adapter contract

Meridian is a journal-only **read client**. The packaged adapter reads account state, history, positions, charts, quotes, and conversion rates. Meridian does not expose order-entry or position-closing IPC routes, and the adapter rejects every trading method.

Connect a WebSocket server on loopback (default `ws://127.0.0.1:8787`). Require a random token of at least 16 characters in the HTTP `Authorization: Bearer …` upgrade header. Bind only to loopback and reject unauthorized upgrades. The token lives in Meridian main-process memory until exit. The adapter should use the locally signed-in terminal; do not transmit master passwords.

Requests: `{ "id": "UUID", "method": "symbol.snapshot", "params": { ... } }`.
Success: `{ "id": "same UUID", "result": { ... } }`.
Failure: `{ "id": "same UUID", "error": { "code": "BRIDGE_ERROR", "message": "..." } }`.
The Electron main process verifies `login_id` and `server_name` on every account-bound response. The adapter never changes terminal credentials or stores a password.

## Methods

- `account.snapshot`: returns the current login, server, broker, currency, balance, equity, terminal state, and literal `adapter_mode: "read-only"`.
- `history.closed-trades`: accepts `date_from` and returns closed positions plus balance events from that timestamp. Meridian uses each account's `tracking_since` value for a clean journal baseline.
- `positions.active`: returns open-position details for monitoring only.
- `symbol.snapshot`: accepts an exact broker symbol and returns its current quote and symbol metadata for alerts.
- `chart.snapshot`: returns OHLC candles for an exact symbol and supported timeframe.
- `signal.backtest`: replays a signal against historical broker ticks and returns read-only TP1/SL estimates using MT5 profit calculations, historical spread, and fees inferred from comparable completed trades.
- `signal.risk`: compares candidate prices inside an entry zone using the current broker spread, MT5 profit calculations, and inferred fees. It performs no order action and stores no result.
- `fx.rate`: returns a broker-provided conversion quote when the requested currency pair exists.

The methods `trade.place`, `trade.close`, `trade.status`, and `position.snapshot` always return a permission error. They are not exposed to the renderer.

## Read-only guarantees

The adapter initializes the already signed-in local terminal and never calls MetaTrader order APIs. It binds only to `127.0.0.1`, requires an unpredictable bearer token, validates the configured login and server, and emits no credentials. Alerts consume quotes but cannot submit an instruction to MT5.
