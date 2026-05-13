from __future__ import annotations

from dataclasses import dataclass

import pandas as pd
from pandas.api.types import is_numeric_dtype
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss, roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler


@dataclass(frozen=True)
class Evaluation:
    rows: int
    accuracy: float
    brier: float
    log_loss: float
    roc_auc: float | None


def make_pipeline(data: pd.DataFrame, feature_cols: list[str]) -> Pipeline:
    numeric = [col for col in feature_cols if is_numeric_dtype(data[col])]
    categorical = [col for col in feature_cols if col not in numeric]

    preprocessor = ColumnTransformer(
        transformers=[
            (
                "categorical",
                Pipeline(
                    steps=[
                        ("imputer", SimpleImputer(strategy="constant", fill_value="unknown")),
                        ("onehot", OneHotEncoder(handle_unknown="ignore")),
                    ]
                ),
                categorical,
            ),
            (
                "numeric",
                Pipeline(
                    steps=[
                        ("imputer", SimpleImputer(strategy="median")),
                        ("scaler", StandardScaler()),
                    ]
                ),
                numeric,
            ),
        ]
    )

    return Pipeline(
        steps=[
            ("preprocessor", preprocessor),
            ("model", LogisticRegression(max_iter=2000, class_weight="balanced")),
        ]
    )


def evaluate(model: Pipeline, x: pd.DataFrame, y: pd.Series) -> Evaluation:
    probabilities = model.predict_proba(x)[:, 1]
    predictions = (probabilities >= 0.5).astype(int)
    roc_auc = None
    if y.nunique() > 1:
        roc_auc = float(roc_auc_score(y, probabilities))
    return Evaluation(
        rows=len(x),
        accuracy=float(accuracy_score(y, predictions)),
        brier=float(brier_score_loss(y, probabilities)),
        log_loss=float(log_loss(y, probabilities)),
        roc_auc=roc_auc,
    )
