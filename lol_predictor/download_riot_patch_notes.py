from __future__ import annotations

import argparse
import csv
import html
import json
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin

from .sources import fetch_text


PATCH_NOTES_URL = "https://www.leagueoflegends.com/en-us/news/tags/patch-notes/"
BASE_URL = "https://www.leagueoflegends.com"


@dataclass(frozen=True)
class PatchNoteLink:
    patch: str
    title: str
    url: str
    published_at: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download Riot League patch notes.")
    parser.add_argument("--output-json", type=Path, default=Path("data/patch_notes/riot_2024_2026_patch_notes.json"))
    parser.add_argument("--output-csv", type=Path, default=Path("data/patch_notes/riot_2024_2026_patch_notes.csv"))
    parser.add_argument("--year-prefix", action="append", default=["14", "25", "26"])
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    links = discover_patch_notes(args.year_prefix)
    notes = [download_patch_note(link) for link in links]

    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    args.output_json.write_text(json.dumps(notes, ensure_ascii=False, indent=2), encoding="utf-8")

    with args.output_csv.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=["patch", "riot_patch", "oe_patch", "title", "published_at", "url", "summary", "text"],
        )
        writer.writeheader()
        writer.writerows(notes)

    print(f"Saved JSON: {args.output_json} ({len(notes)} notes)")
    print(f"Saved CSV: {args.output_csv}")


def discover_patch_notes(year_prefix: str | list[str] = "26") -> list[PatchNoteLink]:
    year_prefixes = [year_prefix] if isinstance(year_prefix, str) else year_prefix
    html_text = fetch_text(PATCH_NOTES_URL)
    pattern = re.compile(r'<a role="button".*?</a>', re.IGNORECASE | re.DOTALL)
    links: dict[str, PatchNoteLink] = {}
    for card in pattern.findall(html_text):
        title_match = re.search(r'aria-label="([^"]*Patch ((?:\d+\.\d+)|(?:\d+\.S\d+\.\d+)) Notes)"', card)
        href_match = re.search(r'href="([^"]+)"', card)
        published_match = re.search(r'<time dateTime="([^"]+)"', card)
        if not (title_match and href_match and published_match):
            continue
        patch = normalize_patch(title_match.group(2))
        if patch.split(".", 1)[0] not in year_prefixes:
            continue
        links[patch] = PatchNoteLink(
            patch=patch,
            title=html.unescape(title_match.group(1)),
            url=urljoin(BASE_URL, href_match.group(1)),
            published_at=published_match.group(1),
        )
    for prefix in year_prefixes:
        for link in generated_patch_note_links(prefix):
            links.setdefault(link.patch, link)
    return sorted(links.values(), key=lambda item: patch_key(item.patch))


def generated_patch_note_links(year_prefix: str) -> list[PatchNoteLink]:
    candidates = []
    for minor in range(1, 25):
        patch = f"{int(year_prefix)}.{minor:02d}"
        slugs = [f"patch-{int(year_prefix)}-{minor:02d}-notes"]
        if year_prefix == "14":
            slugs.insert(0, f"patch-14-{minor}-notes")
        if year_prefix == "25" and minor <= 3:
            slugs.append(f"patch-25-s1-{minor}-notes")
        for slug in slugs:
            url = f"{BASE_URL}/en-us/news/game-updates/{slug}/"
            try:
                html_text = fetch_text(url)
            except (HTTPError, URLError):
                continue
            title_match = re.search(r"<h1[^>]*>(.*?)</h1>", html_text, flags=re.IGNORECASE | re.DOTALL)
            published_match = re.search(r'<time dateTime="([^"]+)"', html_text)
            title = html_to_text(title_match.group(1)) if title_match else f"Patch {patch} Notes"
            published_at = published_match.group(1) if published_match else ""
            candidates.append(PatchNoteLink(patch=patch, title=title, url=url, published_at=published_at))
            break
    return candidates


def download_patch_note(link: PatchNoteLink) -> dict[str, str]:
    html_text = fetch_text(link.url)
    text = html_to_text(html_text)
    summary = extract_description(html_text)
    return {
        "patch": link.patch,
        "riot_patch": link.patch,
        "oe_patch": riot_patch_to_oe_patch(link.patch),
        "title": link.title,
        "published_at": link.published_at,
        "url": link.url,
        "summary": summary,
        "text": text,
    }


def html_to_text(html_text: str) -> str:
    html_text = re.sub(r"<(script|style)\b.*?</\1>", " ", html_text, flags=re.IGNORECASE | re.DOTALL)
    html_text = re.sub(r"</(p|div|li|h[1-6]|tr)>", "\n", html_text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", html_text)
    text = html.unescape(text)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*", "\n", text)
    return text.strip()


def extract_description(html_text: str) -> str:
    match = re.search(r'<meta name="description" content="([^"]+)"', html_text)
    if match:
        return html.unescape(match.group(1)).strip()
    return ""


def normalize_patch(patch: str) -> str:
    patch = patch.upper().replace(".S1.", ".")
    major, minor = patch.split(".", 1)
    return f"{int(major)}.{int(minor):02d}"


def riot_patch_to_oe_patch(patch: str) -> str:
    major, minor = normalize_patch(patch).split(".")
    major_number = int(major)
    oe_major = major_number - 10 if major_number >= 25 else major_number
    return f"{oe_major}.{minor}"


def patch_key(patch: str) -> tuple[int, int]:
    major, minor = normalize_patch(patch).split(".")
    return int(major), int(minor)


if __name__ == "__main__":
    main()
