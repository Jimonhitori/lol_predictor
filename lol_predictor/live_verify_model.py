from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import pandas as pd

from .live_features import live_feature_row
from .live_predict import active_game, load_snapshot


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify exported live model JSON against the source joblib bundle.")
    parser.add_argument("--model-path", type=Path, default=Path("models/live_win_probability.joblib"))
    parser.add_argument("--exported-model", type=Path, default=Path("docs/static/data/live_model.json"))
    parser.add_argument("--input", type=Path, required=True, help="A JSON or JSONL snapshot with a usable live frame.")
    parser.add_argument("--tolerance", type=float, default=1e-9)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    import joblib

    bundle = joblib.load(args.model_path)
    exported = json.loads(args.exported_model.read_text(encoding="utf-8"))
    details = load_snapshot(args.input)
    details = details.get("details") if isinstance(details.get("details"), dict) else details
    game = active_game(details)
    if not game:
        raise SystemExit("No active game found in snapshot.")
    row = live_feature_row(
        live=game.get("live") or {},
        event_id=str(details.get("id") or ""),
        game=game,
        league=str(details.get("league") or ""),
        best_of=str(details.get("best_of") or ""),
    )
    if not row:
        raise SystemExit("No usable live frame found in snapshot.")
    joblib_probability = predict_joblib(bundle, row)
    exported_probability = predict_exported(exported, row)
    delta = abs(joblib_probability - exported_probability)
    print(f"joblib_blue={joblib_probability:.12f}")
    print(f"exported_blue={exported_probability:.12f}")
    print(f"delta={delta:.12g}")
    if delta > args.tolerance:
        raise SystemExit(f"Exported model mismatch: delta={delta} tolerance={args.tolerance}")


def predict_joblib(bundle: dict[str, Any], row: dict[str, Any]) -> float:
    columns = list(bundle["feature_columns"])
    frame = pd.DataFrame([row])
    for column in columns:
        if column not in frame.columns:
            frame[column] = None
    return float(bundle["pipeline"].predict_proba(frame[columns])[:, 1][0])


def predict_exported(model: dict[str, Any], row: dict[str, Any]) -> float:
    if model.get("schema") != "live_logistic_regression_v1":
        raise SystemExit(f"Unsupported exported model schema: {model.get('schema')}")
    coefficient_index = 0
    logit = float(model.get("intercept") or 0)
    coefficients = model.get("coefficients") or []
    for feature in model.get("categorical") or []:
        value = string_value(row.get(feature["name"], feature.get("fill_value", "unknown")))
        for category in feature.get("categories") or []:
            if value == string_value(category):
                logit += float(coefficients[coefficient_index])
            coefficient_index += 1
    for feature in model.get("numeric") or []:
        raw = numeric_value(row.get(feature["name"]))
        if not math.isfinite(raw):
            raw = float(feature.get("impute") or 0)
        scaled = (raw - float(feature.get("mean") or 0)) / (float(feature.get("scale") or 1) or 1.0)
        logit += scaled * float(coefficients[coefficient_index])
        coefficient_index += 1
    if coefficient_index != len(coefficients):
        raise SystemExit(f"Coefficient count mismatch: used={coefficient_index} total={len(coefficients)}")
    return 1 / (1 + math.exp(-logit))


def numeric_value(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return math.nan


def string_value(value: Any) -> str:
    return "" if value is None else str(value)


if __name__ == "__main__":
    main()
