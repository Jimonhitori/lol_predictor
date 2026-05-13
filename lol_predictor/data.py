from __future__ import annotations

from pathlib import Path
import json

import pandas as pd

from .league_groups import add_league_group


REQUIRED_COLUMNS = {
    "date",
    "gameid",
    "position",
    "side",
    "teamname",
    "result",
}

COLUMN_ALIASES = {
    "team": "teamname",
    "player": "playername",
    "patchno": "patch",
    "k": "kills",
    "d": "deaths",
    "a": "assists",
}

PLAYER_STAT_COLUMNS = [
    "kills",
    "deaths",
    "assists",
    "goldat15",
    "xpat15",
    "csat15",
    "damagetochampions",
    "visionscore",
]


def load_match_rows(data_dir: Path) -> pd.DataFrame:
    paths = sorted(data_dir.glob("*.csv"))
    if not paths:
        raise FileNotFoundError(f"No CSV files found in {data_dir}")

    frames = []
    for path in paths:
        frame = pd.read_csv(path, low_memory=False)
        frame = _normalize_columns(frame)
        if not REQUIRED_COLUMNS.issubset(frame.columns):
            continue
        frames.append(frame)
    if not frames:
        raise ValueError(f"No usable Oracle's Elixir CSV files found in {data_dir}")
    data = pd.concat(frames, ignore_index=True)
    missing = REQUIRED_COLUMNS - set(data.columns)
    if missing:
        raise ValueError(f"Missing required columns: {sorted(missing)}")

    if "datacompleteness" in data.columns:
        data = data[data["datacompleteness"].eq("complete")].copy()
    data["date"] = pd.to_datetime(data["date"], errors="coerce", utc=True)
    data = data.dropna(subset=["date", "gameid", "teamname", "result"])
    data = data.drop_duplicates(subset=["gameid", "side", "position", "teamname", "playername", "champion"])
    data = add_league_group(data)
    return data.sort_values(["date", "gameid", "side", "position"]).reset_index(drop=True)


def load_patch_notes(path: Path | None) -> pd.DataFrame:
    if path is None or not path.exists():
        return pd.DataFrame()
    if path.suffix.lower() == ".json":
        data = pd.DataFrame(json.loads(path.read_text(encoding="utf-8")))
    else:
        data = pd.read_csv(path, dtype=str)
    for column in ["patch", "riot_patch", "oe_patch"]:
        if column in data.columns:
            data[column] = data[column].astype(str).map(_normalize_patch_text)
    return data


def _normalize_columns(data: pd.DataFrame) -> pd.DataFrame:
    rename_map = {
        old: new
        for old, new in COLUMN_ALIASES.items()
        if old in data.columns and new not in data.columns
    }
    return data.rename(columns=rename_map)


def _normalize_patch_text(value: str) -> str:
    if value.lower() in {"", "nan", "none"}:
        return ""
    if "." not in value:
        return value
    major, minor = value.split(".", 1)
    if major.isdigit() and minor.isdigit():
        return f"{int(major)}.{int(minor):02d}"
    return value


def to_team_games(rows: pd.DataFrame) -> pd.DataFrame:
    team_rows = rows[rows["position"].eq("team")].copy()
    if team_rows.empty:
        raise ValueError("No team-level rows found. Expected position == 'team'.")

    keep = [
        "date",
        "gameid",
        "league",
        "league_group",
        "league_region",
        "patch",
        "side",
        "teamname",
        "result",
        "gamelength",
        "kills",
        "deaths",
        "earnedgold",
        "goldat15",
        "xpat15",
        "csat15",
    ]
    present = [col for col in keep if col in team_rows.columns]
    team_games = team_rows[present].rename(columns={"teamname": "team"})

    opponent = team_games[["gameid", "team", "side"]].copy()
    opponent["opponent_side"] = opponent["side"]
    opponent = opponent.rename(columns={"team": "opponent"})
    team_games = team_games.merge(opponent[["gameid", "opponent", "opponent_side"]], on="gameid")
    team_games = team_games[team_games["side"].ne(team_games["opponent_side"])].drop(columns=["opponent_side"])
    return team_games.sort_values(["date", "gameid", "side"]).reset_index(drop=True)


def add_draft_context(rows: pd.DataFrame, team_games: pd.DataFrame) -> pd.DataFrame:
    player_rows = rows[~rows["position"].eq("team")].copy()
    if "champion" not in player_rows.columns:
        return team_games

    role_map = {
        "top": "top_champion",
        "jng": "jng_champion",
        "mid": "mid_champion",
        "bot": "bot_champion",
        "sup": "sup_champion",
    }
    picks = player_rows[player_rows["position"].isin(role_map)].copy()
    picks["champion_col"] = picks["position"].map(role_map)
    champion_picks = picks.pivot_table(
        index=["gameid", "side"],
        columns="champion_col",
        values="champion",
        aggfunc="first",
    ).reset_index()
    champion_picks.columns.name = None
    merged = team_games.merge(champion_picks, on=["gameid", "side"], how="left")

    if "playername" not in player_rows.columns:
        return merged

    player_role_map = {role: f"{role}_player" for role in role_map}
    players = player_rows[player_rows["position"].isin(player_role_map)].copy()
    players["player_col"] = players["position"].map(player_role_map)
    player_picks = players.pivot_table(
        index=["gameid", "side"],
        columns="player_col",
        values="playername",
        aggfunc="first",
    ).reset_index()
    player_picks.columns.name = None
    merged = merged.merge(player_picks, on=["gameid", "side"], how="left")

    stat_columns = [col for col in PLAYER_STAT_COLUMNS if col in players.columns]
    if not stat_columns:
        return merged

    player_stats = players[["gameid", "side", "position", *stat_columns]].copy()
    player_stats = player_stats.pivot_table(
        index=["gameid", "side"],
        columns="position",
        values=stat_columns,
        aggfunc="first",
    )
    player_stats.columns = [f"{role}_{stat}" for stat, role in player_stats.columns]
    player_stats = player_stats.reset_index()
    return merged.merge(player_stats, on=["gameid", "side"], how="left")
