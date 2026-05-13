from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib
import pandas as pd

from .data import load_match_rows, load_patch_notes
from .inference import build_prediction_row


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Predict one LoL esports match win probability.")
    parser.add_argument("--model-path", type=Path, default=Path("models/post_draft.joblib"))
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--patch-notes", type=Path, default=Path("data/patch_notes/riot_2025_2026_patch_notes.json"))
    parser.add_argument("--champion-reference", type=Path, default=Path("data/features/champion_reference.csv"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    bundle = joblib.load(args.model_path)
    payload = json.loads(args.input.read_text(encoding="utf-8"))
    rows = load_match_rows(args.data_dir) if args.data_dir.exists() else pd.DataFrame()
    row = build_prediction_row(
        payload,
        rows=rows,
        patch_notes=load_patch_notes(args.patch_notes),
        champion_reference=load_patch_notes(args.champion_reference),
    )

    for col in bundle["feature_columns"]:
        if col not in row.columns:
            row[col] = None

    probability = float(bundle["pipeline"].predict_proba(row[bundle["feature_columns"]])[:, 1][0])
    print(json.dumps({"win_probability": probability}, indent=2))


if __name__ == "__main__":
    main()
