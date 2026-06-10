"""
detect_gaps.py — find manual G-Hosp actions not automated by the extension.

Usage:
    python backend/scripts/detect_gaps.py \
        --logs-dir ~/Dev/Pediatrics/logs \
        [--audit-db ~/Dev/Pediatrics/data/audit.db] \
        [--output report.json]

Output: ranked list of recurring manual actions the extension doesn't yet automate.
"""
import argparse
import glob
import json
import os
import re
import sqlite3
from collections import defaultdict
from typing import Optional


# Known-automated: selectors and element IDs that the extension handles.
# A click matching any of these is NOT a gap.
KNOWN_AUTOMATED_IDS = {
    "submit_pranamnese", "intcid_cid_id", "link_new_receitaalta",
    "tiporec_1", "botao_gravar_alta", "dar_alta",
    "matmed_nome", "modo_usar", "intern_encaminh",
}

KNOWN_AUTOMATED_CSS_FRAGMENTS = [
    "#submit_pranamnese", "#botao_gravar_alta", "#link_new_receitaalta",
    "#tiporec_1", "#intcid_cid_id", "#cid_descricao", "#dialog_formularios",
    "input[name='commit'][value='Inserir']", "input[name='padraorec']",
]

# Navigation clicks: href patterns that indicate list/nav, not workflow actions.
NAV_HREF_PATTERNS = [
    re.compile(r"/prconsultas$"),
    re.compile(r"/users/sign"),
    re.compile(r"^#$"),
    re.compile(r"/avisos/"),
    re.compile(r"^$"),
]


def extract_intern_id(url: str) -> Optional[str]:
    m = re.search(r"[?&]intern_id=(\d+)", url)
    if m:
        return m.group(1)
    m = re.search(r"/interns/(\d+)", url)
    if m:
        return m.group(1)
    return None


def is_known_automated(ev: dict) -> bool:
    css = ev.get("css_selector", "") or ""
    id_ = ev.get("id", "") or ""
    if id_ in KNOWN_AUTOMATED_IDS:
        return True
    for fragment in KNOWN_AUTOMATED_CSS_FRAGMENTS:
        if fragment in css:
            return True
    return False


def is_nav_click(ev: dict) -> bool:
    href = ev.get("href", "") or ""
    for pattern in NAV_HREF_PATTERNS:
        if pattern.search(href):
            return True
    return False


def split_sessions(events: list[dict]) -> list[dict]:
    """Split events into patient sessions based on intern_id changes."""
    sessions = []
    current: Optional[dict] = None

    for ev in sorted(events, key=lambda e: e.get("ts", "")):
        url = ev.get("page_url", "")
        intern_id = extract_intern_id(url)

        if intern_id:
            if current is None or intern_id != current["intern_id"]:
                if current:
                    current["end_ts"] = ev["ts"]
                    sessions.append(current)
                current = {
                    "intern_id": intern_id,
                    "start_ts": ev.get("ts", ""),
                    "end_ts": "",
                    "events": [],
                }
        if current is not None:
            current["events"].append(ev)

    if current:
        last_ts = current["events"][-1].get("ts", "") if current["events"] else ""
        current["end_ts"] = last_ts
        sessions.append(current)

    return sessions


def build_gap_report(sessions: list[dict]) -> dict:
    """Identify recurring manual actions that the extension doesn't automate."""
    gap_counts: dict[str, dict] = defaultdict(lambda: {"count": 0, "examples": []})

    for session in sessions:
        for ev in session["events"]:
            if ev.get("event") not in ("click", "input", "change"):
                continue
            if is_known_automated(ev):
                continue
            if is_nav_click(ev):
                continue
            css = ev.get("css_selector", "").strip()
            if not css or css in ("", "body", "html"):
                continue
            key = css
            gap_counts[key]["count"] += 1
            if len(gap_counts[key]["examples"]) < 3:
                gap_counts[key]["examples"].append({
                    "intern_id": session["intern_id"],
                    "ts": ev.get("ts"),
                    "tag": ev.get("tag"),
                    "text": ev.get("text", "")[:80],
                    "href": ev.get("href", ""),
                    "id": ev.get("id", ""),
                })

    candidates = sorted(
        [{"css_selector": k, **v} for k, v in gap_counts.items()],
        key=lambda x: x["count"],
        reverse=True,
    )

    return {
        "total_sessions": len(sessions),
        "gap_candidates": candidates[:50],  # top 50 by frequency
    }


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
    return [e for e in events if e.get("event") in
            ("click", "input", "change", "focus", "submit", "keydown_enter", "keydown_tab")]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--logs-dir", default=os.path.expanduser("~/Dev/Pediatrics/logs"))
    parser.add_argument("--output", default=None)
    args = parser.parse_args()

    print(f"Loading events from {args.logs_dir}...")
    events = load_events(args.logs_dir)
    print(f"  {len(events)} interaction events loaded")

    sessions = split_sessions(events)
    print(f"  {len(sessions)} patient sessions identified")

    report = build_gap_report(sessions)
    print(f"\n=== Top Manual Actions (automation gaps) ===")
    print(f"{'Occurrences':>12}  {'CSS Selector'}")
    print("-" * 70)
    for gap in report["gap_candidates"][:20]:
        ex = gap["examples"][0] if gap["examples"] else {}
        label = ex.get("text", "")[:40] or ex.get("href", "")[:40] or ex.get("id", "")[:40]
        print(f"{gap['count']:>12}  {gap['css_selector']:<45}  {label}")

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
        print(f"\nFull report written to {args.output}")


if __name__ == "__main__":
    main()
