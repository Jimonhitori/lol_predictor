from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd

from .live_features import live_record_rows, live_training_frame, load_live_jsonl


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Report quality and label coverage for collected live JSONL frames.")
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("--max-interval-seconds", type=int, default=30)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    raw_rows = []
    record_count = 0
    unavailable_records = 0
    for path in expand_inputs(args.inputs):
        records = load_live_jsonl(path)
        record_count += len(records)
        for record in records:
            details = record.get("details") if isinstance(record.get("details"), dict) else record
            if str(details.get("status") or "").lower() == "unavailable":
                unavailable_records += 1
            raw_rows.extend(live_record_rows(record))

    raw = pd.DataFrame(raw_rows)
    train = live_training_frame(expand_inputs(args.inputs), max_interval_seconds=args.max_interval_seconds)
    print(f"Records: {record_count}")
    print(f"Unavailable records: {unavailable_records}")
    print(f"Live feature rows: {len(raw)}")
    print(f"Labeled training rows: {len(train)}")
    if raw.empty:
        return
    print(f"Events: {raw['event_id'].nunique()}")
    print(f"Games: {raw['game_id'].nunique()}")
    print(f"Frame timestamps: {raw['frame_timestamp'].replace('', pd.NA).dropna().nunique()}")
    if "target" in raw.columns:
        print("Raw target distribution:")
        print(raw["target"].value_counts(dropna=False).to_string())
    if not train.empty:
        print("Training rows by target:")
        print(train["target"].value_counts(dropna=False).to_string())
        print("Training rows by event:")
        print(train.groupby("event_id").size().sort_values(ascending=False).head(20).to_string())


def expand_inputs(inputs: list[Path]) -> list[Path]:
    paths: list[Path] = []
    for item in inputs:
        if item.is_dir():
            paths.extend(sorted(item.glob("*.jsonl")))
        else:
            paths.append(item)
    return paths


if __name__ == "__main__":
    main()
