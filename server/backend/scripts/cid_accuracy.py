"""
cid_accuracy.py — extract CID ground truth from JSONL and build frequency report.

Usage:
    python backend/scripts/cid_accuracy.py \
        --logs-dir ~/Dev/Pediatrics/logs

Output: ranked list of CID codes actually typed by the doctor, with frequency.
Use this to evaluate whether /api/suggest-cid top suggestions match real usage.
"""
import argparse
import glob
import json
import os
import re
from collections import defaultdict
from typing import Optional


CID_PATTERN = re.compile(r"^[A-Z]\d{2}(\.\d[A-Z0-9]?)?$", re.IGNORECASE)

CID_INPUT_IDS = {"intcid_cid_id", "cid_id", "cid"}
CID_INPUT_NAMES = {"cid_id", "cid", "cid_code"}


def is_cid_code(value: str) -> bool:
    return bool(value and CID_PATTERN.match(value.strip()))


def _extract_intern_id(url: str) -> Optional[str]:
    m = re.search(r"[?&]intern_id=(\d+)", url)
    if m:
        return m.group(1)
    m = re.search(r"/interns/(\d+)", url)
    return m.group(1) if m else None


def extract_cid_inputs(events: list[dict]) -> list[dict]:
    """
    Extract the final confirmed CID code per patient session.
    Groups input events on CID fields by intern_id, keeps the last valid CID code
    (assumes the doctor's final keystroke before moving on is the accepted value).
    """
    # Collect all CID input events per intern_id
    by_session: dict[str, list[dict]] = defaultdict(list)
    for ev in events:
        if ev.get("event") not in ("input", "change"):
            continue
        id_ = ev.get("id", "") or ""
        name = ev.get("name", "") or ""
        css = ev.get("css_selector", "") or ""
        if not (id_ in CID_INPUT_IDS or name in CID_INPUT_NAMES or "cid" in css.lower()):
            continue
        value = ev.get("value", "").strip()
        if not value:
            continue
        intern_id = _extract_intern_id(ev.get("page_url", ""))
        if intern_id:
            by_session[intern_id].append({"value": value, "ts": ev.get("ts", ""), "intern_id": intern_id})

    results = []
    for intern_id, session_events in by_session.items():
        # Take the last valid CID code in the session
        sorted_events = sorted(session_events, key=lambda e: e["ts"])
        for ev in reversed(sorted_events):
            if is_cid_code(ev["value"]):
                results.append({"cid_code": ev["value"].upper(), "intern_id": intern_id, "ts": ev["ts"]})
                break

    return results


def build_frequency_report(inputs: list[dict]) -> list[dict]:
    counts: dict[str, int] = defaultdict(int)
    for inp in inputs:
        counts[inp["cid_code"]] += 1
    return sorted(
        [{"cid_code": code, "count": count} for code, count in counts.items()],
        key=lambda x: x["count"],
        reverse=True,
    )


def load_events(logs_dir: str) -> list[dict]:
    events = []
    for path in sorted(glob.glob(os.path.join(logs_dir, "ghosp_interactions_*.jsonl"))):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return events


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--logs-dir", default=os.path.expanduser("~/Dev/Pediatrics/logs"))
    args = parser.parse_args()

    events = load_events(args.logs_dir)
    print(f"Loaded {len(events)} events from {args.logs_dir}")

    cid_inputs = extract_cid_inputs(events)
    print(f"Extracted {len(cid_inputs)} CID selections across {len({c['intern_id'] for c in cid_inputs})} patients\n")

    report = build_frequency_report(cid_inputs)

    print(f"{'Rank':>4}  {'CID Code':<10}  {'Count':>5}")
    print("-" * 35)
    for i, row in enumerate(report[:30], 1):
        print(f"{i:>4}  {row['cid_code']:<10}  {row['count']:>5}")

    if not report:
        print("No CID codes found. Verify that ghosp_interactions_*.jsonl files")
        print("contain input events with id='intcid_cid_id'.")


if __name__ == "__main__":
    main()
