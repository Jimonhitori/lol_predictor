from __future__ import annotations

import json
import os
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

import pandas as pd

from .league_groups import LEAGUE_REGION_BY_LABEL, PRIMARY_LEAGUE_LABELS
from .patches import latest_patch


CITO_MATCHES_URL = "https://api.citoapi.com/v1/lol/matches/live"
LOLESPORTS_SCHEDULE_URL = "https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=en-US"
LOLESPORTS_API_KEY = "0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z"


def today_matches(rows: pd.DataFrame, cache_path: Path | None = None) -> list[dict[str, Any]]:
    lol_esports_matches = _load_lolesports_schedule()
    if lol_esports_matches:
        return lol_esports_matches

    api_matches = _load_cito_today()
    if api_matches:
        return api_matches

    if cache_path and cache_path.exists():
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        return _normalize_match_list(cached)

    return _matches_from_rows(rows)


def _load_lolesports_schedule() -> list[dict[str, Any]]:
    if os.environ.get("LOL_ESPORTS_DISABLED") == "1":
        return []
    url = os.environ.get("LOL_ESPORTS_SCHEDULE_URL", LOLESPORTS_SCHEDULE_URL)
    api_key = os.environ.get("LOL_ESPORTS_API_KEY", LOLESPORTS_API_KEY)
    request = Request(url, headers={"x-api-key": api_key, "accept": "application/json"})
    try:
        with urlopen(request, timeout=15) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, URLError, json.JSONDecodeError):
        return []
    events = payload.get("data", {}).get("schedule", {}).get("events", [])
    if not isinstance(events, list):
        return []
    return _normalize_lolesports_events(events)


def _normalize_lolesports_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    today_utc = datetime.now(timezone.utc).date()
    tomorrow_utc = today_utc + timedelta(days=1)
    matches = []
    for event in events:
        if event.get("type") != "match" or not isinstance(event.get("match"), dict):
            continue
        start_time = str(event.get("startTime") or "")
        event_date = _parse_utc_date(start_time)
        if event_date not in {today_utc, tomorrow_utc}:
            continue
        match = event["match"]
        teams = match.get("teams") or []
        blue, red = _team_pair(teams)
        league = str((event.get("league") or {}).get("name") or "Unknown")
        strategy = match.get("strategy") or {}
        matches.append(
            {
                "id": str(match.get("id") or len(matches) + 1),
                "league": league,
                "league_group": _league_group(league),
                "region": _league_region(league),
                "start_time": start_time,
                "status": str(event.get("state") or "scheduled"),
                "blue_team": blue,
                "red_team": red,
                "best_of": str(strategy.get("count") or ""),
                "source": "lolesports_api",
            }
        )
    return matches


def _load_cito_today() -> list[dict[str, Any]]:
    api_key = os.environ.get("CITO_API_KEY")
    if not api_key:
        return []
    url = os.environ.get("CITO_LOL_MATCHES_URL", CITO_MATCHES_URL)
    request = Request(url, headers={"Authorization": f"Bearer {api_key}", "accept": "application/json"})
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


def _parse_utc_date(value: str) -> date | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _league_group(league: str) -> str:
    return "major" if league in PRIMARY_LEAGUE_LABELS else "secondary"


def _league_region(league: str) -> str:
    return LEAGUE_REGION_BY_LABEL.get(league, "other")


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
