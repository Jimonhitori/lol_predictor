from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from time import sleep
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode

from .download_oe_api_recent import API_BASE_URL, API_KEY, CSV_COLUMNS, fetch_oe_json, game_to_rows
from .sources import fetch_json_value


DEFAULT_LEAGUE_NAMES = {
    "LoL Champions Korea",
    "Tencent LoL Pro League",
    "LoL EMEA Championship",
    "League of Legends Championship Series",
    "League of Legends Championship Pacific",
    "Circuit Brazilian League of Legends",
    "Turkish Championship League",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill 2026 Oracle's Elixir API game data.")
    parser.add_argument("--output", type=Path, default=Path("data/raw/2026_oracles_elixir_api_games.csv"))
    parser.add_argument("--raw-output", type=Path, default=Path("data/raw/2026_oracles_elixir_api_games.json"))
    parser.add_argument("--year", type=int, default=2026)
    parser.add_argument("--all-leagues", action="store_true")
    parser.add_argument("--league", action="append", dest="leagues", help="League name to include. Repeatable.")
    parser.add_argument("--max-games", type=int, help="Optional cap for API/game debugging.")
    parser.add_argument("--sleep", type=float, default=0.05, help="Delay between game-detail requests.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    tournaments = discover_tournaments(args.year, args.leagues, args.all_leagues)
    print(f"Tournaments selected: {len(tournaments)}")

    team_ids = discover_team_ids(tournaments)
    print(f"Teams discovered: {len(team_ids)}")

    game_ids = discover_game_ids(team_ids, args.year)
    if args.max_games:
        game_ids = game_ids[: args.max_games]
    print(f"Games discovered: {len(game_ids)}")

    raw_games = []
    rows = []
    for index, game_id in enumerate(game_ids, start=1):
        try:
            game = first(fetch_oe_json(f"/games/singleGame/{game_id}"))
        except (HTTPError, URLError):
            continue
        if not game:
            continue
        if not str(game.get("metadata", {}).get("gameCreation", "")).startswith(str(args.year)):
            continue
        raw_games.append(game)
        rows.extend(game_to_rows(game, game_number=game_number_from_id(game_id)))
        if index % 50 == 0:
            print(f"Fetched {index}/{len(game_ids)} games")
        if args.sleep:
            sleep(args.sleep)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    args.raw_output.write_text(json.dumps(raw_games, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Saved CSV: {args.output} ({len(rows)} rows)")
    print(f"Saved raw JSON: {args.raw_output} ({len(raw_games)} games)")


def discover_tournaments(
    year: int, requested_leagues: list[str] | None, all_leagues: bool
) -> list[dict[str, object]]:
    payload = fetch_json_value(
        f"{API_BASE_URL}/tournaments/byLeague",
        headers={"X-Api-Key": API_KEY},
    )
    if not isinstance(payload, dict):
        raise ValueError("Unexpected tournaments/byLeague response.")

    allowed = set(requested_leagues or DEFAULT_LEAGUE_NAMES)
    tournaments = []
    for league_name, league_tournaments in payload.items():
        if not all_leagues and str(league_name) not in allowed:
            continue
        if not isinstance(league_tournaments, list):
            continue
        for tournament in league_tournaments:
            if not isinstance(tournament, dict):
                continue
            if str(year) not in str(tournament.get("id", "")):
                continue
            tournaments.append(tournament)
    return tournaments


def discover_team_ids(tournaments: list[dict[str, object]]) -> list[str]:
    team_ids: set[str] = set()
    for tournament in tournaments:
        tournament_id = str(tournament["id"])
        query = urlencode({"tournament": tournament_id})
        try:
            teams = fetch_oe_json(f"/stats/teams/byTournament?{query}")
        except (HTTPError, URLError):
            continue
        for team in teams:
            team_id = team.get("id")
            if team_id:
                team_ids.add(str(team_id))
    return sorted(team_ids)


def discover_game_ids(team_ids: list[str], year: int) -> list[str]:
    game_ids: set[str] = set()
    for team_id in team_ids:
        path = f"/teams/gameDetails/{quote(team_id, safe='')}"
        try:
            games = fetch_oe_json(path)
        except (HTTPError, URLError):
            continue
        for game in games:
            if not str(game.get("gameCreation", "")).startswith(str(year)):
                continue
            game_id = game.get("oeGameId")
            if game_id:
                game_ids.add(str(game_id))
    return sorted(game_ids)


def first(value: object) -> dict[str, object]:
    if isinstance(value, list) and value and isinstance(value[0], dict):
        return value[0]
    return {}


def game_number_from_id(game_id: str) -> int:
    return 1


if __name__ == "__main__":
    main()
