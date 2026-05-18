from __future__ import annotations

import argparse
from pathlib import Path
import sys

import pandas as pd

from .data import load_match_rows
from .league_groups import filter_leagues
from .patches import filter_patch, latest_patch


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Summarize the latest patch in Oracle's Elixir data.")
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--patch", default="latest")
    parser.add_argument("--top", type=int, default=15)
    parser.add_argument("--league", action="append", dest="leagues")
    parser.add_argument("--region", choices=["all", "americas", "china", "emea", "international", "korea", "other", "pacific"], default="all")
    parser.add_argument("--league-group", choices=["all", "major", "secondary", "event"], default="all")
    return parser.parse_args()


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    args = parse_args()
    rows = load_match_rows(args.data_dir)
    rows = filter_leagues(rows, league_group=args.league_group, region=args.region, leagues=args.leagues)
    selected_patch = latest_patch(rows) if args.patch == "latest" else args.patch
    patch_rows = filter_patch(rows, patch=str(selected_patch))
    player_rows = patch_rows[~patch_rows["position"].eq("team")].copy()
    team_rows = patch_rows[patch_rows["position"].eq("team")].copy()

    print(f"Patch: {selected_patch}")
    print(f"Games: {patch_rows['gameid'].nunique()}")
    print(f"Leagues: {', '.join(sorted(map(str, patch_rows['league'].dropna().unique())))}")
    if "league_region" in patch_rows.columns:
        print(f"Regions: {', '.join(sorted(map(str, patch_rows['league_region'].dropna().unique())))}")
    print()
    print("Champion picks")
    print(_champion_summary(player_rows, args.top).to_string(index=False))
    print()
    print("Team form")
    print(_team_summary(team_rows, args.top).to_string(index=False))
    print()
    print("Player stats")
    print(_player_summary(player_rows, args.top).to_string(index=False))


def _champion_summary(rows: pd.DataFrame, top: int) -> pd.DataFrame:
    summary = (
        rows.groupby("champion")
        .agg(picks=("champion", "size"), wins=("result", "sum"))
        .assign(winrate=lambda data: data["wins"] / data["picks"])
        .sort_values(["picks", "winrate"], ascending=[False, False])
        .head(top)
        .reset_index()
    )
    summary["winrate"] = summary["winrate"].map(lambda value: f"{value:.1%}")
    return summary


def _team_summary(rows: pd.DataFrame, top: int) -> pd.DataFrame:
    summary = (
        rows.groupby("teamname")
        .agg(games=("teamname", "size"), wins=("result", "sum"))
        .assign(winrate=lambda data: data["wins"] / data["games"])
        .sort_values(["games", "winrate"], ascending=[False, False])
        .head(top)
        .reset_index()
        .rename(columns={"teamname": "team"})
    )
    summary["winrate"] = summary["winrate"].map(lambda value: f"{value:.1%}")
    return summary


def _player_summary(rows: pd.DataFrame, top: int) -> pd.DataFrame:
    aggregations = {
        "games": ("playername", "size"),
        "wins": ("result", "sum"),
        "kills": ("kills", "mean"),
        "deaths": ("deaths", "mean"),
        "assists": ("assists", "mean"),
    }
    if "csat15" in rows.columns and rows["csat15"].notna().any():
        aggregations["csat15"] = ("csat15", "mean")
    if "goldat15" in rows.columns and rows["goldat15"].notna().any():
        aggregations["goldat15"] = ("goldat15", "mean")

    summary = rows.groupby(["playername", "position"]).agg(**aggregations).reset_index()
    summary["winrate"] = summary["wins"] / summary["games"]
    for col in ["kills", "deaths", "assists", "csat15", "goldat15"]:
        if col in summary.columns:
            summary[col] = summary[col].map(lambda value: f"{value:.2f}")
    summary["winrate"] = summary["winrate"].map(lambda value: f"{value:.1%}")
    return summary.sort_values(["games", "winrate"], ascending=[False, False]).head(top)


if __name__ == "__main__":
    main()
