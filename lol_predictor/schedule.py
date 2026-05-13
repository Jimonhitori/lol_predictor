from __future__ import annotations

import json
import os
from datetime import date
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

import pandas as pd

from .patches import latest_patch


CITO_TODAY_URL = "https://api.citoapi.com/api/v1/lol/schedule/today"


def today_matches(rows: pd.DataFrame, cache_path: Path | None = None) -> list[dict[str, Any]]:
    api_matches = _load_cito_today()
    if api_matches:
        return api_matches

    if cache_path and cache_path.exists():
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        return _normalize_match_list(cached)

    return _matches_from_rows(rows)


def _load_cito_today() -> list[dict[str, Any]]:
    api_key = os.environ.get("CITO_API_KEY")
    if not api_key:
        return []
    request = Request(CITO_TODAY_URL, headers={"x-api-key": api_key, "accept": "application/json"})
    try:
        with urlopen(request, timeout=15) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, URLError, json.JSONDecodeError):
        return []
    return _normalize_match_list(payload)


def _normalize_match_list(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        candidates = payload.get("matches") or payload.get("data") or payload.get("events") or []
    else:
        candidates = payload
    if not isinstance(candidates, list):
        return []

    matches = []
    for item in candidates:
        if not isinstance(item, dict):
            continue
        teams = item.get("teams") or item.get("competitors") or []
        blue, red = _team_pair(teams)
        matches.append(
            {
                "id": str(item.get("id") or item.get("matchId") or item.get("gameId") or len(matches) + 1),
                "league": str(item.get("league") or item.get("leagueName") or item.get("tournament") or "Unknown"),
                "league_group": str(item.get("league_group") or item.get("tier") or "all"),
                "region": str(item.get("region") or "all"),
                "start_time": str(item.get("startTime") or item.get("start_time") or item.get("scheduledAt") or ""),
                "status": str(item.get("status") or item.get("state") or "scheduled"),
                "blue_team": str(item.get("blueTeam") or item.get("blue_team") or blue or ""),
                "red_team": str(item.get("redTeam") or item.get("red_team") or red or ""),
                "best_of": str(item.get("bestOf") or item.get("best_of") or item.get("strategy") or ""),
                "source": "cito_api",
            }
        )
    return matches


def _team_pair(teams: Any) -> tuple[str, str]:
    if not isinstance(teams, list) or len(teams) < 2:
        return "", ""
    names = []
    for team in teams[:2]:
        if isinstance(team, dict):
            names.append(str(team.get("name") or team.get("code") or team.get("slug") or ""))
        else:
            names.append(str(team))
    return names[0], names[1]


def _matches_from_rows(rows: pd.DataFrame) -> list[dict[str, Any]]:
    if rows.empty:
        return []
    team_rows = rows[rows["position"].eq("team")].copy()
    if team_rows.empty:
        return []

    today = pd.Timestamp(date.today(), tz="UTC").date()
    team_rows["match_date"] = team_rows["date"].dt.date
    day_rows = team_rows[team_rows["match_date"].eq(today)]
    source = "local_today"
    if day_rows.empty:
        latest_day = team_rows["match_date"].max()
        day_rows = team_rows[team_rows["match_date"].eq(latest_day)]
        source = "local_latest"

    matches = []
    for gameid, game in day_rows.groupby("gameid", sort=False):
        sides = game.set_index(game["side"].astype(str).str.lower())
        blue = _side_team(sides, "blue")
        red = _side_team(sides, "red")
        if not blue or not red:
            continue
        matches.append(
            {
                "id": str(gameid),
                "league": str(game["league"].dropna().iloc[0]),
                "league_group": str(game["league_group"].dropna().iloc[0]),
                "region": str(game["league_region"].dropna().iloc[0]),
                "patch": str(game["patch"].dropna().iloc[0] if "patch" in game else latest_patch(rows)),
                "start_time": str(game["date"].min()),
                "status": "completed" if source == "local_latest" else "scheduled",
                "blue_team": blue,
                "red_team": red,
                "best_of": "",
                "source": source,
            }
        )
    return matches[:40]


def _side_team(sides: pd.DataFrame, side: str) -> str:
    if side not in sides.index:
        return ""
    value = sides.loc[side, "teamname"]
    if isinstance(value, pd.Series):
        value = value.iloc[0]
    return str(value)
