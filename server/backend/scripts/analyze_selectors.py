#!/usr/bin/env python3
"""
analyze_selectors.py — mine JSONL interaction logs to rank G-Hosp DOM selectors.

Usage:
    python backend/scripts/analyze_selectors.py \
        --logs-dir ~/Dev/Pediatrics/logs \
        --output backend/data/selectors/ghosp_derived.json \
        [--min-occurrences 2]

Output: ghosp_derived.json in the same format as ghosp.json, with the top-ranked
css_selector for each action key.  Review it before copying over ghosp.json.
"""
import argparse
import glob
import json
import os
import re
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Optional


# --- Action type detection ---------------------------------------------------

def detect_action_type(ev: dict) -> Optional[str]:
    event = ev.get("event", "")
    tag = ev.get("tag", "")
    id_ = ev.get("id", "") or ""
    name = ev.get("name", "") or ""
    value = ev.get("value", "") or ""
    href = ev.get("href", "") or ""
    placeholder = ev.get("placeholder", "") or ""
    text = ev.get("text", "") or ""
    xpath = ev.get("xpath", "") or ""
    etype = ev.get("type", "") or ""

    # CID input
    if event in ("click", "input", "change", "focus"):
        if etype != "hidden":
            if (id_ and "cid" in id_.lower()) or re.search(r"cid|diagn", placeholder, re.I):
                return "cid_input"

    # Prescription link (must NOT be a print/view link)
    if event == "click" and tag == "a":
        if "receitaalta" in href:
            return "prescription_link"
        if re.search(r"receita", text, re.I) and not re.search(r"imprimir|visualizar|ver\b", text, re.I):
            return "prescription_link"

    # Prescription sub-steps
    if event == "click":
        if id_ == "tiporec_1" or (name == "tipo_receita" and value == "1"):
            return "prescription_simples_radio"
        if tag == "input" and name == "commit" and re.search(r"inserir", value, re.I):
            return "prescription_inserir_to_editor"
        if id_ == "botao_gravar_alta":
            return "discharge_save"
        if id_ == "submit_pranamnese" or (tag == "input" and re.search(r"gravar consulta|salvar prontu", value, re.I)):
            return "save_button"
        if tag == "a" and (re.search(r"imp_receita|imprimir_presc", href, re.I) or
                           "dialog_formularios" in xpath):
            return "print_prescription"
        if tag == "a" and ("dar_alta" in href or "dar_alta" in xpath):
            return "discharge_link"
        if tag == "input" and re.search(r"\bgravar\b", value, re.I) and id_ != "botao_gravar_alta":
            return "prescription_save_button"

    if event in ("input", "change"):
        if id_ == "matmed_nome":
            return "prescription_title_input"
        if id_ == "modo_usar":
            return "prescription_body_textarea"
        if id_ == "intern_encaminh" or name == "intern[encaminh]":
            return "discharge_referral"

    return None


# --- Selector scoring --------------------------------------------------------

def specificity_bonus(css: str) -> int:
    bonus = 0
    if "#" in css:
        bonus += 3
    if re.search(r'\[(?:name|value)=', css):
        bonus += 2
    if re.search(r'\[(?:id|name)\*=', css):
        bonus += 1
    if re.search(r':nth-child', css):
        bonus -= 1
    # Pure class selector: no id, no attribute selectors
    if not re.search(r'[#\[]', css) and re.search(r'\.', css):
        bonus -= 2
    return bonus


def _ts_to_epoch(ts: str) -> float:
    for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            return datetime.strptime(ts, fmt).timestamp()
        except ValueError:
            continue
    return 0.0


def rank_selectors(events: list[dict], newest_ts: str, oldest_ts: str) -> list[tuple[str, float]]:
    """Return [(css_selector, score)] sorted descending by score."""
    t_new = _ts_to_epoch(newest_ts)
    t_old = _ts_to_epoch(oldest_ts)
    t_range = max(t_new - t_old, 1.0)

    scores: dict[str, float] = defaultdict(float)
    counts: dict[str, int] = defaultdict(int)

    for ev in events:
        css = ev.get("css_selector", "").strip()
        if not css:
            continue
        ts = ev.get("ts", "")
        t = _ts_to_epoch(ts)
        recency = 0.5 + 0.5 * (t - t_old) / t_range  # [0.5, 1.0]
        scores[css] += recency
        counts[css] += 1

    final: dict[str, float] = {}
    for css, raw_score in scores.items():
        final[css] = raw_score + specificity_bonus(css)

    return sorted(final.items(), key=lambda x: x[1], reverse=True)


# --- Main analysis -----------------------------------------------------------

def load_events(log_paths: list[str]) -> list[dict]:
    events = []
    for path in log_paths:
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


def build_derived_config(log_paths: list[str], min_occurrences: int = 1) -> dict:
    """Build a selector config dict from interaction log files."""
    events = load_events(log_paths)
    if not events:
        return {"emr": "ghosp", "version": "derived", "selectors": {}}

    all_ts = [e.get("ts", "") for e in events if e.get("ts")]
    newest_ts = max(all_ts) if all_ts else ""
    oldest_ts = min(all_ts) if all_ts else ""

    # Group events by action type
    by_action: dict[str, list[dict]] = defaultdict(list)
    for ev in events:
        action = detect_action_type(ev)
        if action:
            by_action[action].append(ev)

    selectors: dict[str, object] = {}
    for action, action_events in by_action.items():
        ranked = rank_selectors(action_events, newest_ts=newest_ts, oldest_ts=oldest_ts)
        # Filter by min occurrences (approximate: score > min * 0.5 recency weight)
        threshold = min_occurrences * 0.5
        qualified = [(css, score) for css, score in ranked if score >= threshold]
        if not qualified:
            continue
        # Multi-strategy actions store up to 5 selectors as an array
        multi_strategy_actions = {"cid_input"}
        if action in multi_strategy_actions:
            selectors[action] = [css for css, _ in qualified[:5]]
        else:
            selectors[action] = qualified[0][0]

    return {
        "emr": "ghosp",
        "version": "derived",
        "source": "analyze_selectors.py",
        "selectors": selectors,
    }


def main():
    parser = argparse.ArgumentParser(description="Rank G-Hosp selectors from JSONL interaction logs")
    parser.add_argument("--logs-dir", default=os.path.expanduser("~/Dev/Pediatrics/logs"),
                        help="Directory containing ghosp_interactions_*.jsonl files")
    parser.add_argument("--output", default=None,
                        help="Write derived selector config to this JSON file (default: print to stdout)")
    parser.add_argument("--min-occurrences", type=int, default=2,
                        help="Minimum event count to include a selector (default: 2)")
    args = parser.parse_args()

    log_paths = sorted(glob.glob(os.path.join(args.logs_dir, "ghosp_interactions_*.jsonl")))
    if not log_paths:
        print(f"No JSONL files found in {args.logs_dir}")
        return

    print(f"Analyzing {len(log_paths)} JSONL files...")
    config = build_derived_config(log_paths, min_occurrences=args.min_occurrences)

    print(f"\n=== Derived Selectors ({len(config['selectors'])} action types) ===")
    for action, sel in sorted(config["selectors"].items()):
        print(f"  {action:40s} {sel}")

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
        print(f"\nWritten to {args.output}")
        print("Review ghosp_derived.json, then manually merge desired selectors into ghosp.json")


if __name__ == "__main__":
    main()
