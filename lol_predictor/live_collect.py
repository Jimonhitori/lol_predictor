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
DEFAULT_MATCHES_URL = "https://lol-predictor.pages.dev/static/data/matches-all__all.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Collect normalized live-event snapshots into JSONL.")
    parser.add_argument("--event-id", action="append", default=[], help="LoL Esports event id, not game id. Repeatable.")
    parser.add_argument("--auto-current", action="store_true", help="Collect matches whose schedule window says they are current or about to start.")
    parser.add_argument("--matches-url", default=DEFAULT_MATCHES_URL)
    parser.add_argument("--league", action="append", dest="leagues", help="Limit --auto-current to this league label/code. Repeatable.")
    parser.add_argument("--region", default="", help="Limit --auto-current to this region bucket.")
    parser.add_argument("--started-within-hours", type=float, default=8.0)
    parser.add_argument("--starts-within-hours", type=float, default=2.0)
    parser.add_argument("--output", type=Path, default=Path("data/live_snapshots/live_events.jsonl"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/live_snapshots"))
    parser.add_argument("--api-base", default=DEFAULT_API_BASE)
    parser.add_argument("--interval-seconds", type=float, default=20.0)
    parser.add_argument("--duration-minutes", type=float, default=0.0, help="0 means one snapshot unless --max-snapshots is set.")
    parser.add_argument("--max-snapshots", type=int, default=1)
    parser.add_argument("--only-new-frame", action="store_true", help="Skip appending when the active frame timestamp did not change.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    event_ids = list(dict.fromkeys(args.event_id + (current_event_ids(args) if args.auto_current else [])))
    if not event_ids:
        raise SystemExit("No event ids to collect. Pass --event-id or --auto-current.")
    output_paths = output_paths_for_events(args, event_ids)
    for output in set(output_paths.values()):
        output.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + args.duration_minutes * 60 if args.duration_minutes > 0 else None
    max_snapshots = args.max_snapshots if args.max_snapshots > 0 else None
    snapshots = 0
    last_snapshots: dict[str, str] = {}

    while True:
        for event_id in event_ids:
            details = fetch_live_event(args.api_base, event_id)
            record = {
                "collected_at": datetime.now(timezone.utc).isoformat(),
                "event_id": event_id,
                "source_url": live_event_url(args.api_base, event_id),
                "details": details,
            }
            snapshot_key = active_snapshot_key(details)
            if not args.only_new_frame or snapshot_key != last_snapshots.get(event_id, ""):
                append_jsonl(output_paths[event_id], record)
                snapshots += 1
                last_snapshots[event_id] = snapshot_key
                print(snapshot_summary(record))
            else:
                print(f"Skipped unchanged snapshot: {event_id} {snapshot_key}")
            if max_snapshots is not None and snapshots >= max_snapshots:
                break

        if max_snapshots is not None and snapshots >= max_snapshots:
            break
        if deadline is not None and time.monotonic() >= deadline:
            break
        time.sleep(max(1.0, args.interval_seconds))


def current_event_ids(args: argparse.Namespace) -> list[str]:
    payload = fetch_json(args.matches_url)
    matches = payload.get("matches") or []
    now = datetime.now(timezone.utc)
    lower = now.timestamp() - args.started_within_hours * 3600
    upper = now.timestamp() + args.starts_within_hours * 3600
    result: list[str] = []
    for match in matches:
        if not isinstance(match, dict):
            continue
        if args.leagues and not any(same_label(match.get("league"), league) for league in args.leagues):
            continue
        if args.region and not same_label(match.get("region"), args.region):
            continue
        status = str(match.get("status") or "").lower()
        if status in {"completed", "complete"}:
            continue
        start_time = parse_time(match.get("start_time"))
        if start_time is None:
            continue
        if lower <= start_time.timestamp() <= upper:
            event_id = str(match.get("id") or "")
            if event_id:
                result.append(event_id)
    return result


def fetch_live_event(api_base: str, event_id: str) -> dict[str, Any]:
    url = live_event_url(api_base, event_id)
    return fetch_json(url, event_id=event_id)


def fetch_json(url: str, event_id: str = "") -> dict[str, Any]:
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


def output_paths_for_events(args: argparse.Namespace, event_ids: list[str]) -> dict[str, Path]:
    if len(event_ids) == 1 and args.output:
        return {event_ids[0]: args.output}
    return {event_id: args.output_dir / f"live_event_{event_id}.jsonl" for event_id in event_ids}


def active_frame_timestamp(details: dict[str, Any]) -> str:
    live = active_live(details)
    return str(live.get("frame_timestamp") or "")


def active_snapshot_key(details: dict[str, Any]) -> str:
    active_game = active_game_details(details)
    live = (active_game.get("live") if active_game else {}) or {}
    frame = str(live.get("frame_timestamp") or "")
    if frame:
        return frame
    return "|".join(
        [
            str(active_game.get("id") if active_game else ""),
            str(active_game.get("state") if active_game else ""),
            str(live.get("status") or ""),
            str(live.get("warning") or ""),
        ]
    )


def active_live(details: dict[str, Any]) -> dict[str, Any]:
    active_game = active_game_details(details)
    return (active_game.get("live") if active_game else {}) or {}


def active_game_details(details: dict[str, Any]) -> dict[str, Any]:
    games = [game for game in details.get("games") or [] if isinstance(game, dict)]
    for game in games:
        if str(game.get("state") or "").lower() == "inprogress":
            return game
    for game in games:
        live = game.get("live") or {}
        if live.get("status") == "in_game":
            return game
    return games[0] if games else {}


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


def parse_time(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def same_label(left: Any, right: Any) -> bool:
    return normalize_label(left) == normalize_label(right)


def normalize_label(value: Any) -> str:
    return "".join(char.lower() for char in str(value or "") if char.isalnum())


if __name__ == "__main__":
    main()
