from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
from pathlib import Path
from io import StringIO
from types import SimpleNamespace
from urllib.parse import quote
from urllib.request import Request, urlopen

import pandas as pd

from .league_groups import filter_leagues
from .patches import filter_patch, latest_patch
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
APP_JS_VERSION = hashlib.sha1(APP_JS.encode("utf-8")).hexdigest()[:10]
APP_CSS_VERSION = hashlib.sha1(APP_CSS.encode("utf-8")).hexdigest()[:10]
GOL_USER_AGENT = "Mozilla/5.0 (compatible; lol-predictor-static-export/1.0)"


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
    options = options_payload(context.rows)
    write_json(data_dir / "options.json", options)

    all_matches = []
    for league_group in LEAGUE_GROUPS:
        for region in REGIONS:
            query = {"league_group": [league_group], "region": [region]}
            write_json(data_dir / "summaries" / f"{static_key(league_group)}__{static_key(region)}.json", enriched_summary(context, query))
            payload = matches_payload(context, query)
            write_json(data_dir / f"matches-{static_key(league_group)}__{static_key(region)}.json", payload)
            if league_group == "all" and region == "all":
                all_matches = list(payload.get("matches") or [])

    for league in options.get("standings_leagues", []):
        write_json(data_dir / "summaries" / f"league__{static_key(league)}.json", enriched_summary(context, {"league": [league]}))

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
        f'<script>window.STATIC_SITE = true;</script>\n  <script src="static/app.js?v={APP_JS_VERSION}"></script>',
    ).replace(
        '<link rel="stylesheet" href="/static/styles.css">',
        f'<link rel="stylesheet" href="static/styles.css?v={APP_CSS_VERSION}">',
    )


def strip_static_model_blocks(html: str) -> str:
    html = re.sub(r'\s*<form id="predictForm" class="panel">.*?</form>', "", html, flags=re.S)
    html = re.sub(
        r'\s*<section class="panel">\s*<h2>Model Sandbox</h2>.*?<div id="seasonRecords" class="table compactTable"></div>\s*</section>',
        "",
        html,
        flags=re.S,
    )
    html = html.replace('<strong id="centerPrediction">-</strong>', '')
    html = html.replace('<strong id="centerPrediction"></strong>', '')
    html = html.replace("LoL Esports Predictor", "LoL Esports Dashboard")
    html = html.replace("Select a match to preview prediction context.", "Select a match to preview match context.")
    return html


def static_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(value or "all").lower()).strip("-") or "all"


def safe_summary(context: AppContext, query: dict[str, list[str]]) -> dict[str, object]:
    try:
        return summary_payload(context.rows, query, context)
    except ValueError:
        return {"patch": str(context.patch), "games": 0, "leagues": [], "champions": [], "teams": []}


def enriched_summary(context: AppContext, query: dict[str, list[str]]) -> dict[str, object]:
    payload = safe_summary(context, query)
    presence = champion_presence_for_query(context.rows, query)
    if presence:
        merge_champion_presence(payload.get("champions") or [], presence)
        for rows in (payload.get("champions_by_role") or {}).values():
            merge_champion_presence(rows or [], presence)
    sort_champion_meta(payload.get("champions") or [])
    for rows in (payload.get("champions_by_role") or {}).values():
        sort_champion_meta(rows or [])
    return payload


def champion_presence_for_query(rows: pd.DataFrame, query: dict[str, list[str]]) -> dict[str, dict[str, float]]:
    league_group = first_query(query, "league_group", "all")
    region = first_query(query, "region", "all")
    league = first_query(query, "league", "")
    filtered = filter_leagues(rows, league_group=league_group, region=region)
    if league:
        filtered = filtered[filtered["league"].astype(str).eq(league)]
    if filtered.empty:
        return {}
    patch = latest_patch(filtered)
    patch_rows = filter_patch(filtered, patch=str(patch))
    team_rows = patch_rows[patch_rows["position"].astype(str).eq("team")].copy()
    if team_rows.empty:
        return {}
    merged: dict[str, dict[str, float]] = {}
    denominator = 0.0
    for _, group in team_rows.groupby("league"):
        split = latest_split(group)
        if not split:
            continue
        stats = fetch_gol_champion_presence(split)
        if not stats:
            continue
        denominator += max(gol_presence_denominator(stats), max_presence_count(stats))
        for key, row in stats.items():
            target = merged.setdefault(key, {"picks": 0.0, "bans": 0.0, "presence_count": 0.0})
            target["picks"] += float(row.get("picks") or 0)
            target["bans"] += float(row.get("bans") or 0)
            target["presence_count"] += float(row.get("presence_count") or 0)
    if not merged or not denominator:
        return {}
    for row in merged.values():
        row["ban_rate"] = min(row["bans"] / denominator, 1.0)
        row["presence"] = min(row["presence_count"] / denominator, 1.0)
    return merged


