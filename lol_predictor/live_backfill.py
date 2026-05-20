from __future__ import annotations

import argparse
import json
from copy import deepcopy
import csv
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


EVENT_DETAILS_URL = "https://esports-api.lolesports.com/persisted/gw/getEventDetails"
LIVE_WINDOW_URL = "https://feed.lolesports.com/livestats/v1/window/{game_id}"
LIVE_DETAILS_URL = "https://feed.lolesports.com/livestats/v1/details/{game_id}"
DEFAULT_LOLESPORTS_API_KEY = "0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill completed LoL Esports livestats frames into training JSONL.")
    parser.add_argument("--event-id", action="append", default=[], help="LoL Esports event id. Repeatable.")
    parser.add_argument("--event-ids-from-labels", action="store_true", help="Backfill every event_id present in --labels.")
    parser.add_argument("--output-dir", type=Path, default=Path("data/live_snapshots/backfill"))
    parser.add_argument("--interval-seconds", type=int, default=30)
    parser.add_argument("--api-key", default=DEFAULT_LOLESPORTS_API_KEY)
    parser.add_argument("--labels", type=Path, help="Optional CSV with game_id,winner or game_id,blue_win columns.")
    parser.add_argument("--include-unlabeled", action="store_true", help="Save frames even when game winner cannot be inferred.")
    parser.add_argument("--max-frames-per-game", type=int, default=0)
    parser.add_argument("--overwrite", action="store_true", help="Replace an existing output JSONL before writing.")
    parser.add_argument("--skip-details", action="store_true", help="Skip livestats details calls for faster deep backfills.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    labels = load_labels(args.labels) if args.labels else {}
    label_metadata = load_label_metadata(args.labels) if args.labels else {}
    event_ids = list(args.event_id)
    if args.event_ids_from_labels:
        if not args.labels:
            raise SystemExit("--event-ids-from-labels requires --labels.")
        event_ids.extend(load_label_event_ids(args.labels))
    event_ids = list(dict.fromkeys(str(event_id) for event_id in event_ids if str(event_id)))
    if not event_ids:
        raise SystemExit("No event ids to backfill. Pass --event-id or --event-ids-from-labels with --labels.")
    for event_id in event_ids:
        event = fetch_event(event_id, args.api_key)
        details = normalize_event(event)
        apply_labels(details, labels)
        output = args.output_dir / f"live_backfill_{details['id'] or event_id}.jsonl"
        if args.overwrite and output.exists():
            output.unlink()
        saved = 0
        skipped_unlabeled = 0
        for game in details["games"]:
            if not game.get("id") or str(game.get("state") or "").lower() == "unstarted":
                continue
            if not game.get("winner") and not args.include_unlabeled:
                skipped_unlabeled += 1
                continue
            windows = sampled_live_windows(
                str(game["id"]),
                args.interval_seconds,
                args.max_frames_per_game,
                starting_time_for_game(str(game["id"]), label_metadata),
                skip_details=args.skip_details,
            )
            game_start = label_source_time_for_game(str(game["id"]), label_metadata)
            for metadata, frame, details_frame in windows:
                record_details = deepcopy(details)
                record_game = next(item for item in record_details["games"] if item["id"] == game["id"])
                live = normalize_live_frame(metadata, frame)
                apply_observed_game_time(live, game_start)
                merge_live_details(live, details_frame)
                record_game["live"] = live
                append_jsonl(
                    output,
                    {
                        "collected_at": datetime.now(timezone.utc).isoformat(),
                        "event_id": record_details["id"],
                        "backfilled": True,
                        "details": record_details,
                    },
                )
                saved += 1
        print(f"{event_id}: saved_frames={saved} skipped_unlabeled_games={skipped_unlabeled} output={output}")


def fetch_event(event_id: str, api_key: str) -> dict[str, Any]:
    url = f"{EVENT_DETAILS_URL}?{urlencode({'hl': 'en-US', 'id': event_id})}"
    payload = fetch_json(url, headers={"x-api-key": api_key, "accept": "application/json"})
    event = payload.get("data", {}).get("event")
    if not isinstance(event, dict):
        raise SystemExit(f"Event details not found for {event_id}")
    return event


def fetch_json(url: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
    request_headers = {"accept": "application/json", "user-agent": "lol-predictor-live-backfill/1.0"}
    if headers:
        request_headers.update(headers)
    request = Request(url, headers=request_headers)
    try:
        with urlopen(request, timeout=30) as response:
            if getattr(response, "status", 200) == 204:
                return {}
            return json.loads(response.read().decode("utf-8"))
    except (HTTPError, OSError, URLError, json.JSONDecodeError):
        return {}


def normalize_event(event: dict[str, Any]) -> dict[str, Any]:
    match = event.get("match") or {}
    teams = [team for team in match.get("teams") or [] if isinstance(team, dict)]
    team_by_id = {str(team.get("id") or ""): team for team in teams}
    league = event.get("league") or {}
    best_of = str((match.get("strategy") or {}).get("count") or "")
    return {
        "id": str(event.get("id") or match.get("id") or ""),
        "league": str(league.get("name") or ""),
        "league_group": "",
        "region": "",
        "best_of": best_of,
        "status": str(event.get("state") or ""),
        "start_time": str(event.get("startTime") or ""),
        "teams": [normalize_team(team) for team in teams],
        "games": [normalize_game(game, team_by_id) for game in match.get("games") or [] if isinstance(game, dict)],
        "source": "lolesports_live_backfill",
    }


def load_labels(path: Path) -> dict[str, str]:
    labels: dict[str, str] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            game_id = str(row.get("game_id") or row.get("id") or "").strip()
            if not game_id:
                continue
            if row.get("winner"):
                labels[game_id] = str(row["winner"]).strip()
            elif row.get("blue_win") not in (None, ""):
                labels[game_id] = "blue" if str(row["blue_win"]).strip() in {"1", "true", "True", "TRUE"} else "red"
    return labels


def load_label_metadata(path: Path) -> dict[str, dict[str, str]]:
    metadata: dict[str, dict[str, str]] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            game_id = str(row.get("game_id") or row.get("id") or "").strip()
            if not game_id:
                continue
            metadata[game_id] = {key: str(value or "") for key, value in row.items()}
    return metadata


def load_label_event_ids(path: Path) -> list[str]:
    event_ids: list[str] = []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            event_id = str(row.get("event_id") or "").strip()
            if event_id:
                event_ids.append(event_id)
    return list(dict.fromkeys(event_ids))


def starting_time_for_game(game_id: str, label_metadata: dict[str, dict[str, str]]) -> str:
    parsed = label_source_time_for_game(game_id, label_metadata)
    if parsed is None:
        return ""
    return feed_starting_time(parsed)


def label_source_time_for_game(game_id: str, label_metadata: dict[str, dict[str, str]]) -> datetime | None:
    source_date = (label_metadata.get(game_id) or {}).get("source_date") or ""
    return parse_time(source_date)


def feed_starting_time(value: datetime) -> str:
    value = value.astimezone(timezone.utc)
    timestamp = int(value.timestamp())
    if timestamp % 10:
        timestamp += 10 - (timestamp % 10)
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def live_feed_url(template: str, game_id: str, starting_time: str = "") -> str:
    url = template.format(game_id=game_id)
    if not starting_time:
        return url
    separator = "&" if "?" in url else "?"
    return f"{url}{separator}{urlencode({'startingTime': starting_time})}"


def apply_labels(details: dict[str, Any], labels: dict[str, str]) -> None:
    if not labels:
        return
    for game in details.get("games") or []:
        if not isinstance(game, dict):
            continue
        label = labels.get(str(game.get("id") or ""))
        if not label:
            continue
        if label.lower() == "blue":
            game["winner"] = str((game.get("blue") or {}).get("team_code") or (game.get("blue") or {}).get("team_name") or "")
        elif label.lower() == "red":
            game["winner"] = str((game.get("red") or {}).get("team_code") or (game.get("red") or {}).get("team_name") or "")
        else:
            game["winner"] = label


def normalize_team(team: dict[str, Any]) -> dict[str, str]:
    result = team.get("result") or {}
    return {
        "id": str(team.get("id") or ""),
        "name": str(team.get("name") or ""),
        "code": str(team.get("code") or ""),
        "image": str(team.get("image") or ""),
        "game_wins": str(result.get("gameWins") or "0"),
    }


def normalize_game(game: dict[str, Any], team_by_id: dict[str, dict[str, Any]]) -> dict[str, Any]:
    sides: dict[str, dict[str, str]] = {}
    winner = winner_value(game)
    for team in game.get("teams") or []:
        if not isinstance(team, dict):
            continue
        source = team_by_id.get(str(team.get("id") or ""), {})
        result = team.get("result") or {}
        if team.get("winner") is True or result.get("winner") is True or str(result.get("outcome") or "").lower() == "win":
            winner = str(source.get("code") or source.get("name") or team.get("id") or winner)
        sides[str(team.get("side") or "").lower()] = {
            "team_id": str(team.get("id") or ""),
            "team_name": str(source.get("name") or ""),
            "team_code": str(source.get("code") or ""),
        }
    return {
        "id": str(game.get("id") or ""),
        "number": int(game.get("number") or 0),
        "state": str(game.get("state") or ""),
        "blue": sides.get("blue", {}),
        "red": sides.get("red", {}),
        "winner": winner,
        "live": {},
    }


def winner_value(game: dict[str, Any]) -> str:
    winner = game.get("winner") or game.get("winner_team") or game.get("winnerTeam") or game.get("winningTeam") or game.get("winningTeamId")
    if isinstance(winner, dict):
        return str(winner.get("code") or winner.get("name") or winner.get("id") or "")
    return str(winner or "")


def sampled_live_windows(
    game_id: str,
    interval_seconds: int,
    max_frames: int,
    starting_time_hint: str = "",
    *,
    skip_details: bool = False,
) -> list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]]:
    selected: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]] = []
    interval_seconds = max(1, interval_seconds)
    max_iterations = max_frames if max_frames > 0 else 180
    starting_time = starting_time_hint
    seen_timestamps: set[str] = set()
    empty_windows = 0
    for _ in range(max_iterations):
        window_start = parse_time(starting_time)
        window = fetch_json(live_feed_url(LIVE_WINDOW_URL, game_id, starting_time))
        frames = [frame for frame in window.get("frames") or [] if isinstance(frame, dict) and frame.get("rfc460Timestamp")]
        if not frames and starting_time:
            empty_windows += 1
            if empty_windows >= 2:
                break
            starting_time = ""
            continue
        if not frames:
            break
        frame = frames[-1]
        timestamp = str(frame.get("rfc460Timestamp") or "")
        if timestamp in seen_timestamps:
            break
        details_by_timestamp = {}
        if not skip_details:
            details_payload = fetch_json(live_feed_url(LIVE_DETAILS_URL, game_id, starting_time))
            details_by_timestamp = details_frames_by_timestamp(details_payload)
        selected.append((window.get("gameMetadata") or {}, frame, details_by_timestamp.get(timestamp, {})))
        seen_timestamps.add(timestamp)
        if max_frames > 0 and len(selected) >= max_frames:
            break
        if str(frame.get("gameState") or "").lower() in {"finished", "completed", "complete"}:
            break
        parsed = parse_time(timestamp)
        if parsed is None:
            break
        next_start = (window_start or parsed) + timedelta(seconds=interval_seconds)
        if next_start <= parsed:
            next_start = parsed + timedelta(seconds=1)
        starting_time = feed_starting_time(next_start)
    return selected


