from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import pandas as pd

from .live_features import live_training_frame
from .live_train import expand_input_paths, metrics_payload, split_by_game
from .model import evaluate


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate a trained live model overall and by game-time bucket.")
    parser.add_argument("inputs", nargs="+", type=Path, help="JSONL files produced by live backfill/collect.")
    parser.add_argument("--model-path", type=Path, default=Path("models/live_win_probability.joblib"))
    parser.add_argument("--test-fraction", type=float, default=0.2)
    parser.add_argument("--max-interval-seconds", type=int, default=30)
    parser.add_argument("--bucket-seconds", type=int, default=300)
    parser.add_argument("--output", type=Path, help="Optional JSON report path.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    import joblib

    bundle = joblib.load(args.model_path)
    frame = live_training_frame(expand_input_paths(args.inputs), max_interval_seconds=args.max_interval_seconds)
    if frame.empty:
        raise SystemExit("No labeled live frames found.")
    _, test = split_by_game(frame, args.test_fraction)
    columns = list(bundle["feature_columns"])
    for column in columns:
        if column not in test.columns:
            test[column] = None
    pipeline = bundle["pipeline"]
    report = {
        "model_path": str(args.model_path),
        "feature_schema": bundle.get("feature_schema", "live_frame_v1"),
        "feature_columns": columns,
        "rows": int(len(test)),
        "games": int(test[["event_id", "game_id"]].drop_duplicates().shape[0]),
        "overall": metrics_payload(evaluate(pipeline, test[columns], test["target"])),
        "by_time_bucket": bucket_metrics(pipeline, test, columns, args.bucket_seconds),
    }
    print_report(report)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote report: {args.output}")


def bucket_metrics(pipeline: Any, frame: pd.DataFrame, columns: list[str], bucket_seconds: int) -> list[dict[str, Any]]:
    data = frame.copy()
    bucket_seconds = max(1, bucket_seconds)
    data["time_bucket_start"] = (pd.to_numeric(data["game_time"], errors="coerce").fillna(0) // bucket_seconds * bucket_seconds).astype(int)
    rows: list[dict[str, Any]] = []
    for bucket, group in data.groupby("time_bucket_start", sort=True):
        metrics = evaluate(pipeline, group[columns], group["target"])
        rows.append(
            {
                "start_seconds": int(bucket),
                "end_seconds": int(bucket + bucket_seconds),
                "games": int(group[["event_id", "game_id"]].drop_duplicates().shape[0]),
                **metrics_payload(metrics),
            }
        )
    return rows


def print_report(report: dict[str, Any]) -> None:
    overall = report["overall"]
    print(f"Rows: {report['rows']} games={report['games']}")
    print(
        "Overall: "
        f"accuracy={overall['accuracy']:.4f} "
        f"brier={overall['brier']:.4f} "
        f"log_loss={overall['log_loss']:.4f} "
        f"roc_auc={format_optional(overall['roc_auc'])}"
    )
    print("By time bucket:")
    for row in report["by_time_bucket"]:
        print(
            f"  {row['start_seconds']:>4}-{row['end_seconds']:<4}s "
            f"rows={row['rows']:<4} games={row['games']:<3} "
            f"acc={row['accuracy']:.4f} "
            f"brier={row['brier']:.4f} "
            f"auc={format_optional(row['roc_auc'])}"
        )


def format_optional(value: Any) -> str:
    return "n/a" if value is None else f"{float(value):.4f}"


if __name__ == "__main__":
    main()
