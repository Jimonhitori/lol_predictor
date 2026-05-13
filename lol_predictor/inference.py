from __future__ import annotations

from typing import Any

import pandas as pd

from .data import add_draft_context, to_team_games
from .features import add_champion_reference_features, add_draft_pair_features, add_patch_note_features
from .league_groups import add_league_group
from .patches import latest_patch


def build_prediction_row(
    payload: dict[str, Any],
    *,
    rows: pd.DataFrame | None = None,
    patch_notes: pd.DataFrame | None = None,
    champion_reference: pd.DataFrame | None = None,
    patch: str | None = None,
) -> pd.DataFrame:
    row = pd.DataFrame([payload]).copy()
    inferred_patch = patch or str(row.get("patch", pd.Series([None])).iloc[0] or "")
    if not inferred_patch and rows is not None and not rows.empty:
        inferred_patch = str(latest_patch(rows))
    row["patch"] = inferred_patch
    row["is_blue"] = row["side"].astype(str).str.lower().eq("blue").astype(int)
    row = add_league_group(row)

    if rows is not None and not rows.empty:
        row = add_history_features(row, rows)
    if patch_notes is not None and not patch_notes.empty:
        row = add_patch_note_features(row, patch_notes)
    if champion_reference is not None and not champion_reference.empty:
        row = add_champion_reference_features(row, champion_reference)
    return add_draft_pair_features(row)


def add_history_features(row: pd.DataFrame, rows: pd.DataFrame) -> pd.DataFrame:
    history = add_draft_context(rows, to_team_games(rows)).sort_values(["date", "gameid", "side"])
    output = row.copy()
    team = str(output.at[0, "team"]) if "team" in output.columns else ""
    opponent = str(output.at[0, "opponent"]) if "opponent" in output.columns else ""
    for window in (5, 10):
        output[f"team_winrate_l{window}"] = _team_winrate(history, team, window)
        output[f"opponent_winrate_l{window}"] = _team_winrate(history, opponent, window)
    output["games_seen"] = _games_seen(history, team)
    output["opponent_games_seen"] = _games_seen(history, opponent)

    for role in ["top", "jng", "mid", "bot", "sup"]:
        champion_col = f"{role}_champion"
        if champion_col in output.columns:
            output[f"{role}_champion_winrate_l10"] = _champion_winrate(history, champion_col, output.at[0, champion_col])
    return output


def _team_winrate(history: pd.DataFrame, team: str, window: int) -> float:
    matches = history[history["team"].astype(str).eq(team)].tail(window)
    if matches.empty:
        return 0.5
    return float(pd.to_numeric(matches["result"], errors="coerce").mean())


def _games_seen(history: pd.DataFrame, team: str) -> int:
    return int(history[history["team"].astype(str).eq(team)].shape[0])


def _champion_winrate(history: pd.DataFrame, champion_col: str, champion: object) -> float:
    if champion_col not in history.columns:
        return 0.5
    matches = history[history[champion_col].astype(str).eq(str(champion))].tail(10)
    if matches.empty:
        return 0.5
    return float(pd.to_numeric(matches["result"], errors="coerce").mean())
