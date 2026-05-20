from __future__ import annotations

import argparse
import random
from pathlib import Path

import pandas as pd

from .live_features import live_feature_columns, live_training_frame


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train a live LoL win-probability model from livestats JSONL.")
    parser.add_argument("inputs", nargs="+", type=Path, help="JSONL files produced by live history/live snapshot collectors.")
    parser.add_argument("--model-path", type=Path, default=Path("models/live_win_probability.joblib"))
    parser.add_argument("--test-fraction", type=float, default=0.2)
    parser.add_argument("--split-mode", choices=["random", "ordered"], default="random")
    parser.add_argument("--random-state", type=int, default=7)
    parser.add_argument("--regularization-c", type=float, default=0.001)
    parser.add_argument("--max-interval-seconds", type=int, default=30)
    parser.add_argument("--min-rows", type=int, default=100)
    parser.add_argument(
        "--include-team-features",
        action="store_true",
        help="Include blue_team/red_team identity features. Off by default to reduce small-sample overfitting.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    import joblib

    from .model import evaluate, make_pipeline
    inputs = expand_input_paths(args.inputs)
    frame = live_training_frame(inputs, max_interval_seconds=args.max_interval_seconds)
    if len(frame) < args.min_rows:
        raise SystemExit(
            f"Not enough live frames to train: rows={len(frame)} min_rows={args.min_rows}. "
            "Collect more completed games or lower --min-rows for a smoke test."
        )
    cols = live_feature_columns(frame)
    if not args.include_team_features:
        cols = [col for col in cols if col not in {"blue_team", "red_team"}]
    if not cols:
        raise SystemExit("No usable live feature columns were found.")
    if frame["target"].nunique() < 2:
        raise SystemExit("Need both blue-win and red-win labeled rows to train a calibrated live model.")

    train, test = split_by_game(frame, args.test_fraction, split_mode=args.split_mode, random_state=args.random_state)

    pipeline = make_pipeline(train, cols, regularization_c=args.regularization_c)
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
            "split": "grouped_by_game_id",
            "split_mode": args.split_mode,
            "random_state": int(args.random_state),
            "regularization_c": float(args.regularization_c),
            "include_team_features": bool(args.include_team_features),
            "metrics": metrics_payload(metrics),
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


def metrics_payload(metrics: object) -> dict[str, float | int | None]:
    return {
        "rows": int(metrics.rows),
        "accuracy": float(metrics.accuracy),
        "brier": float(metrics.brier),
        "log_loss": float(metrics.log_loss),
        "roc_auc": None if metrics.roc_auc is None else float(metrics.roc_auc),
    }


def expand_input_paths(inputs: list[Path]) -> list[Path]:
    expanded: list[Path] = []
    for path in inputs:
        text = str(path)
        if any(char in text for char in "*?[]"):
            matches = sorted(Path().glob(text))
            expanded.extend(match for match in matches if match.is_file())
        else:
            expanded.append(path)
    if not expanded:
        raise SystemExit("No input JSONL files matched.")
    return expanded


def split_by_game(
    frame: pd.DataFrame,
    test_fraction: float,
    *,
    split_mode: str = "random",
    random_state: int = 7,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    game_order = (
        frame.groupby(["event_id", "game_id"], sort=False)["game_time"]
        .max()
        .reset_index()
        .sort_values(["event_id", "game_id"])
    )
    games = list(zip(game_order["event_id"].astype(str), game_order["game_id"].astype(str)))
    if len(games) < 2:
        raise SystemExit("Need at least two labeled games to create a train/test split.")
    target_test_games = max(1, int(round(len(games) * test_fraction)))
    if split_mode == "random":
        split = random_group_split(frame, games, target_test_games, random_state)
        if split is not None:
            return split
    candidate_counts = list(range(target_test_games, len(games)))
    candidate_counts = sorted(set(candidate_counts), key=lambda count: (abs(count - target_test_games), count))
    best_split: tuple[pd.DataFrame, pd.DataFrame] | None = None
    for test_game_count in candidate_counts:
        test_games = set(games[-test_game_count:])
        is_test = frame.apply(lambda row: (str(row["event_id"]), str(row["game_id"])) in test_games, axis=1)
        train = frame.loc[~is_test].copy()
        test = frame.loc[is_test].copy()
        if train.empty or test.empty:
            continue
        if train["target"].nunique() >= 2 and test["target"].nunique() >= 2:
            return train, test
        if best_split is None:
            best_split = (train, test)
    if best_split is None:
        raise SystemExit("Could not create a non-empty grouped train/test split.")
    train, test = best_split
    if train["target"].nunique() < 2:
        raise SystemExit("Grouped split left the training set with only one target class.")
    return train, test


def random_group_split(
    frame: pd.DataFrame,
    games: list[tuple[str, str]],
    target_test_games: int,
    random_state: int,
) -> tuple[pd.DataFrame, pd.DataFrame] | None:
    if len(games) < 2:
        return None
    test_game_count = min(max(1, target_test_games), len(games) - 1)
    for offset in range(100):
        shuffled = list(games)
        random.Random(random_state + offset).shuffle(shuffled)
        test_games = set(shuffled[:test_game_count])
        is_test = frame.apply(lambda row: (str(row["event_id"]), str(row["game_id"])) in test_games, axis=1)
        train = frame.loc[~is_test].copy()
        test = frame.loc[is_test].copy()
        if train.empty or test.empty:
            continue
        if train["target"].nunique() >= 2 and test["target"].nunique() >= 2:
            return train, test
    return None


if __name__ == "__main__":
    main()
