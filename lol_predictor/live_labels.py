from __future__ import annotations

import argparse
import csv
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from typing import Any, Iterable


DEFAULT_SCHEDULE = Path("docs/static/data/matches-all__all.json")
DEFAULT_MATCH_DIR = Path("docs/static/data/matches")
LOLESPORTS_SCHEDULE_URL = "https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=en-US"
LOLESPORTS_EVENT_DETAILS_URL = "https://esports-api.lolesports.com/persisted/gw/getEventDetails"
DEFAULT_LOLESPORTS_API_KEY = "0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z"


@dataclass(frozen=True)
class OracleGame:
    game_id: str
    league: str
    date: datetime
    game_number: str
    blue_team: str
    red_team: str
    winner: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate LoL Esports game labels from Oracle's Elixir team result rows."
    )
    parser.add_argument("--event-id", action="append", default=[], help="LoL Esports event id. Repeatable.")
    parser.add_argument("--discover-schedule", action="store_true", help="Discover completed event ids from LoL Esports schedule pages.")
    parser.add_argument("--output", type=Path, required=True, help="CSV path to write game_id,winner,blue_win labels.")
    parser.add_argument("--schedule-json", type=Path, default=DEFAULT_SCHEDULE)
    parser.add_argument("--schedule-pages", type=int, default=8, help="LoL Esports schedule pages to scan when --discover-schedule is set.")
    parser.add_argument("--match-dir", type=Path, default=DEFAULT_MATCH_DIR)
    parser.add_argument(
        "--data-dir",
        action="append",
        type=Path,
        default=[],
        help="Directory containing Oracle's Elixir CSV files. Repeatable.",
    )
    parser.add_argument("--oe-csv", action="append", type=Path, default=[], help="Specific Oracle's Elixir CSV file.")
    parser.add_argument("--api-key", default=DEFAULT_LOLESPORTS_API_KEY)
    parser.add_argument("--league", action="append", dest="leagues", help="Limit discovered schedule events to a league. Repeatable.")
    parser.add_argument("--max-hours", type=float, default=36.0, help="Maximum time after schedule start to match games.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    schedules = load_schedule(args.schedule_json)
    if args.discover_schedule:
        discovered = discover_schedule(args.api_key, args.schedule_pages, args.leagues)
        schedules.update(discovered)
    event_ids = list(dict.fromkeys(args.event_id + list(schedules if args.discover_schedule else [])))
    if not event_ids:
        raise SystemExit("No event ids to label. Pass --event-id or --discover-schedule.")
    oe_games = load_oracle_games(oracle_csv_paths(args.data_dir, args.oe_csv))
    rows: list[dict[str, str]] = []
    for event_id in event_ids:
        schedule = schedules.get(event_id, {})
        if schedule and not event_has_oracle_candidates(schedule, oe_games, args.max_hours):
            continue
        match = load_match(args.match_dir, event_id) or fetch_event_match(event_id, args.api_key)
        if not match:
            print(f"{event_id}: labels=0 event_details_missing")
            continue
        event_rows = label_event(event_id, match, schedule, oe_games, args.max_hours)
        rows.extend(event_rows)
        print(f"{event_id}: labels={len(event_rows)}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    write_labels(args.output, rows)
    print(f"wrote {len(rows)} labels to {args.output}")


def load_schedule(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    matches = payload.get("matches") if isinstance(payload, dict) else payload
    result: dict[str, dict[str, Any]] = {}
    for match in matches or []:
        if isinstance(match, dict) and match.get("id"):
            result[str(match["id"])] = match
    return result


def load_match(match_dir: Path, event_id: str) -> dict[str, Any]:
    path = match_dir / f"{event_id}.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def discover_schedule(api_key: str, max_pages: int, leagues: list[str] | None) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    page_token = ""
    seen_tokens: set[str] = set()
    for _ in range(max(1, max_pages)):
        payload = fetch_schedule_page(api_key, page_token)
        schedule = payload.get("data", {}).get("schedule", {}) if isinstance(payload, dict) else {}
        for event in schedule.get("events") or []:
            if not isinstance(event, dict) or event.get("type") != "match":
                continue
            league = str((event.get("league") or {}).get("name") or "")
            if leagues and not any(same_label(league, wanted) for wanted in leagues):
                continue
            if str(event.get("state") or "").lower() not in {"completed", "complete"}:
                continue
            match = event.get("match") or {}
            event_id = str(match.get("id") or event.get("id") or "")
            if not event_id:
                continue
            teams = match.get("teams") or []
            blue, red = team_pair(teams)
            if not blue or not red or "tbd" in {blue.lower(), red.lower()}:
                continue
            result[event_id] = {
                "id": event_id,
                "league": league,
                "start_time": str(event.get("startTime") or ""),
                "status": str(event.get("state") or ""),
                "blue_team": blue,
                "red_team": red,
                "best_of": str((match.get("strategy") or {}).get("count") or ""),
                "source": "lolesports_schedule",
            }
        older = str((schedule.get("pages") or {}).get("older") or "")
        if not older or older in seen_tokens:
            break
        seen_tokens.add(older)
        page_token = older
    return result


def fetch_schedule_page(api_key: str, page_token: str = "") -> dict[str, Any]:
    url = LOLESPORTS_SCHEDULE_URL
    if page_token:
        separator = "&" if "?" in url else "?"
        url = f"{url}{separator}{urlencode({'pageToken': page_token})}"
    return fetch_json(url, api_key)


def fetch_event_match(event_id: str, api_key: str) -> dict[str, Any]:
    url = f"{LOLESPORTS_EVENT_DETAILS_URL}?{urlencode({'hl': 'en-US', 'id': event_id})}"
    payload = fetch_json(url, api_key)
    event = payload.get("data", {}).get("event") if isinstance(payload, dict) else {}
    if not isinstance(event, dict):
        return {}
    return normalize_event(event)


def fetch_json(url: str, api_key: str) -> dict[str, Any]:
    request = Request(
        url,
        headers={
            "x-api-key": api_key,
            "accept": "application/json",
            "user-agent": "lol-predictor-live-labels/1.0",
        },
    )
    try:
        with urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except (HTTPError, OSError, URLError, json.JSONDecodeError):
        return {}


def normalize_event(event: dict[str, Any]) -> dict[str, Any]:
    match = event.get("match") or {}
    teams = [team for team in match.get("teams") or [] if isinstance(team, dict)]
    team_by_id = {str(team.get("id") or ""): team for team in teams}
    league = event.get("league") or {}
    return {
        "id": str(match.get("id") or event.get("id") or ""),
        "league": str(league.get("name") or ""),
        "start_time": str(event.get("startTime") or ""),
        "teams": [
            {
                "id": str(team.get("id") or ""),
                "name": str(team.get("name") or ""),
                "code": str(team.get("code") or ""),
            }
            for team in teams
        ],
        "games": [normalize_game(game, team_by_id) for game in match.get("games") or [] if isinstance(game, dict)],
    }


def normalize_game(game: dict[str, Any], team_by_id: dict[str, dict[str, Any]]) -> dict[str, Any]:
    sides: dict[str, dict[str, str]] = {}
    for team in game.get("teams") or []:
        if not isinstance(team, dict):
            continue
        source = team_by_id.get(str(team.get("id") or ""), {})
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
    }


def oracle_csv_paths(data_dirs: Iterable[Path], explicit: Iterable[Path]) -> list[Path]:
    paths: list[Path] = []
    for path in explicit:
        if path.exists():
            paths.append(path)
    candidates = list(data_dirs) or [Path("data/raw"), Path("../data/raw")]
    for directory in candidates:
        if directory.exists():
            paths.extend(sorted(directory.glob("*.csv")))
    unique: list[Path] = []
    seen: set[Path] = set()
    for path in paths:
        resolved = path.resolve()
        if resolved not in seen:
            unique.append(path)
            seen.add(resolved)
    if not unique:
        raise SystemExit("Oracle's Elixir CSV files were not found. Use --data-dir or --oe-csv.")
    return unique


def load_oracle_games(paths: list[Path]) -> list[OracleGame]:
    team_rows: dict[str, list[dict[str, str]]] = {}
    for path in paths:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                if str(row.get("position") or "").lower() != "team":
                    continue
                game_id = str(row.get("gameid") or "").strip()
                if not game_id:
                    continue
                team_rows.setdefault(game_id, []).append(row)
    games: list[OracleGame] = []
    for game_id, rows in team_rows.items():
        blue = next((row for row in rows if str(row.get("side") or "").lower() == "blue"), None)
        red = next((row for row in rows if str(row.get("side") or "").lower() == "red"), None)
        if not blue or not red:
            continue
        date = parse_time(blue.get("date") or red.get("date"))
        if date is None:
            continue
        winner = ""
        if str(blue.get("result") or "") == "1":
            winner = str(blue.get("teamname") or "")
        elif str(red.get("result") or "") == "1":
            winner = str(red.get("teamname") or "")
        if not winner:
            continue
        games.append(
            OracleGame(
                game_id=game_id,
                league=str(blue.get("league") or red.get("league") or ""),
                date=date,
                game_number=str(blue.get("game") or red.get("game") or ""),
                blue_team=str(blue.get("teamname") or ""),
                red_team=str(red.get("teamname") or ""),
                winner=winner,
            )
        )
    return sorted(games, key=lambda item: item.date)


def label_event(
    event_id: str,
    match: dict[str, Any],
    schedule: dict[str, Any],
    oe_games: list[OracleGame],
    max_hours: float,
) -> list[dict[str, str]]:
    games = [game for game in match.get("games") or [] if isinstance(game, dict) and game.get("id")]
    games = sorted(games, key=lambda item: int(item.get("number") or 0))
    if not games:
        return []
    league = str(match.get("league") or schedule.get("league") or "")
    event_start = parse_time(match.get("start_time") or schedule.get("start_time"))
    team_names = event_team_names(match, schedule)
    if not event_start or len(team_names) != 2:
        return []
    team_key = {team_key_value(team) for team in team_names}
    candidates = [
        game
        for game in oe_games
        if league_matches(league, game.league)
        and 0 <= (game.date - event_start).total_seconds() <= max_hours * 3600
        and {team_key_value(game.blue_team), team_key_value(game.red_team)} == team_key
    ]
    candidates = sorted(candidates, key=lambda item: item.date)
    rows: list[dict[str, str]] = []
    for live_game, oe_game in zip(games, candidates):
        blue = live_game.get("blue") or {}
        red = live_game.get("red") or {}
        live_blue_key = team_key_value(str(blue.get("team_name") or blue.get("team_code") or ""))
        winner_key = team_key_value(oe_game.winner)
        blue_win = "1" if winner_key == live_blue_key else "0"
        rows.append(
            {
                "event_id": event_id,
                "game_id": str(live_game.get("id") or ""),
                "game_number": str(live_game.get("number") or ""),
                "winner": winner_for_live_side(oe_game.winner, blue, red),
                "blue_win": blue_win,
                "source": "oracles_elixir",
                "source_game_id": oe_game.game_id,
                "source_date": oe_game.date.isoformat().replace("+00:00", "Z"),
            }
        )
    return rows


def event_has_oracle_candidates(schedule: dict[str, Any], oe_games: list[OracleGame], max_hours: float) -> bool:
    event_start = parse_time(schedule.get("start_time"))
    if not event_start:
        return True
    league = str(schedule.get("league") or "")
    teams = [str(schedule.get("blue_team") or ""), str(schedule.get("red_team") or "")]
    if not all(teams):
        return True
    team_key = {team_key_value(team) for team in teams}
    return any(
        league_matches(league, game.league)
        and 0 <= (game.date - event_start).total_seconds() <= max_hours * 3600
        and {team_key_value(game.blue_team), team_key_value(game.red_team)} == team_key
        for game in oe_games
    )


def event_team_names(match: dict[str, Any], schedule: dict[str, Any]) -> list[str]:
    teams = [str(team.get("name") or team.get("code") or "") for team in match.get("teams") or [] if isinstance(team, dict)]
    if len([team for team in teams if team]) >= 2:
        return [team for team in teams if team][:2]
    return [str(schedule.get("blue_team") or ""), str(schedule.get("red_team") or "")]


def winner_for_live_side(winner: str, blue: dict[str, Any], red: dict[str, Any]) -> str:
    winner_key = team_key_value(winner)
    if winner_key == team_key_value(str(blue.get("team_name") or blue.get("team_code") or "")):
        return str(blue.get("team_code") or blue.get("team_name") or winner)
    if winner_key == team_key_value(str(red.get("team_name") or red.get("team_code") or "")):
        return str(red.get("team_code") or red.get("team_name") or winner)
    return winner


def league_matches(event_league: str, oe_league: str) -> bool:
    if not event_league:
        return True
    return str(event_league).strip().lower() == str(oe_league).strip().lower()


def team_pair(teams: Any) -> tuple[str, str]:
    if not isinstance(teams, list) or len(teams) < 2:
        return "", ""
    result = []
    for team in teams[:2]:
        if isinstance(team, dict):
            result.append(str(team.get("name") or team.get("code") or ""))
        else:
            result.append(str(team))
    return result[0], result[1]


def same_label(left: Any, right: Any) -> bool:
    return team_key_value(str(left)) == team_key_value(str(right))


def team_key_value(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "", value.lower())
    for token in ("esports", "esport", "gaming", "academy", "challengers"):
        normalized = normalized.replace(token, "")
    normalized = normalized.replace("geng", "geng")
    return normalized


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


def write_labels(path: Path, rows: list[dict[str, str]]) -> None:
    fieldnames = ["event_id", "game_id", "game_number", "winner", "blue_win", "source", "source_game_id", "source_date"]
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


if __name__ == "__main__":
    main()
