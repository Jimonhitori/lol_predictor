from __future__ import annotations

import pandas as pd


PRIMARY_LEAGUE_LABELS = {
    "CBLOL",
    "LCK",
    "LCKC",
    "LCP",
    "LCS",
    "LEC",
    "LPL",
    "MSI",
    "WLDs",
}

EVENT_LEAGUE_LABELS = {
    "EWC",
}

LEAGUE_REGION_BY_LABEL = {
    "AC": "emea",
    "CBLOL": "americas",
    "CD": "americas",
    "EM": "emea",
    "EWC": "international",
    "FST": "international",
    "LCK": "korea",
    "LCKC": "korea",
    "LCP": "pacific",
    "LCS": "americas",
    "LEC": "emea",
    "LFL": "emea",
    "LPL": "china",
    "LRN": "americas",
    "MSI": "international",
    "TCL": "emea",
    "VCS": "pacific",
    "WLDs": "international",
}


def league_group_for_label(league: str) -> str:
    if league in PRIMARY_LEAGUE_LABELS:
        return "major"
    if league in EVENT_LEAGUE_LABELS:
        return "event"
    return "secondary"


def add_league_group(data: pd.DataFrame) -> pd.DataFrame:
    if "league" not in data.columns:
        return data
    data = data.copy()
    data["league_group"] = data["league"].astype(str).map(
        league_group_for_label
    )
    data["league_region"] = data["league"].astype(str).map(
        lambda league: LEAGUE_REGION_BY_LABEL.get(league, "other")
    )
    return data


def filter_leagues(
    data: pd.DataFrame,
    league_group: str | None = None,
    region: str | None = None,
    leagues: list[str] | None = None,
) -> pd.DataFrame:
    if leagues and "league" in data.columns:
        data = data[data["league"].astype(str).isin(set(leagues))].copy()
    if league_group and league_group != "all" or region and region != "all":
        data = add_league_group(data)
    if league_group and league_group != "all":
        data = data[data["league_group"].eq(league_group)].copy()
    if region and region != "all":
        data = data[data["league_region"].eq(region)].copy()
    return data
