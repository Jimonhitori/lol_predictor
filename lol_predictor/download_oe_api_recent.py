from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from urllib.error import HTTPError

from .sources import fetch_json


API_BASE_URL = "https://oe.datalisk.io"
API_KEY = "f561197a-82ea-4e54-acd2-386979018a7a"
ROLE_MAP = {
    "top": "top",
    "jng": "jng",
    "mid": "mid",
    "bot": "bot",
    "support": "sup",
    "sup": "sup",
}


CSV_COLUMNS = [
    "gameid",
    "league",
    "split",
    "date",
    "game",
    "patch",
    "side",
    "position",
    "playername",
    "teamname",
    "champion",
    "gamelength",
    "result",
    "kills",
    "deaths",
    "assists",
    "teamkills",
    "teamdeaths",
    "earnedgold",
    "damagetochampions",
    "dpm",
    "total cs",
    "cspm",
    "visionscore",
    "goldat15",
    "xpat15",
    "csat15",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download recent 2026 Oracle's Elixir API games.")
    parser.add_argument("--output", type=Path, default=Path("data/raw/2026_oracles_elixir_api_recent_games.csv"))
    parser.add_argument("--raw-output", type=Path, default=Path("data/raw/2026_oracles_elixir_api_recent_games.json"))
    parser.add_argument("--year", type=int, default=2026)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    matches = fetch_oe_json("/matches/recentResults/")
    rows: list[dict[str, object]] = []
    raw_games: list[dict[str, object]] = []

    for match in matches:
        if not str(match.get("startTime", "")).startswith(str(args.year)):
            continue
        match_detail = _first(fetch_oe_json(f"/matches/singleMatch/{match['matchId']}"))
        for index in range(1, 6):
            game_id = match_detail.get(f"game{index}Id")
            if not game_id:
                continue
            try:
                game = _first(fetch_oe_json(f"/games/singleGame/{game_id}"))
            except HTTPError as error:
                if error.code == 404:
                    continue
                raise
            if not game or not str(game.get("metadata", {}).get("gameCreation", "")).startswith(str(args.year)):
                continue
            raw_games.append(game)
            rows.extend(game_to_rows(game, game_number=index))

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)

    args.raw_output.write_text(json.dumps(raw_games, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved CSV: {args.output} ({len(rows)} rows)")
    print(f"Saved raw JSON: {args.raw_output} ({len(raw_games)} games)")


def fetch_oe_json(path: str) -> list[dict[str, object]]:
    return fetch_json(f"{API_BASE_URL}{path}", headers={"X-Api-Key": API_KEY})


def game_to_rows(game: dict[str, object], game_number: int) -> list[dict[str, object]]:
    metadata = game["metadata"]
    assert isinstance(metadata, dict)
    rows = []
    blue_rows = team_to_rows(game["gameId"], metadata, game["blueTeam"], "Blue", game_number)
    red_rows = team_to_rows(game["gameId"], metadata, game["redTeam"], "Red", game_number)
    rows.extend(blue_rows)
    rows.extend(red_rows)
    return rows


def team_to_rows(
    game_id: object,
    metadata: dict[str, object],
    team: object,
    side: str,
    game_number: int,
) -> list[dict[str, object]]:
    assert isinstance(team, dict)
    league = metadata.get("league") or {}
    tournament = metadata.get("tournament") or {}
    team_stats = team.get("teamStats") or {}
    assert isinstance(league, dict)
    assert isinstance(tournament, dict)
    assert isinstance(team_stats, dict)

    common = {
        "gameid": game_id,
        "league": league.get("label"),
        "split": tournament.get("name"),
        "date": metadata.get("gameCreation"),
        "game": game_number,
        "patch": metadata.get("patch"),
        "side": side,
        "teamname": team.get("teamName"),
        "gamelength": metadata.get("gameDuration"),
    }
    rows = [
        {
            **common,
            "position": "team",
            "result": team_stats.get("result"),
            "kills": team_stats.get("kills"),
            "deaths": team_stats.get("deaths"),
            "earnedgold": team_stats.get("gold"),
        }
    ]

    players = team.get("players") or {}
    assert isinstance(players, dict)
    for role_key, player in players.items():
        if not isinstance(player, dict):
            continue
        role = ROLE_MAP.get(str(role_key).lower(), str(role_key).lower())
        rows.append(
            {
                **common,
                "position": role,
                "playername": player.get("name"),
                "champion": player.get("champion"),
                "result": player.get("result"),
                "kills": player.get("kills"),
                "deaths": player.get("deaths"),
                "assists": player.get("assists"),
                "teamkills": player.get("teamKills"),
                "teamdeaths": player.get("teamDeaths"),
                "earnedgold": player.get("goldEarned"),
                "damagetochampions": player.get("damageToChampions"),
                "dpm": player.get("dpm"),
                "total cs": player.get("creepScore"),
                "cspm": player.get("cspm"),
                "visionscore": player.get("visionScore"),
            }
        )
    return rows


def _first(value: object) -> dict[str, object]:
    if isinstance(value, list) and value:
        item = value[0]
        if isinstance(item, dict):
            return item
    return {}


if __name__ == "__main__":
    main()
