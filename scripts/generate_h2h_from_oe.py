#!/usr/bin/env python3
"""Generate direct H2H artifacts from Oracle's Elixir raw CSVs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from generate_team_history_from_oe import expanded_team_keys, load_oe_series, static_key, write_json


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate direct H2H artifacts for the static site.")
    parser.add_argument("--oe-raw-dir", type=Path, required=True)
    parser.add_argument("--site-docs-dir", type=Path, default=Path("docs"))
    parser.add_argument("--league", action="append", default=None, help="League display name to regenerate, e.g. LCK Challengers.")
    parser.add_argument("--limit", type=int, default=5)
    args = parser.parse_args()

    matches = load_site_matches(args.site_docs_dir / "static" / "data" / "matches-all__all.json")
    allowed_leagues = {static_key(league) for league in args.league or []}
    targets = collect_h2h_targets(matches, allowed_leagues)
    series = load_oe_series(args.oe_raw_dir)
    output_dir = args.site_docs_dir / "static" / "data" / "h2h"
    output_dir.mkdir(parents=True, exist_ok=True)

    written = 0
    skipped = 0
    for target in targets:
        rows = [
            item for item in series
            if static_key(item["league"]) == target["league_key"]
            and is_pair_match(item, target["left_keys"], target["right_keys"])
        ][: args.limit]
        if not rows:
            skipped += 1
            continue
        left_key = static_key(target["left"])
        right_key = static_key(target["right"])
        team_a_key, team_b_key = sorted([left_key, right_key])
        payload = {
            "team_a": target["left"] if team_a_key == left_key else target["right"],
            "team_b": target["right"] if team_b_key == right_key else target["left"],
            "matches": [h2h_match(row) for row in rows],
        }
        write_json(output_dir / f"{target['league_key']}__{team_a_key}__{team_b_key}.json", payload)
        written += 1

    print(json.dumps({"ok": True, "h2h_artifacts": written, "skipped": skipped}, indent=2))


def load_site_matches(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload.get("matches") or payload.get("data", {}).get("matches") or []


def collect_h2h_targets(matches: list[dict[str, Any]], allowed_leagues: set[str]) -> list[dict[str, Any]]:
    targets: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for match in matches:
        league = str(match.get("league") or "")
        league_key = static_key(league)
        if allowed_leagues and league_key not in allowed_leagues:
            continue
        left = str(match.get("blue_team") or match.get("blue_code") or "")
        right = str(match.get("red_team") or match.get("red_code") or "")
        if not valid_team(left) or not valid_team(right):
            continue
        left_key = static_key(left)
        right_key = static_key(right)
        pair_key = tuple([league_key, *sorted([left_key, right_key])])
        if pair_key in seen:
            continue
        seen.add(pair_key)
        targets.append(
            {
                "league_key": league_key,
                "left": left,
                "right": right,
                "left_keys": expanded_team_keys([left, match.get("blue_code")]),
                "right_keys": expanded_team_keys([right, match.get("red_code")]),
            }
        )
    return targets


def is_pair_match(series: dict[str, Any], left_keys: set[str], right_keys: set[str]) -> bool:
    series_left = static_key(series["left_team"])
    series_right = static_key(series["right_team"])
    return (
        series_left in left_keys and series_right in right_keys
    ) or (
        series_left in right_keys and series_right in left_keys
    )


def h2h_match(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "date": row["date"],
        "league": row["league"],
        "split": row["split"],
        "left_team": row["left_team"],
        "right_team": row["right_team"],
        "left_score": row["left_score"],
        "right_score": row["right_score"],
        "source": "oracles_elixir",
    }


def valid_team(value: object) -> bool:
    key = static_key(value)
    return key not in {"", "all", "tbd", "bye", "unknown"}


if __name__ == "__main__":
    main()