def normalize_live_frame(metadata: dict[str, Any], frame: dict[str, Any]) -> dict[str, Any]:
    blue_frame = frame.get("blueTeam") or {}
    red_frame = frame.get("redTeam") or {}
    return {
        "game_state": str(frame.get("gameState") or ""),
        "game_time": int(frame.get("gameTime") or 0),
        "frame_timestamp": str(frame.get("rfc460Timestamp") or ""),
        "patch_version": str(metadata.get("patchVersion") or ""),
        "blue": live_participants(metadata.get("blueTeamMetadata") or {}, blue_frame),
        "red": live_participants(metadata.get("redTeamMetadata") or {}, red_frame),
        "blue_stats": live_team_stats(blue_frame),
        "red_stats": live_team_stats(red_frame),
        "source": "lolesports_livestats_backfill",
    }


def apply_observed_game_time(live: dict[str, Any], game_start: datetime | None) -> None:
    if int(live.get("game_time") or 0) > 0 or game_start is None:
        return
    frame_time = parse_time(live.get("frame_timestamp"))
    if frame_time is None:
        return
    elapsed = int(max(0, (frame_time - game_start).total_seconds()))
    live["game_time"] = elapsed


def live_participants(team_metadata: dict[str, Any], team_frame: dict[str, Any]) -> list[dict[str, Any]]:
    participants = team_metadata.get("participantMetadata") if isinstance(team_metadata, dict) else []
    frame_participants = team_frame.get("participants") if isinstance(team_frame, dict) else []
    stats_by_id = {
        str(participant.get("participantId")): participant
        for participant in (frame_participants or [])
        if isinstance(participant, dict)
    }
    result: list[dict[str, Any]] = []
    for participant in participants or []:
        if not isinstance(participant, dict):
            continue
        stats = stats_by_id.get(str(participant.get("participantId")), {})
        result.append(
            {
                "player": str(participant.get("summonerName") or participant.get("name") or ""),
                "participant_id": str(participant.get("participantId") or ""),
                "champion": str(participant.get("championName") or participant.get("championId") or ""),
                "champion_id": str(participant.get("championId") or ""),
                "role": str(participant.get("role") or ""),
                "level": int(stats.get("level") or 0),
                "kills": int(stats.get("kills") or 0),
                "deaths": int(stats.get("deaths") or 0),
                "assists": int(stats.get("assists") or 0),
                "creep_score": int(stats.get("creepScore") or 0),
                "gold": int(stats.get("totalGold") or stats.get("totalGoldEarned") or 0),
                "current_health": int(stats.get("currentHealth") or 0),
                "max_health": int(stats.get("maxHealth") or 0),
                "items": live_items(stats.get("items") or []),
            }
        )
    return result


