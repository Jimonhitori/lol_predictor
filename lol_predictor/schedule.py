from __future__ import annotations

import json
import os
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import pandas as pd

from .league_groups import LEAGUE_REGION_BY_LABEL, PRIMARY_LEAGUE_LABELS
from .patches import latest_patch


CITO_MATCHES_URL = "https://api.citoapi.com/v1/lol/matches/live"
LOLESPORTS_SCHEDULE_URL = "https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=en-US"
LOLESPORTS_EVENT_DETAILS_URL = "https://esports-api.lolesports.com/persisted/gw/getEventDetails"
LOLESPORTS_LIVE_WINDOW_URL = "https://feed.lolesports.com/livestats/v1/window/{game_id}"
LOLESPORTS_LIVE_DETAILS_URL = "https://feed.lolesports.com/livestats/v1/details/{game_id}"
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


def lolesports_event_details(match_id: str) -> dict[str, Any]:
    if os.environ.get("LOL_ESPORTS_DISABLED") == "1":
        return {}
    api_key = os.environ.get("LOL_ESPORTS_API_KEY", LOLESPORTS_API_KEY)
    url = os.environ.get("LOL_ESPORTS_EVENT_DETAILS_URL", LOLESPORTS_EVENT_DETAILS_URL)
    separator = "&" if "?" in url else "?"
    request = Request(
        f"{url}{separator}hl=en-US&id={match_id}",
        headers={"x-api-key": api_key, "accept": "application/json"},
    )
    try:
        with urlopen(request, timeout=15) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, URLError, json.JSONDecodeError):
        return {}
    event = payload.get("data", {}).get("event", {})
    return _normalize_lolesports_event_detail(event) if isinstance(event, dict) else {}


def lolesports_live_window(game_id: str) -> dict[str, Any]:
    if os.environ.get("LOL_ESPORTS_DISABLED") == "1" or not game_id:
        return {}
    url_template = os.environ.get("LOL_ESPORTS_LIVE_WINDOW_URL", LOLESPORTS_LIVE_WINDOW_URL)
    starting_time = _live_starting_time()
    request = Request(_live_feed_url(url_template, game_id, starting_time), headers={"accept": "application/json"})
    try:
        with urlopen(request, timeout=8) as response:
            if getattr(response, "status", 200) == 204:
                return {}
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, OSError, URLError, json.JSONDecodeError):
        return {}
    live = _normalize_live_window(payload) if isinstance(payload, dict) else {}
    details = _load_lolesports_live_details(game_id, starting_time)
    if details:
        _merge_live_details(live, details)
    return live


