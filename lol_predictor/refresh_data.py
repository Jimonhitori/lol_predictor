from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Refresh 2026 LoL esports data and derived features.")
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--models-dir", type=Path, default=Path("models"))
    parser.add_argument("--include-lck-lpl", action="store_true", default=True)
    parser.add_argument("--skip-download", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    run("lol_predictor.download_riot_patch_notes")

    if not args.skip_download:
        run(
            "lol_predictor.download_oe_api_2026",
            "--output",
            str(args.data_dir / "2026_oracles_elixir_api_games.csv"),
            "--raw-output",
            str(args.data_dir / "2026_oracles_elixir_api_games.json"),
            "--sleep",
            "0.02",
        )
        if args.include_lck_lpl:
            run(
                "lol_predictor.download_oe_api_2026",
                "--league",
                "LoL Champions Korea",
                "--league",
                "Tencent LoL Pro League",
                "--output",
                str(args.data_dir / "2026_oracles_elixir_api_games_lck_lpl.csv"),
                "--raw-output",
                str(args.data_dir / "2026_oracles_elixir_api_games_lck_lpl.json"),
                "--sleep",
                "0.02",
            )

    run("lol_predictor.champion_reference", "--data-dir", str(args.data_dir))
    args.models_dir.mkdir(parents=True, exist_ok=True)
    run(
        "lol_predictor.train",
        "--data-dir",
        str(args.data_dir),
        "--model-path",
        str(args.models_dir / "2026_all.joblib"),
    )
    run(
        "lol_predictor.train",
        "--data-dir",
        str(args.data_dir),
        "--league-group",
        "major",
        "--model-path",
        str(args.models_dir / "2026_major.joblib"),
    )


def run(module: str, *args: str) -> None:
    command = [sys.executable, "-m", module, *args]
    print(f"\n$ {' '.join(command)}", flush=True)
    subprocess.run(command, check=True)


if __name__ == "__main__":
    main()
