from __future__ import annotations

import argparse
from pathlib import Path

from .sources import (
    ORACLES_ELIXIR_MATCH_DATA_URL,
    discover_oracles_elixir_downloads,
    download_files,
    filter_by_years,
    links_from_urls,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download Oracle's Elixir match data files.")
    parser.add_argument("--output-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--source-url", default=ORACLES_ELIXIR_MATCH_DATA_URL)
    parser.add_argument("--year", type=int, action="append", dest="years")
    parser.add_argument("--url", action="append", dest="urls", help="Download a specific CSV/XLSX URL.")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--list", action="store_true", help="List discovered files without downloading.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.urls:
        links = links_from_urls(args.urls)
    else:
        links = discover_oracles_elixir_downloads(args.source_url)
        links = filter_by_years(links, args.years)

    if not links:
        raise SystemExit("No Oracle's Elixir data files found for the requested options.")

    if args.list:
        for link in links:
            print(f"{link.filename}\t{link.url}")
        return

    downloaded = download_files(links, args.output_dir, overwrite=args.overwrite)
    for path in downloaded:
        print(path)


if __name__ == "__main__":
    main()
