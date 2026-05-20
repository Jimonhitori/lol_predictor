from __future__ import annotations

import argparse
from pathlib import Path

from .live_features import live_feature_columns, live_training_frame


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train a live LoL win-probability model from livestats JSONL.")
    parser.add_argument("inputs", nargs="+", type=Path, help="JSONL files produced by live history/live snapshot collectors.")
    parser.add_argument("--model-path", type=Path, default=Path("models/live_win_probability.joblib"))
    parser.add_argument("--test-fraction", type=float, default=0.2)
    parser.add_argument("--max-interval-seconds", type=int, default=30)
    parser.add_argument("--min-rows", type=int, default=100)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    import joblib

    from .model import evaluate, make_pipeline
    frame = live_training_frame(args.inputs, max_interval_seconds=args.max_interval_seconds)
    if len(frame) < args.min_rows:
        raise SystemExit(
            f"Not enough live frames to train: rows={len(frame)} min_rows={args.min_rows}. "
            "Collect more completed games or lower --min-rows for a smoke test."
        )
    cols = live_feature_columns(frame)
    if not cols:
        raise SystemExit("No usable live feature columns were found.")

    split_at = max(1, int(len(frame) * (1 - args.test_fraction)))
    split_at = min(split_at, len(frame) - 1)
    train = frame.iloc[:split_at].copy()
    test = frame.iloc[split_at:].copy()

    pipeline = make_pipeline(train, cols)
    pipeline.fit(train[cols], train["target"])
    metrics = evaluate(pipeline, test[cols], test["target"])

    args.model_path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(
        {
            "pipeline": pipeline,
            "feature_columns": cols,
            "feature_schema": "live_frame_v1",
            "training_rows": len(train),
            "test_rows": metrics.rows,
        },
        args.model_path,
    )

    print(f"Saved model: {args.model_path}")
    print(f"Rows: train={len(train)} test={metrics.rows}")
    print(f"Accuracy: {metrics.accuracy:.4f}")
    print(f"Brier: {metrics.brier:.4f}")
    print(f"Log loss: {metrics.log_loss:.4f}")
    if metrics.roc_auc is not None:
        print(f"ROC AUC: {metrics.roc_auc:.4f}")


if __name__ == "__main__":
    main()