def _load_lolesports_live_details(game_id: str, starting_time: str) -> dict[str, Any]:
    url_template = os.environ.get("LOL_ESPORTS_LIVE_DETAILS_URL", LOLESPORTS_LIVE_DETAILS_URL)
    request = Request(_live_feed_url(url_template, game_id, starting_time), headers={"accept": "application/json"})
    try:
        with urlopen(request, timeout=8) as response:
            if getattr(response, "status", 200) == 204:
                return {}
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, OSError, URLError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _live_starting_time() -> str:
    timestamp = int((datetime.now(timezone.utc) - timedelta(seconds=60)).timestamp())
    rounded = timestamp - (timestamp % 10)
    return datetime.fromtimestamp(rounded, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _live_feed_url(url_template: str, game_id: str, starting_time: str) -> str:
    url = url_template.format(game_id=game_id)
    separator = "&" if "?" in url else "?"
    return f"{url}{separator}{urlencode({'startingTime': starting_time})}"


def _normalize_lolesports_event_detail(event: dict[str, Any]) -> dict[str, Any]:
    match = event.get("match") or {}
    teams = match.get("teams") or []
    games = match.get("games") or []
    league = event.get("league") or {}
    team_by_id = {str(team.get("id")): team for team in teams if isinstance(team, dict)}
    best_of = str((match.get("strategy") or {}).get("count") or "")
    normalized_teams = [_normalize_team(team) for team in teams if isinstance(team, dict)]
    normalized_games = [_normalize_game(game, team_by_id) for game in games if isinstance(game, dict)]
    return {
        "id": str(event.get("id") or ""),
        "league": str(league.get("name") or "Unknown"),
        "league_group": _league_group(str(league.get("name") or "Unknown")),
        "region": _league_region(str(league.get("name") or "Unknown")),
        "block_name": str(event.get("blockName") or ""),
        "best_of": best_of,
        "status": _series_state_from_games(normalized_games, normalized_teams, best_of, str(event.get("state") or "")),
        "teams": normalized_teams,
        "games": normalized_games,
        "source": "lolesports_api",
    }


def _normalize_team(team: dict[str, Any]) -> dict[str, str]:
    result = team.get("result") or {}
    return {
        "id": str(team.get("id") or ""),
        "name": str(team.get("name") or ""),
        "code": str(team.get("code") or ""),
        "image": str(team.get("image") or ""),
        "game_wins": str(result.get("gameWins") or "0"),
    }


def _normalize_game(game: dict[str, Any], team_by_id: dict[str, dict[str, Any]]) -> dict[str, Any]:
    sides = {}
    for team in game.get("teams") or []:
        if not isinstance(team, dict):
            continue
        source_team = team_by_id.get(str(team.get("id")), {})
        sides[str(team.get("side") or "")] = {
            "team_id": str(team.get("id") or ""),
            "team_name": str(source_team.get("name") or ""),
            "team_code": str(source_team.get("code") or ""),
        }
    game_id = str(game.get("id") or "")
    state = str(game.get("state") or "")
    live = (
        lolesports_live_window(game_id)
        if state.lower() != "unstarted" and os.environ.get("LOL_ESPORTS_SKIP_LIVE") != "1"
        else {}
    )
    return {
        "id": game_id,
        "number": int(game.get("number") or 0),
        "state": state,
        "blue": sides.get("blue", {}),
        "red": sides.get("red", {}),
        "live": live,
    }


def _normalize_live_window(payload: dict[str, Any]) -> dict[str, Any]:
    metadata = payload.get("gameMetadata") or {}
    frame = payload.get("frames", [{}])[-1] if isinstance(payload.get("frames"), list) and payload.get("frames") else {}
    blue_frame = frame.get("blueTeam") or {}
    red_frame = frame.get("redTeam") or {}
    return {
        "game_state": str(frame.get("gameState") or payload.get("gameState") or ""),
        "game_time": int(frame.get("gameTime") or payload.get("gameTime") or 0),
        "patch_version": str(metadata.get("patchVersion") or ""),
        "blue": _live_participants(metadata.get("blueTeamMetadata") or {}, blue_frame),
        "red": _live_participants(metadata.get("redTeamMetadata") or {}, red_frame),
        "blue_stats": _live_team_stats(blue_frame),
        "red_stats": _live_team_stats(red_frame),
        "source": "lolesports_livestats",
    }


def _live_participants(team_metadata: dict[str, Any], team_frame: dict[str, Any]) -> list[dict[str, Any]]:
    participants = team_metadata.get("participantMetadata") or []
    if not isinstance(participants, list):
        return []
    stats_by_id = {
        str(participant.get("participantId")): participant
        for participant in team_frame.get("participants", [])
        if isinstance(participant, dict)
    }
    result = []
    for participant in participants:
        if not isinstance(participant, dict):
            continue
        stats = stats_by_id.get(str(participant.get("participantId")), {})
        champion = participant.get("championName") or participant.get("championId") or ""
        result.append(
            {
                "player": str(participant.get("summonerName") or participant.get("name") or ""),
                "participant_id": str(participant.get("participantId") or ""),
                "champion": str(champion),
                "champion_id": str(participant.get("championId") or ""),
                "role": str(participant.get("role") or ""),
                "level": int(stats.get("level") or 0),
                "kills": int(stats.get("kills") or 0),
                "deaths": int(stats.get("deaths") or 0),
                "assists": int(stats.get("assists") or 0),
                "creep_score": int(stats.get("creepScore") or 0),
                "gold": int(stats.get("totalGold") or 0),
                "current_health": int(stats.get("currentHealth") or 0),
                "max_health": int(stats.get("maxHealth") or 0),
                "items": _live_items(stats.get("items") or []),
            }
        )
    return result


def _merge_live_details(live: dict[str, Any], payload: dict[str, Any]) -> None:
    frames = payload.get("frames") or []
    if not isinstance(frames, list) or not frames:
        return
    frame = frames[-1] if isinstance(frames[-1], dict) else {}
    participants = {
        str(participant.get("participantId")): participant
        for participant in frame.get("participants", [])
        if isinstance(participant, dict)
    }
    for player in list(live.get("blue") or []) + list(live.get("red") or []):
        details = participants.get(str(player.get("participant_id") or ""))
        if not details:
            continue
        player["level"] = int(details.get("level") or player.get("level") or 0)
        player["kills"] = int(details.get("kills") or player.get("kills") or 0)
        player["deaths"] = int(details.get("deaths") or player.get("deaths") or 0)
        player["assists"] = int(details.get("assists") or player.get("assists") or 0)
        player["creep_score"] = int(details.get("creepScore") or player.get("creep_score") or 0)
        player["gold"] = int(details.get("totalGoldEarned") or player.get("gold") or 0)
        player["items"] = _live_items(details.get("items") or player.get("items") or [])


def _live_items(items: list[Any]) -> list[str]:
    result = []
    for item in items:
        item_id = ""
        if isinstance(item, dict):
            item_id = str(item.get("itemID") or item.get("itemId") or item.get("id") or "")
        else:
            item_id = str(item or "")
        if item_id:
            result.append(item_id)
    return result[:7]


def _live_team_stats(team_frame: dict[str, Any]) -> dict[str, Any]:
    return {
        "gold": int(team_frame.get("totalGold") or 0),
        "kills": int(team_frame.get("totalKills") or 0),
        "towers": int(team_frame.get("towers") or 0),
        "inhibitors": int(team_frame.get("inhibitors") or 0),
        "barons": int(team_frame.get("barons") or 0),
        "dragons": len(team_frame.get("dragons") or []),
    }


def _load_lolesports_schedule() -> list[dict[str, Any]]:
    if os.environ.get("LOL_ESPORTS_DISABLED") == "1":
        return []
    payloads = []
    page_token = ""
    seen_tokens = set()
    max_pages = int(os.environ.get("LOL_ESPORTS_SCHEDULE_PAGES", "8"))
    for _ in range(max_pages):
        payload = _load_lolesports_schedule_page(page_token)
        if not payload:
            break
        payloads.append(payload)
        next_token = str(
            payload.get("data", {}).get("schedule", {}).get("pages", {}).get("newer") or ""
        )
        if not next_token or next_token in seen_tokens:
            break
        seen_tokens.add(next_token)
        page_token = next_token
    events = []
    for payload in payloads:
        page_events = payload.get("data", {}).get("schedule", {}).get("events", [])
        if isinstance(page_events, list):
            events.extend(page_events)
    return _normalize_lolesports_events(events)


def _load_lolesports_schedule_page(page_token: str = "") -> dict[str, Any]:
    url = os.environ.get("LOL_ESPORTS_SCHEDULE_URL", LOLESPORTS_SCHEDULE_URL)
    api_key = os.environ.get("LOL_ESPORTS_API_KEY", LOLESPORTS_API_KEY)
    if page_token:
        separator = "&" if "?" in url else "?"
        url = f"{url}{separator}{urlencode({'pageToken': page_token})}"
    request = Request(url, headers={"x-api-key": api_key, "accept": "application/json"})
    try:
        with urlopen(request, timeout=15) as response:
            return json.loads(response.read().decode("utf-8"))
    except (OSError, URLError, json.JSONDecodeError):
        return {}


def _normalize_lolesports_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    today_utc = datetime.now(timezone.utc).date()
    start_utc = today_utc - timedelta(days=1)
    end_utc = today_utc + timedelta(days=21)
    matches = []
    for event in events:
        if event.get("type") != "match" or not isinstance(event.get("match"), dict):
            continue
        start_time = str(event.get("startTime") or "")
        event_date = _parse_utc_date(start_time)
        if not event_date or event_date < start_utc or event_date > end_utc:
            continue
        match = event["match"]
        teams = match.get("teams") or []
        blue, red = _team_pair(teams)
        blue_code, red_code = _team_codes(teams)
        blue_image, red_image = _team_images(teams)
        blue_score, red_score = _team_scores(teams)
        league = str((event.get("league") or {}).get("name") or "Unknown")
        strategy = match.get("strategy") or {}
        best_of = str(strategy.get("count") or "")
        team_by_id = {str(team.get("id")): team for team in teams if isinstance(team, dict)}
        normalized_teams = [_normalize_team(team) for team in teams if isinstance(team, dict)]
        normalized_games = [
            _normalize_game(game, team_by_id)
            for game in match.get("games", [])
            if isinstance(game, dict)
        ]
        matches.append(
            {
                "id": str(match.get("id") or len(matches) + 1),
                "league": league,
                "league_group": _league_group(league),
                "region": _league_region(league),
                "start_time": start_time,
                "status": _series_state_from_games(
                    normalized_games,
                    normalized_teams,
                    best_of,
                    str(event.get("state") or "scheduled"),
                ),
                "blue_team": blue,
                "red_team": red,
                "blue_code": blue_code,
                "red_code": red_code,
                "blue_image": blue_image,
                "red_image": red_image,
                "blue_score": blue_score,
                "red_score": red_score,
                "best_of": best_of,
                "source": "lolesports_api",
            }
        )
    deduped = {str(match.get("id") or ""): match for match in matches}
    return sorted(deduped.values(), key=lambda match: str(match.get("start_time") or ""))


def _series_state_from_games(
    games: list[dict[str, Any]], teams: list[dict[str, Any]], best_of: str, fallback: str
) -> str:
    states = [str(game.get("state") or "").lower() for game in games]
    if any(state == "inprogress" for state in states):
        return "inProgress"
    wins = [int(team.get("game_wins") or 0) for team in teams]
    needed = (int(best_of or 0) // 2) + 1 if str(best_of or "").isdigit() else 0
    if needed and any(win >= needed for win in wins):
        return "completed"
    if any(state == "completed" for state in states):
        return "inProgress"
    if states and all(state in {"unstarted", "unneeded"} for state in states):
        return "unstarted"
    return fallback


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
        blue_code, red_code = _team_codes(teams)
        blue_image, red_image = _team_images(teams)
        blue_score, red_score = _team_scores(teams)
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
                "blue_code": str(item.get("blueCode") or item.get("blue_code") or blue_code or ""),
                "red_code": str(item.get("redCode") or item.get("red_code") or red_code or ""),
                "blue_image": str(item.get("blueImage") or item.get("blue_image") or blue_image or ""),
                "red_image": str(item.get("redImage") or item.get("red_image") or red_image or ""),
                "blue_score": str(item.get("blueScore") or item.get("blue_score") or blue_score or ""),
                "red_score": str(item.get("redScore") or item.get("red_score") or red_score or ""),
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


def _team_images(teams: Any) -> tuple[str, str]:
    if not isinstance(teams, list) or len(teams) < 2:
        return "", ""
    images = []
    for team in teams[:2]:
        if isinstance(team, dict):
            images.append(str(team.get("image") or team.get("logo") or ""))
        else:
            images.append("")
    return images[0], images[1]


def _team_codes(teams: Any) -> tuple[str, str]:
    if not isinstance(teams, list) or len(teams) < 2:
        return "", ""
    codes = []
    for team in teams[:2]:
        if isinstance(team, dict):
            codes.append(str(team.get("code") or team.get("name") or ""))
        else:
            codes.append(str(team))
    return codes[0], codes[1]


def _team_scores(teams: Any) -> tuple[str, str]:
    if not isinstance(teams, list) or len(teams) < 2:
        return "", ""
    scores = []
    for team in teams[:2]:
        if isinstance(team, dict):
            result = team.get("result") or {}
            scores.append(_score_text(result.get("gameWins", result.get("wins"))))
        else:
            scores.append("")
    return scores[0], scores[1]


def _score_text(value: Any) -> str:
    return "" if value is None else str(value)


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
                "blue_code": blue,
                "red_code": red,
                "blue_image": "",
                "red_image": "",
                "blue_score": "",
                "red_score": "",
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
