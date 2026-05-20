from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export a trained live model bundle to Cloudflare-friendly JSON.")
    parser.add_argument("--model-path", type=Path, default=Path("models/live_win_probability.joblib"))
    parser.add_argument("--output", type=Path, default=Path("docs/static/data/live_model.json"))
    parser.add_argument("--name", default="live_logreg_v1")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    import joblib

    bundle = joblib.load(args.model_path)
    payload = export_bundle(bundle, args.name)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote live model JSON: {args.output}")
    print(f"Features: {len(payload['feature_columns'])}")
    print(f"Training rows: {payload.get('training_rows', '')} test rows: {payload.get('test_rows', '')}")


def export_bundle(bundle: dict[str, Any], name: str) -> dict[str, Any]:
    pipeline = bundle["pipeline"]
    preprocessor = pipeline.named_steps["preprocessor"]
    model = pipeline.named_steps["model"]
    categorical = export_categorical(preprocessor)
    numeric = export_numeric(preprocessor)
    return {
        "schema": "live_logistic_regression_v1",
        "name": name,
        "feature_schema": bundle.get("feature_schema", "live_frame_v1"),
        "feature_columns": list(bundle.get("feature_columns") or []),
        "training_rows": int(bundle.get("training_rows") or 0),
        "test_rows": int(bundle.get("test_rows") or 0),
        "split": str(bundle.get("split") or ""),
        "include_team_features": bool(bundle.get("include_team_features", True)),
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "classes": [int(value) for value in getattr(model, "classes_", [])],
        "intercept": float(model.intercept_[0]),
        "coefficients": [float(value) for value in model.coef_[0]],
        "categorical": categorical,
        "numeric": numeric,
    }


def export_categorical(preprocessor: Any) -> list[dict[str, Any]]:
    for name, transformer, columns in preprocessor.transformers_:
        if name != "categorical":
            continue
        imputer = transformer.named_steps["imputer"]
        onehot = transformer.named_steps["onehot"]
        columns = list(columns)
        categories = [list(map(string_value, values)) for values in onehot.categories_]
        return [
            {
                "name": str(column),
                "fill_value": string_value(imputer.fill_value),
                "categories": categories[index],
            }
            for index, column in enumerate(columns)
        ]
    return []


def export_numeric(preprocessor: Any) -> list[dict[str, Any]]:
    for name, transformer, columns in preprocessor.transformers_:
        if name != "numeric":
            continue
        imputer = transformer.named_steps["imputer"]
        scaler = transformer.named_steps["scaler"]
        return [
            {
                "name": str(column),
                "impute": float(imputer.statistics_[index]),
                "mean": float(scaler.mean_[index]),
                "scale": float(scaler.scale_[index]) if float(scaler.scale_[index]) else 1.0,
            }
            for index, column in enumerate(list(columns))
        ]
    return []


def string_value(value: Any) -> str:
    return "" if value is None else str(value)


if __name__ == "__main__":
    main()
