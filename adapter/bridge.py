import argparse
import json
import math
import os
import signal
import sys
from collections import defaultdict
from datetime import datetime, timezone

import MetaTrader5 as mt5
from websockets.sync.server import serve


def emit(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


def serial(value):
    if hasattr(value, "_asdict"):
        return {key: serial(item) for key, item in value._asdict().items()}
    if isinstance(value, (tuple, list)):
        return [serial(item) for item in value]
    return value


def canonical_symbol(symbol):
    original = symbol or ""
    upper = original.upper()
    aliases = {
        "XAUUSD": ("XAUUSD", "GOLD"),
        "XAGUSD": ("XAGUSD", "SILVER"),
        "USOIL": ("USOIL", "XTIUSD", "WTI"),
        "NAS100": ("NAS100", "USTEC", "US100", "NASDAQ"),
    }
    compact = "".join(character for character in upper if character.isalnum())
    for standard, candidates in aliases.items():
        if any(candidate in compact for candidate in candidates):
            return standard
    if original and original[-1:].islower() and len(original) > 6:
        original = original[:-1]
    return "".join(character for character in original.upper() if character.isalnum())


def iso_time(milliseconds, seconds):
    stamp = milliseconds / 1000 if milliseconds else seconds
    return datetime.fromtimestamp(stamp, timezone.utc).isoformat().replace("+00:00", "Z")


class Adapter:
    def __init__(self, terminal_path, expected_login, expected_server):
        self.terminal_path = terminal_path
        self.expected_login = str(expected_login or "")
        self.expected_server = expected_server or ""

    def connect(self):
        if not mt5.initialize(self.terminal_path, timeout=15000, portable=False):
            raise RuntimeError(f"MT5 initialize failed: {mt5.last_error()}")
        account = mt5.account_info()
        terminal = mt5.terminal_info()
        if account is None or terminal is None:
            raise RuntimeError(f"MT5 account unavailable: {mt5.last_error()}")
        if self.expected_login and str(account.login) != self.expected_login:
            raise RuntimeError(
                f"Selected Meridian login {self.expected_login} does not match terminal login {account.login}"
            )
        if self.expected_server and account.server != self.expected_server:
            raise RuntimeError(
                f"Selected Meridian server {self.expected_server} does not match terminal server {account.server}"
            )
        return account, terminal

    def account_snapshot(self):
        account, terminal = self.connect()
        return {
            "login_id": str(account.login),
            "server_name": account.server,
            "broker_company": account.company,
            "account_name": account.name,
            "currency": account.currency,
            "balance": account.balance,
            "equity": account.equity,
            "trade_allowed": bool(account.trade_allowed),
            "trade_expert": bool(account.trade_expert),
            "terminal_connected": bool(terminal.connected),
            "terminal_path": self.terminal_path,
            "adapter_mode": "read-only",
        }

    def closed_trades(self, date_from):
        account, _terminal = self.connect()
        start = datetime.fromisoformat(date_from.replace("Z", "+00:00"))
        deals = mt5.history_deals_get(start, datetime.now(timezone.utc))
        if deals is None:
            raise RuntimeError(f"MT5 history request failed: {mt5.last_error()}")

        positions = defaultdict(list)
        balance_events = []
        for deal in deals:
            if not deal.symbol:
                amount = float(deal.profit) + float(deal.commission) + float(deal.swap) + float(getattr(deal, "fee", 0.0))
                if amount:
                    balance_events.append({
                        "ticket_number": str(deal.ticket),
                        "occurred_at": iso_time(deal.time_msc, deal.time),
                        "amount": amount,
                        "kind": str(deal.type),
                        "comment": deal.comment or "",
                    })
                continue
            if deal.type not in (mt5.DEAL_TYPE_BUY, mt5.DEAL_TYPE_SELL):
                continue
            positions[int(deal.position_id)].append(deal)

        rows = []
        skipped_open = 0
        skipped_complex = 0
        for position_id, group in positions.items():
            group.sort(key=lambda deal: (deal.time_msc or deal.time * 1000, deal.ticket))
            entries = [deal for deal in group if deal.entry == mt5.DEAL_ENTRY_IN]
            exits = [
                deal
                for deal in group
                if deal.entry in (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY)
            ]
            if not entries or not exits:
                skipped_open += 1
                continue
            entry_volume = sum(float(deal.volume) for deal in entries)
            exit_volume = sum(float(deal.volume) for deal in exits)
            if entry_volume <= 0 or exit_volume + 1e-8 < entry_volume:
                skipped_open += 1
                continue
            if any(deal.entry == mt5.DEAL_ENTRY_INOUT for deal in group):
                skipped_complex += 1
                continue

            open_price = sum(float(deal.price) * float(deal.volume) for deal in entries) / entry_volume
            close_price = sum(float(deal.price) * float(deal.volume) for deal in exits) / exit_volume
            opening = entries[0]
            closing = exits[-1]
            net_pnl = sum(
                float(deal.profit)
                + float(deal.commission)
                + float(deal.swap)
                + float(getattr(deal, "fee", 0.0))
                for deal in group
            )
            rows.append(
                {
                    "ticket_number": f"{account.login}:{position_id}",
                    "broker_position_id": str(position_id),
                    "broker_symbol": opening.symbol,
                    "standard_symbol": canonical_symbol(opening.symbol),
                    "type": "BUY" if opening.type == mt5.DEAL_TYPE_BUY else "SELL",
                    "lot_size": entry_volume,
                    "open_price": open_price,
                    "close_price": close_price,
                    "open_time": iso_time(opening.time_msc, opening.time),
                    "close_time": iso_time(closing.time_msc, closing.time),
                    "net_pnl": net_pnl,
                    "pips": None,
                    "status": "WIN" if net_pnl > 0 else "LOSS" if net_pnl < 0 else "BE",
                    "setup_tags": "[]",
                    "mistake_tags": "[]",
                    "notes": "Synced from MetaTrader 5",
                }
            )
        rows.sort(key=lambda row: (row["close_time"], row["ticket_number"]))
        return {
            "login_id": str(account.login),
            "server_name": account.server,
            "current_balance": float(account.balance),
            "balance_events": balance_events,
            "trades": rows,
            "deal_count": len(deals),
            "skipped_open_positions": skipped_open,
            "skipped_complex_positions": skipped_complex,
        }

    def symbol_snapshot(self, params):
        account, _terminal = self.connect()
        symbol = params["symbol"]
        info = mt5.symbol_info(symbol)
        if info is None:
            raise RuntimeError(f"Symbol {symbol} is unavailable: {mt5.last_error()}")
        if not info.visible and not mt5.symbol_select(symbol, True):
            raise RuntimeError(f"Symbol {symbol} could not be selected: {mt5.last_error()}")
        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            raise RuntimeError(f"No tick for {symbol}: {mt5.last_error()}")
        return {
            "login_id": str(account.login),
            "server_name": account.server,
            "symbol": symbol,
            "bid": float(tick.bid),
            "ask": float(tick.ask),
            "timestamp": int(tick.time_msc),
            "volume_min": float(info.volume_min),
            "volume_max": float(info.volume_max),
            "volume_step": float(info.volume_step),
            "tick_size": float(info.trade_tick_size or info.point),
            "tick_value": float(info.trade_tick_value_loss or info.trade_tick_value),
            "stops_level": float(info.trade_stops_level * info.point),
        }

    def active_positions(self):
        account, _terminal = self.connect()
        positions = mt5.positions_get()
        if positions is None:
            raise RuntimeError(f"MT5 positions request failed: {mt5.last_error()}")
        rows = []
        for position in positions:
            info = mt5.symbol_info(position.symbol)
            tick = mt5.symbol_info_tick(position.symbol)
            point = float(info.point) if info and info.point else 0.0
            bid = float(tick.bid) if tick else 0.0
            ask = float(tick.ask) if tick else 0.0
            side = "BUY" if position.type == mt5.POSITION_TYPE_BUY else "SELL"
            current_price = bid if side == "BUY" else ask
            price_move = current_price - float(position.price_open)
            if side == "SELL":
                price_move *= -1
            spread_price = ask - bid if tick else 0.0
            rows.append({
                "position_id": str(position.ticket),
                "identifier": str(getattr(position, "identifier", position.ticket)),
                "symbol": position.symbol,
                "standard_symbol": canonical_symbol(position.symbol),
                "type": side,
                "lots": float(position.volume),
                "open_time": iso_time(getattr(position, "time_msc", 0), position.time),
                "entry": float(position.price_open),
                "current_price": current_price or float(position.price_current),
                "stop_loss": float(position.sl),
                "take_profit": float(position.tp),
                "profit": float(position.profit),
                "swap": float(position.swap),
                "current_pnl": float(position.profit) + float(position.swap),
                "points_pnl": price_move / point if point else None,
                "spread_price": spread_price,
                "spread_points": spread_price / point if point else None,
                "bid": bid,
                "ask": ask,
                "magic": int(position.magic),
                "comment": position.comment or "",
            })
        return {
            "login_id": str(account.login),
            "server_name": account.server,
            "currency": account.currency,
            "balance": float(account.balance),
            "equity": float(account.equity),
            "positions": rows,
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }

    def chart_snapshot(self, params):
        account, _terminal = self.connect()
        symbol = params["symbol"]
        timeframe_name = params.get("timeframe", "M15")
        timeframes = {
            "M1": mt5.TIMEFRAME_M1,
            "M5": mt5.TIMEFRAME_M5,
            "M15": mt5.TIMEFRAME_M15,
            "H1": mt5.TIMEFRAME_H1,
            "H4": mt5.TIMEFRAME_H4,
            "D1": mt5.TIMEFRAME_D1,
        }
        if timeframe_name not in timeframes:
            raise ValueError("Unsupported chart timeframe")
        if not mt5.symbol_select(symbol, True):
            raise RuntimeError(f"Symbol {symbol} could not be selected: {mt5.last_error()}")
        date_from = datetime.fromisoformat(params["date_from"].replace("Z", "+00:00"))
        date_to = datetime.fromisoformat(params["date_to"].replace("Z", "+00:00"))
        rates = mt5.copy_rates_range(symbol, timeframes[timeframe_name], date_from, date_to)
        if rates is None:
            raise RuntimeError(f"MT5 chart request failed: {mt5.last_error()}")
        candles = [
            {
                "time": int(rate["time"]),
                "open": float(rate["open"]),
                "high": float(rate["high"]),
                "low": float(rate["low"]),
                "close": float(rate["close"]),
                "volume": int(rate["tick_volume"]),
                "spread": int(rate["spread"]),
            }
            for rate in rates[-5000:]
        ]
        return {
            "login_id": str(account.login),
            "server_name": account.server,
            "symbol": symbol,
            "timeframe": timeframe_name,
            "candles": candles,
        }

    def fx_rate(self, params):
        account, _terminal = self.connect()
        base = (params.get("base") or account.currency).upper()
        quote = (params.get("quote") or "GHS").upper()
        candidates = mt5.symbols_get(group=f"*{base}{quote}*") or []
        inverse = False
        if not candidates:
            candidates = mt5.symbols_get(group=f"*{quote}{base}*") or []
            inverse = True
        if not candidates:
            raise RuntimeError(f"The broker does not expose a {base}/{quote} conversion symbol")
        symbol = candidates[0].name
        if not mt5.symbol_select(symbol, True):
            raise RuntimeError(f"Conversion symbol {symbol} could not be selected: {mt5.last_error()}")
        tick = mt5.symbol_info_tick(symbol)
        if tick is None or not tick.bid or not tick.ask:
            raise RuntimeError(f"No current conversion quote for {symbol}: {mt5.last_error()}")
        if inverse:
            bid = 1.0 / float(tick.ask)
            ask = 1.0 / float(tick.bid)
        else:
            bid = float(tick.bid)
            ask = float(tick.ask)
        return {
            "login_id": str(account.login),
            "server_name": account.server,
            "base": base,
            "quote": quote,
            "symbol": symbol,
            "bid": bid,
            "ask": ask,
            "timestamp": iso_time(int(tick.time_msc), int(tick.time)),
            "source": account.company,
        }

    def request(self, method, params):
        if method == "account.snapshot":
            return self.account_snapshot()
        if method == "history.closed-trades":
            return self.closed_trades(params.get("date_from", "2000-01-01T00:00:00Z"))
        if method == "symbol.snapshot":
            return self.symbol_snapshot(params)
        if method == "positions.active":
            return self.active_positions()
        if method == "chart.snapshot":
            return self.chart_snapshot(params)
        if method == "fx.rate":
            return self.fx_rate(params)
        if method in ("trade.place", "trade.close", "trade.status", "position.snapshot"):
            raise PermissionError("Meridian is permanently journal-only; trade execution is disabled")
        raise ValueError(f"Unsupported method: {method}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--terminal", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--expected-login", default="")
    parser.add_argument("--expected-server", default="")
    args = parser.parse_args()
    if len(args.token) < 32:
        raise SystemExit("Bridge token is too short")
    adapter = Adapter(args.terminal, args.expected_login, args.expected_server)
    snapshot = adapter.account_snapshot()

    def handler(websocket):
        authorization = websocket.request.headers.get("Authorization", "")
        if authorization != f"Bearer {args.token}":
            websocket.close(1008, "Unauthorized")
            return
        for raw in websocket:
            request_id = None
            try:
                request = json.loads(raw)
                request_id = request.get("id")
                result = adapter.request(request.get("method"), request.get("params") or {})
                websocket.send(json.dumps({"id": request_id, "result": result}))
            except PermissionError as error:
                websocket.send(
                    json.dumps(
                        {"id": request_id, "error": {"code": "10017", "message": str(error)}}
                    )
                )
            except Exception as error:
                websocket.send(
                    json.dumps(
                        {"id": request_id, "error": {"code": "BRIDGE_ERROR", "message": str(error)}}
                    )
                )

    with serve(handler, "127.0.0.1", args.port, max_size=1024 * 1024) as server:
        port = server.socket.getsockname()[1]
        emit({"event": "ready", "port": port, "account": snapshot})
        server.serve_forever()


if __name__ == "__main__":
    signal.signal(signal.SIGINT, lambda *_args: sys.exit(0))
    main()
