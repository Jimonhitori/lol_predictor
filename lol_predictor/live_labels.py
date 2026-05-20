from __future__ import annotations

import argparse
import csv
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


DEFAULT_SCHEDULE = Path("docs/static/data/matches-all__all.json")
DEFAULT_MATCH_DIR = Path("docs/static/data/matches")


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
    parser.add_argument("--event-id", action="append", required=True, help="LoL Esports event id. Repeatable.")
    parser.add_argument("--output", type=Path, required=True, help="CSV path to write game_id,winner,blue_win labels.")
    parser.add_argument("--schedule-json", type=Path, default=DEFAULT_SCHEDULE)
    parser.add_argument("--match-dir", type=Path, default=DEFAULT_MATCH_DIR)
    parser.add_argument(
        "--data-dir",
        action="append",
        type=Path,
        default=[],
        help="Directory containing Oracle's Elixir CSV files. Repeatable.",
    )
    parser.add_argument("--oe-csv", action="append", type=Path, default=[], help="Specific Oracle's Elixir CSV file.")
    parser.add_argument("--max-hours", type=float, default=36.0, help="Maximum time after schedule start to match games.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    schedules = load_schedule(args.schedule_json)
    oe_games = load_oracle_games(oracle_csv_paths(args.data_dir, args.oe_csv))
    rows: list[dict[str, str]] = []
    for event_id in args.event_id:
        match = load_match(args.match_dir, event_id)
        schedule = schedules.get(event_id, {})
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
        raise SystemExit(f"Match JSON not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


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
