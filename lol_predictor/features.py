from __future__ import annotations

import pandas as pd


ROLLING_WINDOWS = (5, 10)
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


def build_training_frame(team_games: pd.DataFrame) -> pd.DataFrame:
    data = team_games.sort_values(["date", "gameid", "side"]).copy()
    data = add_draft_pair_features(data)
    data["is_blue"] = data["side"].astype(str).str.lower().eq("blue").astype(int)

    for window in ROLLING_WINDOWS:
        data[f"team_winrate_l{window}"] = _rolling_team_mean(data, "result", window)
        data[f"opponent_winrate_l{window}"] = _opponent_lookup(data, f"team_winrate_l{window}")

    data["games_seen"] = data.groupby("team").cumcount()
    data["opponent_games_seen"] = _opponent_lookup(data, "games_seen")
    data = _add_role_rolling_features(data)
    data["target"] = data["result"].astype(int)
    return data


def add_patch_note_features(team_games: pd.DataFrame, patch_notes: pd.DataFrame) -> pd.DataFrame:
    if patch_notes.empty or "patch" not in team_games.columns:
        return team_games

    notes = patch_notes.copy()
    notes["oe_patch"] = notes["oe_patch"].astype(str)
    notes["note_text"] = (
        notes.get("title", "").astype(str)
        + "\n"
        + notes.get("summary", "").astype(str)
        + "\n"
        + notes.get("text", "").astype(str)
    ).str.lower()
    text_by_patch = dict(zip(notes["oe_patch"], notes["note_text"], strict=False))

    data = team_games.copy()
    data["patch_note_available"] = data["patch"].astype(str).isin(text_by_patch).astype(int)
    data["patch_note_text_length"] = data["patch"].astype(str).map(
        lambda patch: len(text_by_patch.get(str(patch), ""))
    )
    for role in ["top", "jng", "mid", "bot", "sup"]:
        champion_col = f"{role}_champion"
        output_col = f"{role}_champion_in_patch_notes"
        if champion_col in data.columns:
            data[output_col] = data.apply(
                lambda row: int(
                    str(row.get(champion_col, "")).lower()
                    in text_by_patch.get(str(row.get("patch")), "")
                ),
                axis=1,
            )
    return data


def add_champion_reference_features(
    team_games: pd.DataFrame, champion_reference: pd.DataFrame
) -> pd.DataFrame:
    if champion_reference.empty:
        return team_games

    needed = {"champion", "changed_in_patch", "picks", "winrate"}
    if not needed.issubset(champion_reference.columns):
        return team_games

    reference = champion_reference[
        ["champion", "changed_in_patch", "picks", "winrate", "source_scope"]
    ].copy()
    data = team_games.copy()
    for role in ["top", "jng", "mid", "bot", "sup"]:
        champion_col = f"{role}_champion"
        if champion_col not in data.columns:
            continue
        renamed = reference.rename(
            columns={
                "champion": champion_col,
                "changed_in_patch": f"{role}_champion_ref_changed",
                "picks": f"{role}_champion_ref_picks",
                "winrate": f"{role}_champion_ref_winrate",
                "source_scope": f"{role}_champion_ref_source",
            }
        )
        data = data.merge(renamed, on=champion_col, how="left")
    return data


def feature_columns(data: pd.DataFrame) -> list[str]:
    categorical = [
        "league",
        "league_group",
        "league_region",
        "patch",
        "side",
        "team",
        "opponent",
        "top_champion",
        "jng_champion",
        "mid_champion",
        "bot_champion",
        "sup_champion",
        "top_player",
        "jng_player",
        "mid_player",
        "bot_player",
        "sup_player",
        "bot_sup_pair",
        "jng_mid_pair",
        "top_jng_pair",
        "top_matchup",
        "jng_matchup",
        "mid_matchup",
        "bot_matchup",
        "sup_matchup",
    ]
    numeric = [
        "is_blue",
        "patch_note_available",
        "patch_note_text_length",
        "team_winrate_l5",
        "opponent_winrate_l5",
        "team_winrate_l10",
        "opponent_winrate_l10",
        "games_seen",
        "opponent_games_seen",
    ]
    for role in ["top", "jng", "mid", "bot", "sup"]:
        numeric.extend(
            [
                f"{role}_player_winrate_l10",
                f"{role}_champion_winrate_l10",
                f"{role}_champion_in_patch_notes",
                f"{role}_champion_ref_changed",
                f"{role}_champion_ref_picks",
                f"{role}_champion_ref_winrate",
            ]
        )
        for stat in PLAYER_STAT_COLUMNS:
            numeric.append(f"{role}_{stat}_player_avg_l10")
    return [col for col in categorical + numeric if col in data.columns]