def latest_split(rows: pd.DataFrame) -> str:
    if "split" not in rows.columns or rows.empty:
        return ""
    sorted_rows = rows.sort_values("date")
    return str(sorted_rows["split"].dropna().astype(str).iloc[-1]) if not sorted_rows["split"].dropna().empty else ""


_GOL_CACHE: dict[str, dict[str, dict[str, float]]] = {}


def fetch_gol_champion_presence(tournament: str) -> dict[str, dict[str, float]]:
    if tournament in _GOL_CACHE:
        return _GOL_CACHE[tournament]
    url = f"https://gol.gg/champion/list/season-S16/split-ALL/tournament-{quote(tournament)}/"
    try:
        request = Request(url, headers={"User-Agent": GOL_USER_AGENT})
        with urlopen(request, timeout=60) as response:
            html = response.read().decode("utf-8", errors="replace")
        tables = pd.read_html(StringIO(html))
    except Exception as error:
        print(f"Skipping Games of Legends presence for {tournament}: {error}")
        _GOL_CACHE[tournament] = {}
        return {}
    champion_table = next((table for table in tables if {"Champion", "Picks", "Bans", "BP%"}.issubset(set(table.columns))), None)
    if champion_table is None:
        _GOL_CACHE[tournament] = {}
        return {}
    stats: dict[str, dict[str, float]] = {}
    for row in champion_table.to_dict("records"):
        champion = str(row.get("Champion") or "")
        picks = number_value(row.get("Picks"))
        bans = number_value(row.get("Bans"))
        bp = number_value(row.get("BP%"))
        presence_count = picks + bans
        denominator = presence_count / (bp / 100.0) if bp else 0.0
        stats[champion_key(champion)] = {
            "picks": picks,
            "bans": bans,
            "bp": bp,
            "presence_count": presence_count,
            "denominator": denominator,
        }
    _GOL_CACHE[tournament] = stats
    return stats


def gol_presence_denominator(stats: dict[str, dict[str, float]]) -> float:
    perfect_presence = [
        float(row.get("presence_count") or 0)
        for row in stats.values()
        if float(row.get("bp") or 0) >= 99.0
    ]
    if perfect_presence:
        return max(perfect_presence)
    inferred = [
        float(row.get("denominator") or 0)
        for row in stats.values()
        if float(row.get("denominator") or 0) > 0
    ]
    return max(inferred) if inferred else 0.0


def max_presence_count(stats: dict[str, dict[str, float]]) -> float:
    return max((float(row.get("presence_count") or 0) for row in stats.values()), default=0.0)


def merge_champion_presence(rows: list[dict[str, object]], presence: dict[str, dict[str, float]]) -> None:
    for row in rows:
        stats = presence.get(champion_key(row.get("name", "")))
        if not stats:
            continue
        row["bans"] = int(stats.get("bans") or 0)
        row["ban_rate"] = percent_text(float(stats.get("ban_rate") or 0))
        row["presence"] = percent_text(float(stats.get("presence") or 0))


def sort_champion_meta(rows: list[dict[str, object]]) -> None:
    rows.sort(
        key=lambda row: (
            percent_number(row.get("presence")) / 100.0,
            int(row.get("picks") or row.get("games") or 0),
            float(str(row.get("winrate") or "0").replace("%", "") or 0),
        ),
        reverse=True,
    )


def number_value(value: object) -> float:
    text = str(value).replace("%", "").replace(",", "").strip()
    try:
        return float(text)
    except ValueError:
        return 0.0


def percent_number(value: object) -> float:
    text = str(value or "").replace("%", "").strip()
    try:
        return float(text)
    except ValueError:
        return 0.0


def percent_text(value: float) -> str:
    return f"{min(max(value, 0.0), 1.0) * 100:.1f}%"


def champion_key(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value).lower())


def first_query(query: dict[str, list[str]], key: str, default: str = "") -> str:
    values = query.get(key) or []
    return values[0] if values else default


def write_json(path: Path, payload: object) -> None:
    write_text(path, json.dumps(payload, ensure_ascii=False, indent=2))


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


if __name__ == "__main__":
    main()
