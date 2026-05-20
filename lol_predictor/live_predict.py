from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import pandas as pd

from .live_collect import DEFAULT_API_BASE
from .live_features import live_feature_row


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a trained live win-probability model on a live-event snapshot.")
    parser.add_argument("--model-path", type=Path, default=Path("models/live_win_probability.joblib"))
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input", type=Path, help="A JSON or JSONL snapshot collected by live_collect.")
    source.add_argument("--event-id", help="Fetch this event id from the live-event API before predicting.")
    parser.add_argument("--api-base", default=DEFAULT_API_BASE)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    import joblib

    bundle = joblib.load(args.model_path)
    details = load_details(args)
    game = active_game(details)
    if not game:
        raise SystemExit("No active game found in live snapshot.")
    live = game.get("live") or {}
    row = live_feature_row(
        live=live,
        event_id=str(details.get("id") or ""),
        game=game,
        league=str(details.get("league") or ""),
        best_of=str(details.get("best_of") or ""),
    )
    if not row:
        raise SystemExit("No usable live frame found in live snapshot.")
    cols = bundle["feature_columns"]
    frame = pd.DataFrame([row])
    for col in cols:
        if col not in frame.columns:
            frame[col] = None
    probability = float(bundle["pipeline"].predict_proba(frame[cols])[:, 1][0])
    result = {
        "event_id": details.get("id"),
        "game_id": game.get("id"),
        "blue": game.get("blue"),
        "red": game.get("red"),
        "blue_win_probability": probability,
        "red_win_probability": 1 - probability,
        "model_path": str(args.model_path),
        "feature_schema": bundle.get("feature_schema", "live_frame_v1"),
        "features": {col: row.get(col) for col in cols if col in row},
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


def load_details(args: argparse.Namespace) -> dict[str, Any]:
    if args.event_id:
        url = f"{args.api_base}{'&' if '?' in args.api_base else '?'}{urlencode({'id': args.event_id})}"
        request = Request(url, headers={"accept": "application/json", "user-agent": "lol-predictor-live-predict/1.0"})
        with urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    payload = load_snapshot(args.input)
    return payload.get("details") if isinstance(payload.get("details"), dict) else payload


def load_snapshot(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return {}
    if "\n" in text:
        text = text.splitlines()[-1]
    return json.loads(text)


def active_game(details: dict[str, Any]) -> dict[str, Any]:
    games = [game for game in details.get("games") or [] if isinstance(game, dict)]
    for game in games:
        if str(game.get("state") or "").lower() == "inprogress":
            return game
    for game in games:
        live = game.get("live") or {}
        if live.get("status") == "in_game":
            return game
    for game in games:
        if has_live_frame(game.get("live") or {}):
            return game
    return games[0] if games else {}


def has_live_frame(live: dict[str, Any]) -> bool:
    if not isinstance(live, dict):
        return False
    if live.get("frame_timestamp"):
        return True
    if live.get("blue") or live.get("red"):
        return True
    return bool(live.get("blue_stats") or live.get("red_stats"))


if __name__ == "__main__":
    main()
