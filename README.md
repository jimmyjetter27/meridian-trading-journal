# Meridian

A local-first Electron + React trading journal with a read-only MT5 adapter. The interface includes account and asset filters, rolling metrics, a realized P&L curve, cash-flow history, daily/weekly/monthly growth, active-position risk, account projections, journal annotations, CSV import, portable backup/restore, diagnostics, and session price/email alerts. Meridian cannot place orders or close positions.

## Run

Node.js 22.12+ and npm are required for development.

```powershell
npm install
npm run dev
```

For a production renderer, run `npm run build`, then `npm start`. Run `npm test` for backend regression tests. `npm run dist` creates an installer for the current OS through electron-builder (Windows NSIS, macOS DMG, Linux AppImage). Build on each target OS; signing/notarization requires your certificates. Native SQLite is rebuilt for Electron by postinstall. Tests run using Electron's Node runtime to match that native ABI.

On this machine, dependencies and the production renderer are already built. Double-click `Start Meridian.cmd` to launch. `npm run smoke` checks the real desktop renderer and IPC using an isolated test profile under `artifacts/smoke-profile`; it never reads your normal journal. The smoke test writes `artifacts/dashboard.png` and `artifacts/smoke.json`. `npm run format` formats the source.

Verified on Windows with 20 backend regression tests, a Vite production build, Electron renderer/preload/IPC/database smoke testing, and a read-only Exness MT5 history sync.

## First use

1. Open **Settings & data → Accounts** and add a broker account, base currency, opening capital, login/server identity, and its `terminal64.exe` path. The default is `C:\Program Files\MetaTrader 5\terminal64.exe`. Select the account in the top bar. Existing profiles can be edited and their assigned terminal launched from the same pane.
2. In **Symbols**, map standard tokens to exact broker strings, e.g. Exness / XAUUSD / XAUUSDm or XM / XAUUSD / Gold. Mapping rules are account-broker specific and explicit.
3. Import an MT4/MT5 **closed-position** CSV through **Journal**. A sample is in `examples/closed-positions.csv`; it is never loaded automatically. Confirm its symbol mappings first.
4. Use the sidebar broker/asset filters and top date filter to inspect results. Click trade history rows to add setup tags, mistake tags, and notes.
5. **Backup & Export Journal Data** writes a portable JSON package. Restore validates version, fields, relationships and constraints inside a transaction. A recovery JSON is saved before replacing the current journal. Login/server metadata is portable; master passwords are empty. Bridge tokens and SMTP passwords are never exported or persisted.

The packaged Windows app includes a local MetaQuotes Python adapter. Select an account, open **Settings & data → Accounts**, and choose **Connect & sync MT5 history**. It attaches to the configured `terminal64.exe`, reuses the terminal's saved login, verifies login and server identity, imports closed positions, creates exact broker symbol mappings, and deduplicates repeat syncs. It binds only to loopback with a random session token. The adapter is permanently read-only; order placement and position closure are rejected. The bridge contract is documented in [docs/BRIDGE.md](docs/BRIDGE.md).

An MT5 installation can store and switch among several saved accounts, so several Meridian profiles may point to the same `terminal64.exe`. Only the account currently signed into that terminal is active. For simultaneous sessions, install or copy MT5 into separate folders, sign each terminal into one account, and assign the corresponding executable to each Meridian profile. The bridge must still verify the login ID and server on every request; launching an already signed-in terminal alone does not provide an execution API.

## Architecture

- `electron/main.js`: window lifecycle, trusted sender checks, input-validated IPC, native file dialogs, portability controller. Renderer has no Node access; sandbox and context isolation are enabled. Navigation, popups, and renderer permissions are denied. [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security).
- `electron/database.js`: initialization, public account projection, filtered queries, transactional restore. `journal.db` is located in `app.getPath('userData')`; SQLite DELETE journaling keeps persistent storage to one database file (a transient rollback journal may exist during writes). Foreign keys and versioned schema migrations are enabled.
- `electron/importer.js`: comma/semicolon/tab delimiter detection, BOM handling, quoted values, duplicate `Price`/`Time` columns, header aliases, fee-inclusive P&L and explicit symbol mapping. Ticket IDs stay strings; the requested global unique ticket constraint deduplicates across all accounts as well as repeated imports.
- `electron/returns.js`: reconstructs daily, weekly, monthly, and yearly opening capital from the latest MT5 balance, realized P&L, and balance events. Deposits and withdrawals change capital without counting as trading returns.
- `adapter/bridge.py`: tolerates small broker-server clock differences when reading completed deals and calculates each active position's loss at its configured stop with MT5's read-only profit calculator.
- `electron/execution.js`: authoritative active-account context with execution disabled by default. The renderer exposes no execution IPC channels, and the packaged adapter rejects every trading method.
- `electron/bridge.js`: authenticated loopback WebSocket transport for read-only account, history, position, chart, quote, and FX requests.
- `electron/alerts.js`: crossing detection on fresh pushed ticks; native notifications and optional TLS-required nodemailer delivery. Rules trigger once and reset on restart. SMTP credentials remain in memory for the session. Delivery failures produce a native notice.
- `electron/diagnostics.js`: MT5 code dictionary and permission guide; distinguishes server restrictions from local terminal configuration.
- `src/main.jsx`: dashboard, settings, journal editing, active-position monitoring, charting, alerts, and diagnostic UI. Tailwind CSS plus local design styles in `src/styles.css`.
- `shared/contracts.js`: Zod account, mapping, order and trade models shared across boundaries.

## Import boundaries

CSV exports vary by broker, terminal language and report type. Supported aliases are explicit in `importer.js`. Unzoned timestamps are treated as UTC; convert broker server timestamps before import. Decimal commas work in semicolon or quoted fields. Commission/swap/fee columns must contain signed values. If `Net PnL` exists it takes precedence. Pips are retained only when supplied because tick/pip conventions differ per asset.

Raw MT5 deal ledgers, HTML reports, localized headers, multi-section reports, split fills and partial-close reconstruction are **not** silently treated as closed trades; unsupported layouts produce clear errors. Aggregate the terminal's position history into the documented closed-position format first. Rejected rows are reported; valid rows import together transactionally. Ticket uniqueness is global per the requested schema and can collide across brokers; change to a compound unique key if account-scoped identity is desired.

## Operational limits

Alerts require the desktop app and MT5 terminal to remain running. Single-instance locking prevents two application processes sharing the journal. The app reads account history, open positions, charts, quotes, and conversion rates; it has no order-entry or position-closing route.
