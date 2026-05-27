#!/usr/bin/env python3
"""Generate recent team-history artifacts from Oracle's Elixir raw CSVs."""

from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any


LEAGUE_KEY_ALIASES = {
    "lckc": "lck-challengers",
}

TEAM_KEY_ALIASES = {
    "bro-challengers": ["hanjin-brion-challengers"],
    "dk-challengers": ["dplus-kia-challengers"],
    "dns-challengers": ["dn-soopers-challengers"],
    "hle-challengers": ["hanwha-life-esports-challengers"],
    "krx-challengers": ["kiwoom-drx-challengers"],
    "kt-challengers": ["kt-rolster-challengers"],
    "ns-challengers": ["nongshim-esports-academy"],
    "team-liquid-alienware": ["team-liquid"],
}


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate team recent-history artifacts for the static site.")
    parser.add_argument("--oe-raw-dir", type=Path, required=True)
    parser.add_argument("--site-docs-dir", type=Path, default=Path("docs"))
    parser.add_argument("--limit", type=int, default=5)
    args = parser.parse_args()

    team_targets = load_team_targets(args.site_docs_dir / "static" / "data" / "team-records")
    team_images = load_team_images(args.site_docs_dir / "static" / "data")
    series = load_oe_series(args.oe_raw_dir)
    output_dir = args.site_docs_dir / "static" / "data" / "team-history"
    output_dir.mkdir(parents=True, exist_ok=True)

    written = 0
    for artifact_key, target in sorted(team_targets.items()):
        matches = []
        for item in series:
            team_side = side_for_target(item, target["team_keys"])
            if not team_side:
                continue
            opponent_side = "right" if team_side == "left" else "left"
            team_score = item[f"{team_side}_score"]
            opponent_score = item[f"{opponent_side}_score"]
            matches.append(
                {
                    "date": item["date"],
                    "league": item["league"],
                    "split": item["split"],
                    "team": item[f"{team_side}_team"],
                    "team_image": image_for_team(item[f"{team_side}_team"], team_images),
                    "opponent": item[f"{opponent_side}_team"],
                    "opponent_image": image_for_team(item[f"{opponent_side}_team"], team_images),
                    "team_score": team_score,
                    "opponent_score": opponent_score,
                    "result": "W" if team_score > opponent_score else "L" if team_score < opponent_score else "D",
                    "source": "oracles_elixir",
                }
            )
        matches = sorted(matches, key=lambda row: row["date"], reverse=True)[: args.limit]
        if not matches:
            continue
        payload = {
            "team": target["team"],
            "league_key": target["league_key"],
            "matches": matches,
        }
        write_json(output_dir / f"{artifact_key}.json", payload)
        written += 1

    print(json.dumps({"ok": True, "team_history_artifacts": written}, indent=2))


