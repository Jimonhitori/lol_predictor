from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

import pandas as pd


LIVE_NUMERIC_FEATURES = [
    "game_time",
    "blue_gold",
    "red_gold",
    "gold_diff",
    "blue_kills",
    "red_kills",
    "kill_diff",
    "blue_towers",
    "red_towers",
    "tower_diff",
    "blue_inhibitors",
    "red_inhibitors",
    "inhibitor_diff",
    "blue_barons",
    "red_barons",
    "baron_diff",
    "blue_dragons",
    "red_dragons",
    "dragon_diff",
    "blue_avg_level",
    "red_avg_level",
    "avg_level_diff",
    "blue_cs",
    "red_cs",
    "cs_diff",
    "blue_player_gold",
    "red_player_gold",
    "player_gold_diff",
    "blue_deaths",
    "red_deaths",
    "death_diff",
    "gold_diff_per_min",
    "kill_diff_per_min",
    "tower_diff_per_min",
    "dragon_diff_per_min",
    "cs_diff_per_min",
    "player_gold_diff_per_min",
    "blue_gold_share",
    "live_advantage_score",
]

LIVE_CATEGORICAL_FEATURES = [
    "league",
    "patch_version",
    "best_of",
    "game_number",
    "blue_team",
    "red_team",
]


def load_live_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            records.append(json.loads(line))
    return records


def live_training_frame(paths: Iterable[Path], max_interval_seconds: int = 30) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for path in paths:
        for record in load_live_jsonl(path):
            rows.extend(live_record_rows(record))
    frame = pd.DataFrame(rows)
    if frame.empty:
        return frame
    frame = add_observed_game_time(frame)
    frame = frame.sort_values(["event_id", "game_id", "game_time", "collected_at"]).drop_duplicates(
        ["event_id", "game_id", "game_time_bucket"], keep="last"
    )
    if "target" not in frame.columns:
        return frame.iloc[0:0].copy()
    frame = frame[frame["target"].isin([0, 1])].copy()
    if max_interval_seconds > 0:
        frame = frame[frame["game_time_bucket"] % max_interval_seconds == 0]
    return frame.reset_index(drop=True)


def live_record_rows(record: dict[str, Any]) -> list[dict[str, Any]]:
    details = _details_from_record(record)
    if not details:
        return []
    event_id = str(details.get("id") or record.get("event_id") or "")
    league = str(details.get("league") or record.get("league") or "")
    best_of = str(details.get("best_of") or "")
    rows: list[dict[str, Any]] = []
    for game in details.get("games") or []:
        if not isinstance(game, dict):
            continue
        target = blue_win_target(game)
        live = game.get("live") or {}
        if not isinstance(live, dict):
            continue
        row = live_feature_row(
            live=live,
            event_id=event_id,
            game=game,
            league=league,
            best_of=best_of,
            collected_at=str(record.get("collected_at") or record.get("timestamp") or ""),
            target=target,
        )
        if row:
            rows.append(row)
    return rows


