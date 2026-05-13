from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from .data import load_match_rows, load_patch_notes
from .league_groups import filter_leagues
from .patches import latest_patch


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build champion reference stats using current-patch data for changed champions and history for unchanged champions."
    )
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--patch-notes", type=Path, default=Path("data/patch_notes/riot_2026_patch_notes.json"))
    parser.add_argument("--patch", default="latest")
    parser.add_argument("--league", action="append", dest="leagues")
    parser.add_argument("--region", choices=["all", "americas", "china", "emea", "international", "korea", "other", "pacific"], default="all")
    parser.add_argument("--league-group", choices=["all", "major", "secondary"], default="all")
    parser.add_argument("--output", type=Path, default=Path("data/features/champion_reference.csv"))
    parser.add_argument("--changed-output", type=Path, default=Path("data/features/changed_champions.json"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    rows = load_match_rows(args.data_dir)
    rows = filter_leagues(rows, league_group=args.league_group, region=args.region, leagues=args.leagues)
    patch = latest_patch(rows) if args.patch == "latest" else args.patch
    patch_notes = load_patch_notes(args.patch_notes)
    player_rows = rows[~rows["position"].eq("team")].copy()
    champion_universe = sorted(player_rows["champion"].dropna().astype(str).unique())
    changed = changed_champions_for_patch(patch_notes, str(patch), champion_universe)
    reference = build_champion_reference(player_rows, str(patch), changed)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    reference.to_csv(args.output, index=False)
    args.changed_output.write_text(
        json.dumps(
            {
                "patch": str(patch),
                "changed_champions": sorted(changed),
                "changed_count": len(changed),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"Patch: {patch}")
    print(f"Changed champions detected: {len(changed)}")
    print(f"Saved reference: {args.output} ({len(reference)} champions)")
    print(f"Saved changed list: {args.changed_output}")


def changed_champions_for_patch(
    patch_notes: pd.DataFrame, oe_patch: str, champion_universe: list[str]
) -> set[str]:
    if patch_notes.empty or "oe_patch" not in patch_notes.columns:
        return set()

    notes = patch_notes[patch_notes["oe_patch"].astype(str).eq(str(oe_patch))]
    if notes.empty:
        return set()

    text = "\n".join(
        notes.get(column, pd.Series(dtype=str)).fillna("").astype(str).str.lower().str.cat(sep="\n")
        for column in ["title", "summary", "text"]
        if column in notes.columns
    )
    return {champion for champion in champion_universe if champion.lower() in text}


def build_champion_reference(
    player_rows: pd.DataFrame, current_patch: str, changed_champions: set[str]
) -> pd.DataFrame:
    player_rows = player_rows.copy()
    player_rows["patch"] = player_rows["patch"].astype(str)
    rows = []

    for champion in sorted(player_rows["champion"].dropna().astype(str).unique()):
        champion_rows = player_rows[player_rows["champion"].astype(str).eq(champion)]
        changed = champion in changed_champions
        if changed:
            source_rows = champion_rows[champion_rows["patch"].eq(current_patch)]
            source_scope = "current_patch_changed"
        else:
            source_rows = champion_rows[~champion_rows["patch"].eq(current_patch)]
            source_scope = "historical_unchanged"

        if source_rows.empty:
            source_rows = champion_rows[champion_rows["patch"].eq(current_patch)]
            source_scope = "current_patch_fallback"
        if source_rows.empty:
            source_rows = champion_rows
            source_scope = "all_available_fallback"

        rows.append(champion_stats(champion, changed, source_scope, source_rows))

    return pd.DataFrame(rows).sort_values(["changed_in_patch", "picks"], ascending=[False, False])


def champion_stats(
    champion: str, changed: bool, source_scope: str, rows: pd.DataFrame
) -> dict[str, object]:
    result = pd.to_numeric(rows["result"], errors="coerce")
    stats: dict[str, object] = {
        "champion": champion,
        "changed_in_patch": int(changed),
        "source_scope": source_scope,
        "picks": int(len(rows)),
        "wins": int(result.sum()),
        "winrate": float(result.mean()) if len(rows) else 0.0,
    }
    for column in ["kills", "deaths", "assists", "earnedgold", "damagetochampions", "dpm", "cspm"]:
        if column in rows.columns:
            stats[f"avg_{column}"] = float(pd.to_numeric(rows[column], errors="coerce").mean())
    return stats


if __name__ == "__main__":
    main()