def load_team_targets(team_records_dir: Path) -> dict[str, dict[str, Any]]:
    targets: dict[str, dict[str, Any]] = {}
    for path in team_records_dir.glob("*.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        stem = path.stem
        if "__" not in stem:
            continue
        league_key, team_key = stem.split("__", 1)
        # Prefer the site team identity, but allow matched_team for normal
        # rebrands such as Team Liquid Alienware -> Team Liquid. Do not use it
        # for academy/youth/challengers teams because that can pull parent-team
        # matches into academy recent form.
        names = [payload.get("team"), team_key]
        if not is_development_team(payload.get("team")):
            names.append(payload.get("matched_team"))
        targets[stem] = {
            "team": payload.get("team") or payload.get("matched_team") or team_key,
            "league_key": league_key,
            "team_keys": expanded_team_keys(names),
        }
    return targets


def expanded_team_keys(values: list[object]) -> set[str]:
    keys: set[str] = set()
    for value in values:
        if not value:
            continue
        key = static_key(value)
        keys.add(key)
        for alias in TEAM_KEY_ALIASES.get(key, []):
            keys.add(alias)
    return keys


def load_team_images(data_dir: Path) -> dict[str, str]:
    images: dict[str, str] = {}
    for path in data_dir.glob("matches*.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        for match in payload.get("matches", []):
            add_team_image(images, match.get("blue_team"), match.get("blue_image"))
            add_team_image(images, match.get("blue_code"), match.get("blue_image"))
            add_team_image(images, match.get("red_team"), match.get("red_image"))
            add_team_image(images, match.get("red_code"), match.get("red_image"))
    add_team_record_image_aliases(images, data_dir / "team-records")
    add_static_image_aliases(images)
    return images


def add_team_record_image_aliases(images: dict[str, str], team_records_dir: Path) -> None:
    for path in team_records_dir.glob("*.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        team_key = static_key(payload.get("team"))
        matched_key = static_key(payload.get("matched_team"))
        if team_key in images and matched_key not in images:
            images[matched_key] = images[team_key]
        if matched_key in images and team_key not in images:
            images[team_key] = images[matched_key]


def add_static_image_aliases(images: dict[str, str]) -> None:
    for key, aliases in TEAM_KEY_ALIASES.items():
        alias_values = [key, *aliases]
        image = next((images.get(value) for value in alias_values if images.get(value)), "")
        if not image:
            continue
        for value in alias_values:
            images.setdefault(value, image)


def add_team_image(images: dict[str, str], team: object, image: object) -> None:
    image_text = str(image or "")
    if not team or not image_text or image_text.endswith("/team-tbd.png"):
        return
    images.setdefault(static_key(team), image_text)


def image_for_team(team: object, images: dict[str, str]) -> str:
    return images.get(static_key(team), "")


def load_oe_series(raw_dir: Path) -> list[dict[str, Any]]:
    games: dict[str, list[dict[str, Any]]] = {}
    for path in sorted(raw_dir.glob("20*_LoL_esports_match_data_from_OraclesElixir.csv")):
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                if row.get("position") != "team":
                    continue
                game_id = row.get("gameid") or ""
                if not game_id:
                    continue
                games.setdefault(game_id, []).append(row)

    buckets: dict[tuple[str, str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for rows in games.values():
        if len(rows) != 2:
            continue
        left, right = sorted(rows, key=lambda row: side_order(row.get("side")))
        left_team = left.get("teamname") or ""
        right_team = right.get("teamname") or ""
        if not left_team or not right_team:
            continue
        league = left.get("league") or right.get("league") or ""
        split = left.get("split") or right.get("split") or ""
        pair = tuple(sorted([static_key(left_team), static_key(right_team)]))
        buckets[(static_key(league), split, pair[0], pair[1])].append({"left": left, "right": right})

    series = []
    for bucket_games in buckets.values():
        for ordered in split_series_games(bucket_games):
            first = ordered[0]
            series.append(series_from_games(ordered, first))
    return sorted(series, key=lambda row: row["date"], reverse=True)


def split_series_games(bucket_games: list[dict[str, dict[str, str]]]) -> list[list[dict[str, dict[str, str]]]]:
    ordered = sorted(bucket_games, key=lambda game: parse_date(game["left"].get("date") or ""))
    series: list[list[dict[str, dict[str, str]]]] = []
    current: list[dict[str, dict[str, str]]] = []
    previous_date = datetime.min
    previous_game_number: int | None = None
    for game in ordered:
        game_date = parse_date(game["left"].get("date") or "")
        game_number = positive_int_or_none(game["left"].get("game"))
        gap_hours = (game_date - previous_date).total_seconds() / 3600 if previous_date != datetime.min else 0
        starts_new_series = bool(current) and (
            (
                game_number is not None
                and previous_game_number is not None
                and game_number <= previous_game_number
            )
            or gap_hours > 8
        )
        if starts_new_series:
            series.append(current)
            current = []
        current.append(game)
        previous_date = game_date
        previous_game_number = game_number
    if current:
        series.append(current)
    return series


def series_from_games(ordered: list[dict[str, dict[str, str]]], first: dict[str, dict[str, str]]) -> dict[str, Any]:
    left_team = first["left"].get("teamname") or ""
    right_team = first["right"].get("teamname") or ""
    left_score = 0
    right_score = 0
    for game in ordered:
        left_won = int_or_zero(game["left"].get("result")) > int_or_zero(game["right"].get("result"))
        right_won = int_or_zero(game["right"].get("result")) > int_or_zero(game["left"].get("result"))
        left_score += 1 if same_team(game["left"].get("teamname"), left_team) and left_won else 0
        left_score += 1 if same_team(game["right"].get("teamname"), left_team) and right_won else 0
        right_score += 1 if same_team(game["left"].get("teamname"), right_team) and left_won else 0
        right_score += 1 if same_team(game["right"].get("teamname"), right_team) and right_won else 0
    return {
        "date": first["left"].get("date") or "",
        "league": first["left"].get("league") or "",
        "split": first["left"].get("split") or "",
        "left_team": left_team,
        "right_team": right_team,
        "left_score": left_score,
        "right_score": right_score,
    }


def side_order(value: object) -> int:
    return 0 if str(value).lower() == "blue" else 1


def side_for_target(series: dict[str, Any], keys: set[str]) -> str:
    if static_key(series["left_team"]) in keys:
        return "left"
    if static_key(series["right_team"]) in keys:
        return "right"
    return ""


def same_team(left: object, right: object) -> bool:
    return static_key(left) == static_key(right)


def is_development_team(value: object) -> bool:
    key = static_key(value)
    return any(part in key.split("-") for part in ["academy", "youth", "challengers"])


def static_key(value: object) -> str:
    text = str(value or "all").lower()
    key = "".join(char if char.isalnum() else "-" for char in text)
    key = "-".join(part for part in key.split("-") if part)
    return LEAGUE_KEY_ALIASES.get(key, key or "all")


def parse_date(value: str) -> datetime:
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return datetime.min


def int_or_zero(value: object) -> int:
    try:
        return int(float(str(value or 0)))
    except ValueError:
        return 0


def positive_int_or_none(value: object) -> int | None:
    number = int_or_zero(value)
    return number if number > 0 else None


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
