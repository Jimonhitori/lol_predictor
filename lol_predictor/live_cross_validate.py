from __future__ import annotations

import argparse
import json
from pathlib import Path
from statistics import mean, median
from typing import Any

import pandas as pd

from .live_features import live_feature_columns, live_training_frame
from .live_train import expand_input_paths, metrics_payload, split_by_game
from .model import evaluate, make_pipeline


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate live model stability across repeated game-level splits.")
    parser.add_argument("inputs", nargs="+", type=Path, help="JSONL files produced by live backfill/collect.")
    parser.add_argument("--splits", type=int, default=20)
    parser.add_argument("--test-fraction", type=float, default=0.2)
    parser.add_argument("--max-interval-seconds", type=int, default=30)
    parser.add_argument("--random-state", type=int, default=7)
    parser.add_argument("--regularization-c", type=float, default=0.001)
    parser.add_argument("--include-team-features", action="store_true")
    parser.add_argument("--output", type=Path, help="Optional JSON report path.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    frame = live_training_frame(expand_input_paths(args.inputs), max_interval_seconds=args.max_interval_seconds)
    if frame.empty:
        raise SystemExit("No labeled live frames found.")
    if frame["target"].nunique() < 2:
        raise SystemExit("Need both blue-win and red-win labeled rows to cross-validate.")

    columns = live_feature_columns(frame)
    if not args.include_team_features:
        columns = [column for column in columns if column not in {"blue_team", "red_team"}]
    if not columns:
        raise SystemExit("No usable live feature columns were found.")

    split_reports = []
    for index in range(max(1, args.splits)):
        train, test = split_by_game(
            frame,
            args.test_fraction,
            split_mode="random",
            random_state=args.random_state + index,
        )
        pipeline = make_pipeline(train, columns, regularization_c=args.regularization_c)
        pipeline.fit(train[columns], train["target"])
        metrics = evaluate(pipeline, test[columns], test["target"])
        split_reports.append(
            {
                "split": index,
                "random_state": int(args.random_state + index),
                "train_rows": int(len(train)),
                "test_rows": int(len(test)),
                "test_games": int(test[["event_id", "game_id"]].drop_duplicates().shape[0]),
                "target_rate": float(pd.to_numeric(test["target"], errors="coerce").mean()),
                **metrics_payload(metrics),
            }
        )

    report = {
        "rows": int(len(frame)),
        "games": int(frame[["event_id", "game_id"]].drop_duplicates().shape[0]),
        "feature_schema": "live_frame_v1",
        "feature_columns": columns,
        "include_team_features": bool(args.include_team_features),
        "regularization_c": float(args.regularization_c),
        "test_fraction": float(args.test_fraction),
        "splits": split_reports,
        "summary": summarize_splits(split_reports),
    }
    print_report(report)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote report: {args.output}")


def summarize_splits(splits: list[dict[str, Any]]) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    for key in ["accuracy", "brier", "log_loss", "roc_auc"]:
        values = [float(row[key]) for row in splits if row.get(key) is not None]
        if values:
            summary[key] = {
                "mean": mean(values),
                "median": median(values),
                "min": min(values),
                "max": max(values),
            }
    return summary


def print_report(report: dict[str, Any]) -> None:
    print(f"Rows: {report['rows']} games={report['games']} splits={len(report['splits'])}")
    for key, stats in report["summary"].items():
        print(
            f"{key}: "
            f"mean={stats['mean']:.4f} "
            f"median={stats['median']:.4f} "
            f"min={stats['min']:.4f} "
            f"max={stats['max']:.4f}"
        )


if __name__ == "__main__":
    main()