def details_frames_by_timestamp(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    frames = payload.get("frames") if isinstance(payload, dict) else []
    return {
        str(frame.get("rfc460Timestamp") or ""): frame
        for frame in (frames or [])
        if isinstance(frame, dict) and frame.get("rfc460Timestamp")
    }


def merge_live_details(live: dict[str, Any], frame: dict[str, Any]) -> None:
    participants = frame.get("participants") if isinstance(frame, dict) else []
    details_by_id = {
        str(participant.get("participantId")): participant
        for participant in (participants or [])
        if isinstance(participant, dict)
    }
    for player in list(live.get("blue") or []) + list(live.get("red") or []):
        details = details_by_id.get(str(player.get("participant_id") or ""))
        if not details:
            continue
        player["level"] = int(details.get("level") or player.get("level") or 0)
        player["kills"] = int(details.get("kills") or player.get("kills") or 0)
        player["deaths"] = int(details.get("deaths") or player.get("deaths") or 0)
        player["assists"] = int(details.get("assists") or player.get("assists") or 0)
        player["creep_score"] = int(details.get("creepScore") or player.get("creep_score") or 0)
        player["gold"] = int(details.get("totalGoldEarned") or player.get("gold") or 0)
        player["items"] = live_items(details.get("items") or player.get("items") or [])


def live_team_stats(team_frame: dict[str, Any]) -> dict[str, Any]:
    return {
        "gold": int(team_frame.get("totalGold") or 0),
        "kills": int(team_frame.get("totalKills") or 0),
        "towers": int(team_frame.get("towers") or 0),
        "inhibitors": int(team_frame.get("inhibitors") or 0),
        "barons": int(team_frame.get("barons") or 0),
        "dragons": len(team_frame.get("dragons") or []),
    }


def live_items(items: list[Any]) -> list[str]:
    result = []
    for item in items if isinstance(items, list) else []:
        if isinstance(item, dict):
            item_id = str(item.get("itemID") or item.get("itemId") or item.get("id") or "")
        else:
            item_id = str(item or "")
        if item_id:
            result.append(item_id)
    return result[:7]


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")


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


if __name__ == "__main__":
    main()
