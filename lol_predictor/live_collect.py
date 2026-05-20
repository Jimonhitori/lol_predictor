from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


DEFAULT_API_BASE = "https://lol-predictor.pages.dev/api/live-event"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Collect normalized live-event snapshots into JSONL.")
    parser.add_argument("--event-id", required=True, help="LoL Esports event id, not game id.")
    parser.add_argument("--output", type=Path, default=Path("data/live_snapshots/live_events.jsonl"))
    parser.add_argument("--api-base", default=DEFAULT_API_BASE)
    parser.add_argument("--interval-seconds", type=float, default=20.0)
    parser.add_argument("--duration-minutes", type=float, default=0.0, help="0 means one snapshot unless --max-snapshots is set.")
    parser.add_argument("--max-snapshots", type=int, default=1)
    parser.add_argument("--only-new-frame", action="store_true", help="Skip appending when the active frame timestamp did not change.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + args.duration_minutes * 60 if args.duration_minutes > 0 else None
    max_snapshots = args.max_snapshots if args.max_snapshots > 0 else None
    snapshots = 0
    last_frame = ""

    while True:
        details = fetch_live_event(args.api_base, args.event_id)
        record = {
            "collected_at": datetime.now(timezone.utc).isoformat(),
            "event_id": args.event_id,
            "source_url": live_event_url(args.api_base, args.event_id),
            "details": details,
        }
        frame = active_frame_timestamp(details)
        if not args.only_new_frame or not frame or frame != last_frame:
            append_jsonl(args.output, record)
            snapshots += 1
            last_frame = frame
            print(snapshot_summary(record))
        else:
            print(f"Skipped unchanged frame: {frame}")

        if max_snapshots is not None and snapshots >= max_snapshots:
            break
        if deadline is not None and time.monotonic() >= deadline:
            break
        time.sleep(max(1.0, args.interval_seconds))


def fetch_live_event(api_base: str, event_id: str) -> dict[str, Any]:
    url = live_event_url(api_base, event_id)
    request = Request(url, headers={"accept": "application/json", "user-agent": "lol-predictor-live-collector/1.0"})
    try:
        with urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except (OSError, URLError, json.JSONDecodeError) as error:
        return {
            "id": event_id,
            "status": "unavailable",
            "teams": [],
            "games": [],
            "warning": f"collect_fetch_failed: {error}",
        }


def live_event_url(api_base: str, event_id: str) -> str:
    separator = "&" if "?" in api_base else "?"
    return f"{api_base}{separator}{urlencode({'id': event_id})}"


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")


def active_frame_timestamp(details: dict[str, Any]) -> str:
    live = active_live(details)
    return str(live.get("frame_timestamp") or "")


def active_live(details: dict[str, Any]) -> dict[str, Any]:
    games = [game for game in details.get("games") or [] if isinstance(game, dict)]
    for game in games:
        if str(game.get("state") or "").lower() == "inprogress":
            return game.get("live") or {}
    for game in games:
        live = game.get("live") or {}
        if live.get("status") == "in_game":
            return live
    return (games[0].get("live") if games else {}) or {}


def snapshot_summary(record: dict[str, Any]) -> str:
    details = record.get("details") or {}
    teams = details.get("teams") or []
    left = team_label(teams[0] if len(teams) > 0 else {})
    right = team_label(teams[1] if len(teams) > 1 else {})
    live = active_live(details)
    probability = live.get("win_probability") or {}
    blue = probability.get("blue")
    probability_text = f" blue={float(blue) * 100:.1f}%" if isinstance(blue, (int, float)) else ""
    frame = live.get("frame_timestamp") or "-"
    return f"Saved {record.get('event_id')} {left} vs {right} status={details.get('status')} frame={frame}{probability_text}"


def team_label(team: dict[str, Any]) -> str:
    return str(team.get("code") or team.get("name") or "-")


if __name__ == "__main__":
    main()