def live_feature_row(
    *,
    live: dict[str, Any],
    event_id: str = "",
    game: dict[str, Any] | None = None,
    league: str = "",
    best_of: str = "",
    collected_at: str = "",
    target: int | None = None,
) -> dict[str, Any]:
    game = game or {}
    game_time = _number(live.get("game_time"))
    if game_time <= 0 and not _has_live_players(live):
        return {}
    blue_stats = live.get("blue_stats") or {}
    red_stats = live.get("red_stats") or {}
    blue_players = live.get("blue") or []
    red_players = live.get("red") or []
    blue_player_stats = _player_totals(blue_players)
    red_player_stats = _player_totals(red_players)
    blue_team = game.get("blue") or {}
    red_team = game.get("red") or {}
    blue_gold = _number(blue_stats.get("gold"))
    red_gold = _number(red_stats.get("gold"))
    blue_kills = _number(blue_stats.get("kills") or blue_player_stats["kills"])
    red_kills = _number(red_stats.get("kills") or red_player_stats["kills"])
    minutes = max(game_time / 60.0, 1.0)
    gold_diff = blue_gold - red_gold
    kill_diff = blue_kills - red_kills
    tower_diff = _number(blue_stats.get("towers")) - _number(red_stats.get("towers"))
    dragon_diff = _number(blue_stats.get("dragons")) - _number(red_stats.get("dragons"))
    cs_diff = blue_player_stats["creep_score"] - red_player_stats["creep_score"]
    player_gold_diff = blue_player_stats["gold"] - red_player_stats["gold"]
    total_gold = blue_gold + red_gold
    row = {
        "event_id": event_id,
        "game_id": str(game.get("id") or ""),
        "game_number": str(game.get("number") or ""),
        "league": league,
        "best_of": best_of,
        "collected_at": collected_at,
        "frame_timestamp": str(live.get("frame_timestamp") or ""),
        "patch_version": str(live.get("patch_version") or ""),
        "game_state": str(live.get("game_state") or game.get("state") or ""),
        "game_time": game_time,
        "game_time_bucket": int(game_time // 30 * 30),
        "blue_team": str(blue_team.get("team_name") or blue_team.get("team_code") or ""),
        "red_team": str(red_team.get("team_name") or red_team.get("team_code") or ""),
        "blue_gold": blue_gold,
        "red_gold": red_gold,
        "gold_diff": gold_diff,
        "blue_kills": blue_kills,
        "red_kills": red_kills,
        "kill_diff": kill_diff,
        "blue_towers": _number(blue_stats.get("towers")),
        "red_towers": _number(red_stats.get("towers")),
        "tower_diff": tower_diff,
        "blue_inhibitors": _number(blue_stats.get("inhibitors")),
        "red_inhibitors": _number(red_stats.get("inhibitors")),
        "inhibitor_diff": _number(blue_stats.get("inhibitors")) - _number(red_stats.get("inhibitors")),
        "blue_barons": _number(blue_stats.get("barons")),
        "red_barons": _number(red_stats.get("barons")),
        "baron_diff": _number(blue_stats.get("barons")) - _number(red_stats.get("barons")),
        "blue_dragons": _number(blue_stats.get("dragons")),
        "red_dragons": _number(red_stats.get("dragons")),
        "dragon_diff": dragon_diff,
        "blue_avg_level": blue_player_stats["avg_level"],
        "red_avg_level": red_player_stats["avg_level"],
        "avg_level_diff": blue_player_stats["avg_level"] - red_player_stats["avg_level"],
        "blue_cs": blue_player_stats["creep_score"],
        "red_cs": red_player_stats["creep_score"],
        "cs_diff": cs_diff,
        "blue_player_gold": blue_player_stats["gold"],
        "red_player_gold": red_player_stats["gold"],
        "player_gold_diff": player_gold_diff,
        "blue_deaths": blue_player_stats["deaths"],
        "red_deaths": red_player_stats["deaths"],
        "death_diff": blue_player_stats["deaths"] - red_player_stats["deaths"],
        "gold_diff_per_min": gold_diff / minutes,
        "kill_diff_per_min": kill_diff / minutes,
        "tower_diff_per_min": tower_diff / minutes,
        "dragon_diff_per_min": dragon_diff / minutes,
        "cs_diff_per_min": cs_diff / minutes,
        "player_gold_diff_per_min": player_gold_diff / minutes,
        "blue_gold_share": blue_gold / total_gold if total_gold > 0 else 0.5,
        "live_advantage_score": live_advantage_score(
            gold_diff=gold_diff,
            kill_diff=kill_diff,
            tower_diff=tower_diff,
            dragon_diff=dragon_diff,
            baron_diff=_number(blue_stats.get("barons")) - _number(red_stats.get("barons")),
            inhibitor_diff=_number(blue_stats.get("inhibitors")) - _number(red_stats.get("inhibitors")),
            cs_diff=cs_diff,
            avg_level_diff=blue_player_stats["avg_level"] - red_player_stats["avg_level"],
        ),
    }
    if target is not None:
        row["target"] = int(target)
    return row


def live_feature_columns(frame: pd.DataFrame) -> list[str]:
    return [col for col in LIVE_CATEGORICAL_FEATURES + LIVE_NUMERIC_FEATURES if col in frame.columns]


def live_advantage_score(
    *,
    gold_diff: float,
    kill_diff: float,
    tower_diff: float,
    dragon_diff: float,
    baron_diff: float,
    inhibitor_diff: float,
    cs_diff: float,
    avg_level_diff: float,
) -> float:
    return (
        gold_diff / 1000.0
        + kill_diff * 0.6
        + tower_diff * 1.2
        + dragon_diff * 0.8
        + baron_diff * 1.5
        + inhibitor_diff * 2.0
        + cs_diff / 50.0
        + avg_level_diff * 1.2
    )


def add_observed_game_time(frame: pd.DataFrame) -> pd.DataFrame:
    if frame.empty or "frame_timestamp" not in frame.columns:
        return frame
    data = frame.copy()
    timestamps = pd.to_datetime(data["frame_timestamp"], errors="coerce", utc=True)
    first_seen = timestamps.groupby([data["event_id"], data["game_id"]]).transform("min")
    observed = (timestamps - first_seen).dt.total_seconds().fillna(0)
    missing_time = pd.to_numeric(data.get("game_time", 0), errors="coerce").fillna(0) <= 0
    data.loc[missing_time, "game_time"] = observed[missing_time]
    data["game_time_bucket"] = (pd.to_numeric(data["game_time"], errors="coerce").fillna(0) // 30 * 30).astype(int)
    return data


def blue_win_target(game: dict[str, Any]) -> int | None:
    winner = _winner_value(game)
    if winner:
        blue = game.get("blue") or {}
        red = game.get("red") or {}
        if _same_team(winner, blue.get("team_id"), blue.get("team_name"), blue.get("team_code")):
            return 1
        if _same_team(winner, red.get("team_id"), red.get("team_name"), red.get("team_code")):
            return 0
    return None


def _winner_value(game: dict[str, Any]) -> str:
    winner = game.get("winner") or game.get("winner_team") or game.get("winnerTeam")
    if isinstance(winner, dict):
        return str(winner.get("id") or winner.get("name") or winner.get("code") or "")
    return str(winner or "")


def _details_from_record(record: dict[str, Any]) -> dict[str, Any]:
    if isinstance(record.get("details"), dict):
        return record["details"]
    if isinstance(record.get("event"), dict):
        return record["event"]
    if isinstance(record.get("games"), list):
        return record
    return {}


def _player_totals(players: Any) -> dict[str, float]:
    if not isinstance(players, list):
        players = []
    levels = [_number(player.get("level")) for player in players if isinstance(player, dict)]
    return {
        "avg_level": sum(levels) / len(levels) if levels else 0.0,
        "kills": sum(_number(player.get("kills")) for player in players if isinstance(player, dict)),
        "deaths": sum(_number(player.get("deaths")) for player in players if isinstance(player, dict)),
        "creep_score": sum(_number(player.get("creep_score")) for player in players if isinstance(player, dict)),
        "gold": sum(_number(player.get("gold")) for player in players if isinstance(player, dict)),
    }


def _has_live_players(live: dict[str, Any]) -> bool:
    return bool(live.get("blue") or live.get("red"))


def _number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _same_team(value: str, *candidates: Any) -> bool:
    normalized = _team_key(value)
    return bool(normalized) and any(normalized == _team_key(candidate) for candidate in candidates)


def _team_key(value: Any) -> str:
    return "".join(char.lower() for char in str(value or "") if char.isalnum())