def add_draft_pair_features(data: pd.DataFrame) -> pd.DataFrame:
    data = data.copy()
    pair_specs = {
        "bot_sup_pair": ("bot_champion", "sup_champion"),
        "jng_mid_pair": ("jng_champion", "mid_champion"),
        "top_jng_pair": ("top_champion", "jng_champion"),
    }
    for output, (left, right) in pair_specs.items():
        if left in data.columns and right in data.columns:
            data[output] = _ordered_pair(data[left], data[right])

    for role in ["top", "jng", "mid", "bot", "sup"]:
        champion_col = f"{role}_champion"
        if champion_col not in data.columns:
            continue
        if "gameid" not in data.columns or "opponent" not in data.columns or "team" not in data.columns:
            data[f"{role}_matchup"] = data[champion_col].fillna("unknown").astype(str) + "_vs_unknown"
            continue
        opponent = data[["gameid", "team", champion_col]].rename(
            columns={"team": "opponent", champion_col: f"opp_{champion_col}"}
        )
        data = data.merge(opponent, on=["gameid", "opponent"], how="left")
        data[f"{role}_matchup"] = (
            data[champion_col].fillna("unknown").astype(str)
            + "_vs_"
            + data[f"opp_{champion_col}"].fillna("unknown").astype(str)
        )
        data = data.drop(columns=[f"opp_{champion_col}"])
    return data


def _ordered_pair(left: pd.Series, right: pd.Series) -> pd.Series:
    return left.fillna("unknown").astype(str) + "+" + right.fillna("unknown").astype(str)


def _rolling_team_mean(data: pd.DataFrame, column: str, window: int) -> pd.Series:
    return (
        data.groupby("team", group_keys=False)[column]
        .apply(lambda series: series.shift(1).rolling(window, min_periods=1).mean())
        .fillna(0.5)
    )


def _opponent_lookup(data: pd.DataFrame, column: str) -> pd.Series:
    lookup = data[["gameid", "team", column]].rename(
        columns={"team": "opponent", column: f"opponent_{column}"}
    )
    merged = data[["gameid", "opponent"]].merge(lookup, on=["gameid", "opponent"], how="left")
    return merged[f"opponent_{column}"].fillna(0.5).reset_index(drop=True)


def _add_role_rolling_features(data: pd.DataFrame) -> pd.DataFrame:
    data = data.copy()
    for role in ["top", "jng", "mid", "bot", "sup"]:
        player_col = f"{role}_player"
        champion_col = f"{role}_champion"
        if player_col in data.columns:
            data[f"{role}_player_winrate_l10"] = _rolling_entity_mean(data, player_col)
            for stat in PLAYER_STAT_COLUMNS:
                value_col = f"{role}_{stat}"
                if value_col in data.columns:
                    data[f"{role}_{stat}_player_avg_l10"] = _rolling_entity_stat_mean(
                        data, player_col, value_col
                    )
        if champion_col in data.columns:
            data[f"{role}_champion_winrate_l10"] = _rolling_entity_mean(data, champion_col)
    return data


def _rolling_entity_mean(data: pd.DataFrame, entity_col: str) -> pd.Series:
    keyed = data[[entity_col, "result"]].copy()
    keyed[entity_col] = keyed[entity_col].fillna("unknown")
    return (
        keyed.groupby(entity_col, group_keys=False)["result"]
        .apply(lambda series: series.shift(1).rolling(10, min_periods=1).mean())
        .fillna(0.5)
        .reset_index(drop=True)
    )


def _rolling_entity_stat_mean(data: pd.DataFrame, entity_col: str, value_col: str) -> pd.Series:
    keyed = data[[entity_col, value_col]].copy()
    keyed[entity_col] = keyed[entity_col].fillna("unknown")
    keyed[value_col] = pd.to_numeric(keyed[value_col], errors="coerce")
    return (
        keyed.groupby(entity_col, group_keys=False)[value_col]
        .apply(lambda series: series.shift(1).rolling(10, min_periods=1).mean())
        .reset_index(drop=True)
    )
