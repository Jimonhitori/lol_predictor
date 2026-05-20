from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the live win-probability pipeline: labels, backfill, train, export, and verify."
    )
    parser.add_argument("--league", action="append", default=[], help="League to discover for labels. Repeatable.")
    parser.add_argument("--data-dir", action="append", type=Path, default=[], help="Oracle's Elixir data directory. Repeatable.")
    parser.add_argument("--labels", type=Path, default=Path("data/live_snapshots/live_labels.csv"))
    parser.add_argument("--backfill-dir", type=Path, default=Path("data/live_snapshots/backfill_pipeline"))
    parser.add_argument("--model-path", type=Path, default=Path("models/live_win_probability.joblib"))
    parser.add_argument("--exported-model", type=Path, default=Path("docs/static/data/live_model.json"))
    parser.add_argument("--verify-input", type=Path, help="Snapshot JSONL used to verify exported model parity.")
    parser.add_argument("--schedule-pages", type=int, default=12)
    parser.add_argument("--interval-seconds", type=int, default=30)
    parser.add_argument("--max-frames-per-game", type=int, default=0)
    parser.add_argument("--min-rows", type=int, default=100)
    parser.add_argument("--model-name", default="live_logreg_v1")
    parser.add_argument("--include-team-features", action="store_true")
    parser.add_argument("--skip-labels", action="store_true")
    parser.add_argument("--skip-backfill", action="store_true")
    parser.add_argument("--skip-train", action="store_true")
    parser.add_argument("--skip-export", action="store_true")
    parser.add_argument("--skip-verify", action="store_true")
    parser.add_argument("--overwrite-backfill", action="store_true")
    parser.add_argument("--skip-details", action="store_true", help="Skip livestats details calls during backfill.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.skip_labels:
        leagues = args.league or ["LCK"]
        run(
            [
                "-m",
                "lol_predictor.live_labels",
                "--discover-schedule",
                "--schedule-pages",
                str(args.schedule_pages),
                "--output",
                str(args.labels),
                *repeated("--league", leagues),
                *repeated("--data-dir", args.data_dir),
            ]
        )
    if not args.skip_backfill:
        command = [
            "-m",
            "lol_predictor.live_backfill",
            "--event-ids-from-labels",
            "--labels",
            str(args.labels),
            "--output-dir",
            str(args.backfill_dir),
            "--interval-seconds",
            str(args.interval_seconds),
            "--max-frames-per-game",
            str(args.max_frames_per_game),
        ]
        if args.overwrite_backfill:
            command.append("--overwrite")
        if args.skip_details:
            command.append("--skip-details")
        run(command)
    if not args.skip_train:
        command = [
                "-m",
                "lol_predictor.live_train",
                str(args.backfill_dir / "*.jsonl"),
                "--model-path",
                str(args.model_path),
                "--min-rows",
                str(args.min_rows),
                "--max-interval-seconds",
                str(args.interval_seconds),
        ]
        if args.include_team_features:
            command.append("--include-team-features")
        run(command)
    if not args.skip_export:
        run(
            [
                "-m",
                "lol_predictor.live_export_model",
                "--model-path",
                str(args.model_path),
                "--output",
                str(args.exported_model),
                "--name",
                args.model_name,
            ]
        )
    if not args.skip_verify:
        verify_input = args.verify_input or newest_jsonl(args.backfill_dir)
        if verify_input is None:
            raise SystemExit("No verification input found. Pass --verify-input or run backfill first.")
        run(
            [
                "-m",
                "lol_predictor.live_verify_model",
                "--model-path",
                str(args.model_path),
                "--exported-model",
                str(args.exported_model),
                "--input",
                str(verify_input),
            ]
        )


def repeated(flag: str, values: list[object]) -> list[str]:
    result: list[str] = []
    for value in values:
        result.extend([flag, str(value)])
    return result


def newest_jsonl(directory: Path) -> Path | None:
    if not directory.exists():
        return None
    paths = sorted(directory.glob("*.jsonl"), key=lambda path: path.stat().st_mtime, reverse=True)
    return paths[0] if paths else None


def run(args: list[str]) -> None:
    command = [sys.executable, *args]
    print("+ " + " ".join(command), flush=True)
    subprocess.run(command, check=True)


if __name__ == "__main__":
    main()
