from __future__ import annotations

import argparse
from pathlib import Path

import joblib

from .data import add_draft_context, load_match_rows, load_patch_notes, to_team_games
from .features import (
    add_champion_reference_features,
    add_patch_note_features,
    build_training_frame,
    feature_columns,
)
from .model import evaluate, make_pipeline
from .patches import filter_patch
from .league_groups import filter_leagues


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train a LoL esports win-probability model.")
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--model-path", type=Path, default=Path("models/post_draft.joblib"))
    parser.add_argument("--test-fraction", type=float, default=0.2)
    parser.add_argument("--patch", help="Train only on one patch, or use 'latest'.")
    parser.add_argument("--recent-patches", type=int, help="Train only on the latest N patches in the data.")
    parser.add_argument("--league", action="append", dest="leagues", help="Train only on this league label. Repeatable.")
    parser.add_argument(
        "--region",
        choices=["all", "americas", "china", "emea", "international", "korea", "other", "pacific"],
        default="all",
        help="Filter by regional league bucket.",
    )
    parser.add_argument(
        "--league-group",
        choices=["all", "major", "secondary"],
        default="all",
        help="Filter by major or secondary league group.",
    )
    parser.add_argument("--patch-notes", type=Path, default=Path("data/patch_notes/riot_2025_2026_patch_notes.json"))
    parser.add_argument("--champion-reference", type=Path, default=Path("data/features/champion_reference.csv"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    rows = load_match_rows(args.data_dir)
    rows = filter_leagues(rows, league_group=args.league_group, region=args.region, leagues=args.leagues)
    rows = filter_patch(rows, patch=args.patch, recent_patches=args.recent_patches)
    team_games = add_draft_context(rows, to_team_games(rows))
    team_games = add_patch_note_features(team_games, load_patch_notes(args.patch_notes))
    if args.champion_reference.exists():
        team_games = add_champion_reference_features(team_games, load_patch_notes(args.champion_reference))
    frame = build_training_frame(team_games)
    cols = feature_columns(frame)

    split_at = int(len(frame) * (1 - args.test_fraction))
    train = frame.iloc[:split_at].copy()
    test = frame.iloc[split_at:].copy()

    pipeline = make_pipeline(train, cols)
    pipeline.fit(train[cols], train["target"])
    metrics = evaluate(pipeline, test[cols], test["target"])

    args.model_path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({"pipeline": pipeline, "feature_columns": cols}, args.model_path)

    print(f"Saved model: {args.model_path}")
    print(f"Rows: train={len(train)} test={metrics.rows}")
    print(f"Accuracy: {metrics.accuracy:.4f}")
    print(f"Brier: {metrics.brier:.4f}")
    print(f"Log loss: {metrics.log_loss:.4f}")
    if metrics.roc_auc is not None:
        print(f"ROC AUC: {metrics.roc_auc:.4f}")


if __name__ == "__main__":
    main()
