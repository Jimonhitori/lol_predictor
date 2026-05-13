from __future__ import annotations

import re
from typing import Any

import pandas as pd


def latest_patch(data: pd.DataFrame) -> Any:
    patches = data["patch"].dropna().unique().tolist()
    if not patches:
        raise ValueError("No patch values found in data.")
    return sorted(patches, key=patch_sort_key)[-1]


def filter_patch(data: pd.DataFrame, patch: str | None = None, recent_patches: int | None = None) -> pd.DataFrame:
    if "patch" not in data.columns:
        return data
    if patch:
        selected = latest_patch(data) if patch.lower() == "latest" else patch
        return data[data["patch"].astype(str).eq(str(selected))].copy()
    if recent_patches:
        patches = sorted(data["patch"].dropna().unique().tolist(), key=patch_sort_key)
        selected = {str(value) for value in patches[-recent_patches:]}
        return data[data["patch"].astype(str).isin(selected)].copy()
    return data


def patch_sort_key(value: Any) -> tuple[int, ...]:
    tokens = re.findall(r"\d+", str(value))
    if not tokens:
        return (0,)
    return tuple(int(token) for token in tokens)
