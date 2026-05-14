from __future__ import annotations

import argparse
import json
import os
import re
import shutil
from pathlib import Path
from types import SimpleNamespace

from .web_app import (
    APP_CSS,
    APP_HTML,
    APP_JS,
    MATCH_HTML,
    AppContext,
    head_to_head_payload,
    match_detail_payload,
    matches_payload,
    options_payload,
    roster_payload,
    summary_payload,
    team_record_payload,
)


LEAGUE_GROUPS = ["all", "major", "secondary"]
REGIONS = ["all", "korea", "china", "emea", "americas", "pacific", "international"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export a GitHub Pages compatible static snapshot.")
    parser.add_argument("--out-dir", type=Path, default=Path("docs"))
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--model-path", type=Path, default=Path("models/2026_all_patches_lck_lpl_regions_synergy.joblib"))
    parser.add_argument("--patch-notes", type=Path, default=Path("data/patch_notes/riot_2024_2026_patch_notes.json"))
    parser.add_argument("--champion-reference", type=Path, default=Path("data/features/champion_reference.csv"))
    parser.add_argument("--today-cache", type=Path, default=Path("data/raw/today_matches.json"))
    parser.add_argument("--max-details", type=int, default=12)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    os.environ["LOL_ESPORTS_SKIP_LIVE"] = "1"
    context = AppContext(
        SimpleNamespace(
            data_dir=args.data_dir,
            model_path=args.model_path,
            patch_notes=args.patch_notes,
            champion_reference=args.champion_reference,
            today_cache=args.today_cache,
        )
    )
    out_dir = args.out_dir
    data_dir = out_dir / "static" / "data"
    if data_dir.exists():
        shutil.rmtree(data_dir)
    write_text(out_dir / "index.html", static_html(APP_HTML))
    write_text(out_dir / "match.html", static_html(MATCH_HTML))
    write_text(out_dir / "static" / "styles.css", APP_CSS)
    write_text(out_dir / "static" / "app.js", APP_JS)
    write_json(data_dir / "options.json", options_payload(context.rows))

    all_matches = []
    for league_group in LEAGUE_GROUPS:
        for region in REGIONS:
            query = {"league_group": [league_group], "region": [region]}
            write_json(data_dir / "summaries" / f"{static_key(league_group)}__{static_key(region)}.json", safe_summary(context, query))
            payload = matches_payload(context, query)
            write_json(data_dir / f"matches-{static_key(league_group)}__{static_key(region)}.json", payload)
            if league_group == "all" and region == "all":
                all_matches = list(payload.get("matches") or [])

    seen_teams: set[tuple[str, str]] = set()
    seen_pairs: set[tuple[str, str, str]] = set()
    for match in all_matches[: max(0, args.max_details)]:
        match_id = str(match.get("id") or "")
        if not match_id:
            continue
        details = match_detail_payload(context, match_id)
        if not details:
            continue
        write_json(data_dir / "matches" / f"{match_id}.json", details)
        teams = details.get("teams") or []
        league = str(details.get("league") or match.get("league") or "all")
        for team in teams:
            name = str(team.get("name") or team.get("code") or "")
            if name:
                seen_teams.add((league, name))
        if len(teams) >= 2:
            left = teams[0]
            right = teams[1]
            left_name = str(left.get("name") or left.get("code") or "")
            right_name = str(right.get("name") or right.get("code") or "")
            pair_key = (league, left_name, right_name)
            if left_name and right_name and pair_key not in seen_pairs:
                seen_pairs.add(pair_key)
                write_json(
                    data_dir / "h2h" / f"{static_key(league)}__{static_key(left_name)}__{static_key(right_name)}.json",
                    head_to_head_payload(
                        context.rows,
                        left_name,
                        right_name,
                        league,
                        str(left.get("code") or ""),
                        str(right.get("code") or ""),
                    ),
                )

    for league, team in sorted(seen_teams):
        write_json(data_dir / "rosters" / f"{static_key(team)}.json", roster_payload(context.rows, team))
        write_json(data_dir / "team-records" / f"{static_key(league)}__{static_key(team)}.json", team_record_payload(context, team, league))

    print(f"Exported static snapshot to {out_dir}")


def static_html(html: str) -> str:
    html = strip_static_model_blocks(html)
    return html.replace('<a class="backLink" href="/">', '<a class="backLink" href="index.html">').replace(
        '<script src="/static/app.js"></script>',
        '<script>window.STATIC_SITE = true;</script>\n  <script src="static/app.js"></script>',
    ).replace(
        '<link rel="stylesheet" href="/static/styles.css">',
        '<link rel="stylesheet" href="static/styles.css">',
    )


def strip_static_model_blocks(html: str) -> str:
    html = re.sub(r'\s*<form id="predictForm" class="panel">.*?</form>', "", html, flags=re.S)
    html = re.sub(
        r'\s*<section class="panel">\s*<h2>Model Sandbox</h2>.*?<div id="seasonRecords" class="table compactTable"></div>\s*</section>',
        "",
        html,
        flags=re.S,
    )
    html = html.replace('<strong id="centerPrediction">-</strong>', '<strong id="centerPrediction"></strong>')
    html = html.replace("LoL Esports Predictor", "LoL Esports Dashboard")
    html = html.replace("Select a match to preview prediction context.", "Select a match to preview match context.")
    return html


def static_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(value or "all").lower()).strip("-") or "all"


def safe_summary(context: AppContext, query: dict[str, list[str]]) -> dict[str, object]:
    try:
        return summary_payload(context.rows, query)
    except ValueError:
        return {"patch": str(context.patch), "games": 0, "leagues": [], "champions": [], "teams": []}


def write_json(path: Path, payload: object) -> None:
    write_text(path, json.dumps(payload, ensure_ascii=False, indent=2))


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


if __name__ == "__main__":
    main()
