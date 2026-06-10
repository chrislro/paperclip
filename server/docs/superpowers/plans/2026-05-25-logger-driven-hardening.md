# Logger-Driven Extension Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build four Python tools that mine real G-Hosp interaction logs (`~/Dev/Pediatrics/logs/ghosp_interactions_*.jsonl` and `~/Dev/Pediatrics/data/audit.db`) to harden the Toca Ficha Dr. extension's selector config, calibrate DOM wait times, surface unautomated workflows, and measure CID suggestion accuracy.

**Architecture:** Four independent scripts under `backend/scripts/`, each tested against synthetic JSONL/SQLite fixtures (no dependency on live files). Scripts emit human-readable output to stdout and write machine-readable JSON/CSV artifacts. Task 1's output feeds directly into `backend/data/selectors/ghosp.json`. Tasks 2–4 are pure analysis tools.

**Tech Stack:** Python 3.11, stdlib only (json, sqlite3, pathlib, statistics, re, collections, datetime). No new dependencies. Tests use pytest + tmp_path fixtures. Run tests: `cd /Users/admin/Dev/tocafichadr-extension/backend && python -m pytest tests/ -v`.

---

## File Map

| File | Create / Modify | Responsibility |
|------|----------------|----------------|
| `backend/scripts/analyze_selectors.py` | Create | Task 1 — rank selectors from JSONL |
| `backend/scripts/calibrate_timings.py` | Create | Task 2 — compute p50/p95/p99 for key POST waits |
| `backend/scripts/detect_gaps.py` | Create | Task 3 — find manual actions not covered by extension |
| `backend/scripts/cid_accuracy.py` | Create | Task 4 — extract CID ground truth + log suggestions |
| `backend/emr_automation/dashboard/routes.py` | Modify | Task 4 — log `cid_suggested` on `/api/suggest-cid` |
| `backend/tests/test_analyze_selectors.py` | Create | Tests for Task 1 |
| `backend/tests/test_calibrate_timings.py` | Create | Tests for Task 2 |
| `backend/tests/test_detect_gaps.py` | Create | Tests for Task 3 |
| `backend/tests/test_cid_accuracy.py` | Create | Tests for Task 4 |

---

## Task 1: Selector Frequency Analyzer

Reads all JSONL interaction files, maps click/input events to named extension actions (CID input, save button, discharge link, etc.), scores selectors by frequency and specificity, and writes ranked selectors to `backend/data/selectors/ghosp_derived.json` for human review before merging into `ghosp.json`.

**Files:**
- Create: `backend/scripts/analyze_selectors.py`
- Create: `backend/tests/test_analyze_selectors.py`

### Selector scoring

Each `css_selector` value gets a **specificity bonus** that penalizes brittle selectors:
- Contains `#` (id selector) → +3
- Contains `[name=` or `[value=` → +2
- Contains `[id*=` or `[name*=` → +1
- Pure class selector (e.g. `a.botao`) → -2 (high frequency but not stable)
- Contains `nth-child` → -1

**Score = frequency × recency_weight + specificity_bonus** where `recency_weight` linearly scales from 0.5 (oldest file) to 1.0 (newest file).

### Action type detection heuristics

The script maps raw events to named extension actions using these rules (applied in order, first match wins):

| Action key | Condition |
|-----------|-----------|
| `cid_input` | event=click/input/change AND (`id` contains "cid" AND type≠hidden) OR (placeholder matches `/cid\|diagn/i`) |
| `prescription_link` | event=click AND tag=a AND (href contains "receitaalta" OR text matches `/receita/i` AND text NOT matches `/imprimir\|visualizar/i`) |
| `prescription_simples_radio` | event=click AND (`id`="tiporec_1" OR (`name`="tipo_receita" AND value="1")) |
| `prescription_inserir_to_editor` | event=click AND tag=input AND name="commit" AND value matches `/inserir/i` |
| `prescription_title_input` | event=input/change AND `id`="matmed_nome" |
| `prescription_body_textarea` | event=input/change AND `id`="modo_usar" |
| `prescription_save_button` | event=click AND (id="botao_gravar_alta" is absent) AND tag=input AND value matches `/gravar/i` AND `id`≠"botao_gravar_alta" |
| `save_button` | event=click AND (`id`="submit_pranamnese" OR (tag=input AND value matches `/gravar consulta\|salvar prontu/i`)) |
| `discharge_link` | event=click AND tag=a AND (href contains "dar_alta" OR xpath contains "dar_alta") |
| `discharge_save` | event=click AND `id`="botao_gravar_alta" |
| `discharge_referral` | event=change AND (`id`="intern_encaminh" OR name="intern[encaminh]") |
| `print_prescription` | event=click AND tag=a AND (href matches `/imp_receita\|imprimir_presc/i` OR (parent xpath contains "dialog_formularios")) |

- [ ] **Step 1.1: Write failing tests**

Create `backend/tests/test_analyze_selectors.py`:

```python
import json
import sys
import os
import pytest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import analyze_selectors as AS


def _make_event(event, tag, id_="", name="", value="", href="",
                placeholder="", text="", xpath="", css="#foo",
                page_url="https://prbentogoncalves.g-hosp.com.br/amb/interns?intern_id=99",
                ts="2026-05-20T10:00:00.000Z", **kw):
    return dict(event=event, tag=tag, id=id_, name=name, value=value,
                href=href, placeholder=placeholder, text=text,
                xpath=xpath, css_selector=css, page_url=page_url,
                type=kw.get("type", ""), ts=ts, **{k: v for k, v in kw.items() if k != "type"})


class TestDetectActionType:
    def test_cid_input_by_id(self):
        ev = _make_event("input", "input", id_="intcid_cid_id", css="#intcid_cid_id")
        assert AS.detect_action_type(ev) == "cid_input"

    def test_cid_input_by_placeholder(self):
        ev = _make_event("click", "input", placeholder="Diagnóstico CID", css="input.cid-search")
        assert AS.detect_action_type(ev) == "cid_input"

    def test_prescription_link_by_href(self):
        ev = _make_event("click", "a", href="/amb/interns/1234/receitaalta/new", css="a#link_new_receitaalta")
        assert AS.detect_action_type(ev) == "prescription_link"

    def test_prescription_link_not_print(self):
        ev = _make_event("click", "a", href="/imp_receita/1234", text="Imprimir Receita", css="a.botao")
        assert AS.detect_action_type(ev) != "prescription_link"

    def test_save_button_by_id(self):
        ev = _make_event("click", "input", id_="submit_pranamnese", css="#submit_pranamnese")
        assert AS.detect_action_type(ev) == "save_button"

    def test_discharge_save_by_id(self):
        ev = _make_event("click", "input", id_="botao_gravar_alta", css="#botao_gravar_alta")
        assert AS.detect_action_type(ev) == "discharge_save"

    def test_unknown_returns_none(self):
        ev = _make_event("click", "a", href="/some/random/path", text="Random Link", css="a")
        assert AS.detect_action_type(ev) is None


class TestSpecificityBonus:
    def test_id_selector_bonus(self):
        assert AS.specificity_bonus("#intcid_cid_id") == 3

    def test_attribute_name_bonus(self):
        assert AS.specificity_bonus("input[name='commit']") == 2

    def test_pure_class_penalty(self):
        assert AS.specificity_bonus("a.botao") == -2

    def test_nth_child_penalty(self):
        assert AS.specificity_bonus("#dialog_formularios > div:nth-child(2) > a") < 3

    def test_combined_id_and_attribute(self):
        bonus = AS.specificity_bonus("#foo input[value='Gravar']")
        assert bonus >= 5  # id(+3) + attribute(+2)


class TestRankSelectors:
    def test_id_selector_wins_over_class(self):
        events = [
            _make_event("click", "input", id_="submit_pranamnese",
                        css="#submit_pranamnese", ts="2026-05-20T10:00:00.000Z"),
            _make_event("click", "input", id_="submit_pranamnese",
                        css="#submit_pranamnese", ts="2026-05-19T10:00:00.000Z"),
            _make_event("click", "input",
                        css="input.botao.pr10", ts="2026-05-20T10:01:00.000Z"),
            _make_event("click", "input",
                        css="input.botao.pr10", ts="2026-05-20T10:02:00.000Z"),
            _make_event("click", "input",
                        css="input.botao.pr10", ts="2026-05-20T10:03:00.000Z"),
        ]
        ranked = AS.rank_selectors(events, newest_ts="2026-05-20T10:03:00.000Z",
                                   oldest_ts="2026-05-19T10:00:00.000Z")
        # id-based selector should rank first despite lower raw frequency
        assert ranked[0][0] == "#submit_pranamnese"

    def test_returns_list_of_tuples(self):
        events = [_make_event("click", "input", css="#foo")]
        ranked = AS.rank_selectors(events, newest_ts="2026-05-20T10:00:00.000Z",
                                   oldest_ts="2026-05-20T10:00:00.000Z")
        assert isinstance(ranked, list)
        assert len(ranked) == 1
        css, score = ranked[0]
        assert isinstance(css, str)
        assert isinstance(score, (int, float))


class TestBuildDerivedConfig:
    def test_output_shape(self, tmp_path):
        log_file = tmp_path / "log.jsonl"
        events = [
            _make_event("click", "input", id_="submit_pranamnese",
                        css="#submit_pranamnese"),
            _make_event("input", "input", id_="intcid_cid_id",
                        css="#intcid_cid_id"),
        ]
        log_file.write_text("\n".join(json.dumps(e) for e in events))
        config = AS.build_derived_config([str(log_file)])
        assert "selectors" in config
        assert "save_button" in config["selectors"]
        assert "cid_input" in config["selectors"]
        # cid_input should be a list (multiple strategies supported)
        assert isinstance(config["selectors"]["cid_input"], list)
```

- [ ] **Step 1.2: Run tests to verify they fail**

```bash
cd /Users/admin/Dev/tocafichadr-extension/backend
python -m pytest tests/test_analyze_selectors.py -v 2>&1 | head -30
```
Expected: `ModuleNotFoundError` for `analyze_selectors` (file doesn't exist yet).

- [ ] **Step 1.3: Implement `backend/scripts/analyze_selectors.py`**

```python
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
```

- [ ] **Step 1.4: Run tests to verify they pass**

```bash
cd /Users/admin/Dev/tocafichadr-extension/backend
python -m pytest tests/test_analyze_selectors.py -v
```
Expected: All 14 tests pass.

- [ ] **Step 1.5: Run against real logs and review output**

```bash
cd /Users/admin/Dev/tocafichadr-extension/backend
python scripts/analyze_selectors.py \
    --logs-dir ~/Dev/Pediatrics/logs \
    --output data/selectors/ghosp_derived.json \
    --min-occurrences 2
```
Expected output: list of action types with top-ranked CSS selectors. Spot-check that `save_button` → `#submit_pranamnese`, `discharge_save` → `#botao_gravar_alta`.

- [ ] **Step 1.6: Commit**

```bash
cd /Users/admin/Dev/tocafichadr-extension
git add backend/scripts/analyze_selectors.py backend/tests/test_analyze_selectors.py \
        backend/data/selectors/ghosp_derived.json
git commit -m "feat: selector frequency analyzer from JSONL interaction logs"
```

---

## Task 2: Network Timing Calibrator

Reads JSONL files, finds `network_response` events for key G-Hosp endpoints (prescription save, discharge save), and computes p50/p95/p99 latency. Prints recommended `sleep` values for `dom-engine.js`.

**Files:**
- Create: `backend/scripts/calibrate_timings.py`
- Create: `backend/tests/test_calibrate_timings.py`

**Key endpoint patterns:**

| Extension sleep location | G-Hosp HTTP pattern |
|--------------------------|---------------------|
| Prescription save (1500ms) | POST matching `/matmeds` or `/receitas` |
| Discharge save (4000ms) | PATCH/PUT matching `/interns/\d+` |
| CID autocomplete | GET matching `/autocomplete` or `/cids` |

- [ ] **Step 2.1: Write failing tests**

Create `backend/tests/test_calibrate_timings.py`:

```python
import sys
import os
import json
import pytest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import calibrate_timings as CT


def _req(method, url, ts_start="2026-05-20T10:00:00.000Z", req_id=1):
    return {"event": "network_request", "id": req_id, "method": method, "url": url, "ts": ts_start}


def _resp(req_id, duration_ms, ts="2026-05-20T10:00:01.000Z", status=200):
    return {"event": "network_response", "id": req_id, "status": status,
            "duration_ms": duration_ms, "ts": ts}


class TestDetectEndpoint:
    def test_prescription_save(self):
        url = "https://prbentogoncalves.g-hosp.com.br/amb/matmeds"
        assert CT.detect_endpoint("POST", url) == "prescription_save"

    def test_prescription_save_receitas(self):
        url = "https://prbentogoncalves.g-hosp.com.br/amb/interns/123/receitas"
        assert CT.detect_endpoint("POST", url) == "prescription_save"

    def test_discharge_save(self):
        url = "https://prbentogoncalves.g-hosp.com.br/amb/interns/1234"
        assert CT.detect_endpoint("PATCH", url) == "discharge_save"

    def test_discharge_save_put(self):
        url = "https://prbentogoncalves.g-hosp.com.br/amb/interns/9876"
        assert CT.detect_endpoint("PUT", url) == "discharge_save"

    def test_cid_autocomplete(self):
        url = "https://prbentogoncalves.g-hosp.com.br/amb/autocomplete_cid?q=J20"
        assert CT.detect_endpoint("GET", url) == "cid_autocomplete"

    def test_unknown_returns_none(self):
        assert CT.detect_endpoint("GET", "https://prbentogoncalves.g-hosp.com.br/assets/app.css") is None


class TestPercentiles:
    def test_median(self):
        durations = [100.0, 200.0, 300.0, 400.0, 500.0]
        assert CT.percentile(durations, 50) == 300.0

    def test_p95_small_sample(self):
        durations = [100.0, 200.0]
        # With 2 values, p95 should be the max
        assert CT.percentile(durations, 95) == 200.0

    def test_empty_raises(self):
        with pytest.raises(ValueError):
            CT.percentile([], 50)


class TestAnalyzeEvents:
    def test_pairs_request_and_response(self):
        events = [
            _req("POST", "https://prbentogoncalves.g-hosp.com.br/amb/matmeds", req_id=1),
            _resp(1, duration_ms=800.0),
            _req("POST", "https://prbentogoncalves.g-hosp.com.br/amb/matmeds", req_id=2),
            _resp(2, duration_ms=1200.0),
        ]
        results = CT.analyze_events(events)
        assert "prescription_save" in results
        assert results["prescription_save"]["count"] == 2
        assert results["prescription_save"]["p50"] == pytest.approx(1000.0, abs=200)

    def test_failed_requests_excluded(self):
        events = [
            _req("PATCH", "https://prbentogoncalves.g-hosp.com.br/amb/interns/99", req_id=3),
            _resp(3, duration_ms=500.0, status=500),
        ]
        results = CT.analyze_events(events)
        # 500 responses should be excluded
        assert results.get("discharge_save", {}).get("count", 0) == 0

    def test_empty_events(self):
        assert CT.analyze_events([]) == {}
```

- [ ] **Step 2.2: Run tests to verify they fail**

```bash
cd /Users/admin/Dev/tocafichadr-extension/backend
python -m pytest tests/test_calibrate_timings.py -v 2>&1 | head -20
```
Expected: `ModuleNotFoundError` for `calibrate_timings`.

- [ ] **Step 2.3: Implement `backend/scripts/calibrate_timings.py`**

```python
"""
calibrate_timings.py — measure real G-Hosp server latency for key actions.

Usage:
    python backend/scripts/calibrate_timings.py \
        --logs-dir ~/Dev/Pediatrics/logs

Output: table of p50/p95/p99 per endpoint + recommended sleep_ms for dom-engine.js.

The current hardcoded waits in dom-engine.js are:
  prescription_save  → 1500ms  (after save, before clicking print)
  discharge_save     → 4000ms  (after discharge submit, polling for success)
  cid_autocomplete   → varies  (implicit in waitFor)
"""
import argparse
import glob
import json
import os
import re
from collections import defaultdict
from typing import Optional


ENDPOINT_PATTERNS = [
    ("prescription_save", "POST", re.compile(r"/matmeds|/receitas")),
    ("discharge_save",    "PATCH|PUT", re.compile(r"/interns/\d+$")),
    ("cid_autocomplete",  "GET",  re.compile(r"/autocomplete|/cids\?")),
    ("soap_save",         "PATCH|PUT", re.compile(r"/prconsultas/\d+|/pranamneses/\d+")),
]

# Current hardcoded waits in dom-engine.js for reference
CURRENT_WAITS_MS = {
    "prescription_save": 1500,
    "discharge_save": 4000,
}


def detect_endpoint(method: str, url: str) -> Optional[str]:
    for name, methods_pattern, url_pattern in ENDPOINT_PATTERNS:
        if not re.search(methods_pattern, method):
            continue
        path = url.split("?")[0].split(url.split("/")[2])[-1] if "//" in url else url
        if url_pattern.search(url):
            return name
    return None


def percentile(durations: list[float], pct: int) -> float:
    if not durations:
        raise ValueError("empty durations list")
    sorted_d = sorted(durations)
    k = (len(sorted_d) - 1) * pct / 100
    lo, hi = int(k), min(int(k) + 1, len(sorted_d) - 1)
    return sorted_d[lo] + (sorted_d[hi] - sorted_d[lo]) * (k - lo)


def analyze_events(events: list[dict]) -> dict[str, dict]:
    """Return {endpoint_name: {count, p50, p95, p99, min, max}} for successful responses."""
    # Build request lookup: id → (method, url)
    requests: dict[int, tuple[str, str]] = {}
    for ev in events:
        if ev.get("event") == "network_request":
            req_id = ev.get("id")
            if req_id is not None:
                requests[req_id] = (ev.get("method", ""), ev.get("url", ""))

    # Match responses
    durations_by_endpoint: dict[str, list[float]] = defaultdict(list)
    for ev in events:
        if ev.get("event") != "network_response":
            continue
        status = ev.get("status", 0)
        if status < 200 or status >= 400:
            continue
        req_id = ev.get("id")
        if req_id not in requests:
            continue
        method, url = requests[req_id]
        endpoint = detect_endpoint(method, url)
        if endpoint:
            duration_ms = ev.get("duration_ms", 0)
            if duration_ms > 0:
                durations_by_endpoint[endpoint].append(float(duration_ms))

    results = {}
    for endpoint, durations in durations_by_endpoint.items():
        if not durations:
            continue
        results[endpoint] = {
            "count": len(durations),
            "p50": round(percentile(durations, 50)),
            "p95": round(percentile(durations, 95)),
            "p99": round(percentile(durations, 99)),
            "min": round(min(durations)),
            "max": round(max(durations)),
        }
    return results


def load_events_from_dir(logs_dir: str) -> list[dict]:
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

    events = load_events_from_dir(args.logs_dir)
    print(f"Loaded {len(events)} events from {args.logs_dir}\n")

    results = analyze_events(events)
    if not results:
        print("No matching network events found.")
        print("The JSONL files may only contain interaction events (click/input), not network events.")
        print("Network events are in ghosp_network_*.jsonl files if logged separately.")
        return

    print(f"{'Endpoint':<25} {'Count':>5} {'p50ms':>6} {'p95ms':>6} {'p99ms':>6} {'min':>6} {'max':>6}  Recommendation")
    print("-" * 100)
    for endpoint, stats in sorted(results.items()):
        current = CURRENT_WAITS_MS.get(endpoint)
        rec = stats["p99"] + 200  # 200ms safety buffer above p99
        flag = ""
        if current:
            if rec < current * 0.7:
                flag = f"← can tighten to {rec}ms (currently {current}ms)"
            elif rec > current * 1.3:
                flag = f"← INCREASE to {rec}ms (currently {current}ms) ⚠️"
            else:
                flag = f"✓ current {current}ms is fine"
        print(f"{endpoint:<25} {stats['count']:>5} {stats['p50']:>6} {stats['p95']:>6} "
              f"{stats['p99']:>6} {stats['min']:>6} {stats['max']:>6}  {flag}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2.4: Run tests**

```bash
cd /Users/admin/Dev/tocafichadr-extension/backend
python -m pytest tests/test_calibrate_timings.py -v
```
Expected: All 9 tests pass.

- [ ] **Step 2.5: Run against real logs**

```bash
cd /Users/admin/Dev/tocafichadr-extension/backend
python scripts/calibrate_timings.py --logs-dir ~/Dev/Pediatrics/logs
```
Note: network events are sparse in the JSONL files (most sessions are interaction-only). If the output says "No matching network events found", the `ghosp_network_*.jsonl` files (2 exist: `ghosp_network_20260302_215310.jsonl`, `ghosp_network_20260308_091349.jsonl`) contain dedicated network captures. Run again pointing at those if needed.

- [ ] **Step 2.6: Commit**

```bash
cd /Users/admin/Dev/tocafichadr-extension
git add backend/scripts/calibrate_timings.py backend/tests/test_calibrate_timings.py
git commit -m "feat: network timing calibrator for DOM wait time calibration"
```

---

## Task 3: Workflow Gap Detector

Groups JSONL events into patient sessions (bounded by navigation to `/amb/interns?intern_id=X`), correlates with `audit_log` entries (from `~/Dev/Pediatrics/data/audit.db`), and reports what the doctor did manually in each session that the extension didn't log as automated.

**Files:**
- Create: `backend/scripts/detect_gaps.py`
- Create: `backend/tests/test_detect_gaps.py`

**Session boundary logic:** A new session starts when the `page_url` contains `/amb/interns?intern_id=` with a different `intern_id` than the current session. Each session accumulates all events until the next boundary.

**Gap definition:** A click/input event in a session that does NOT match any known extension-automated selector (from `ghosp.json` known keys) AND is not a navigation click (`href` to a known G-Hosp list page). These are candidates for new automation.

- [ ] **Step 3.1: Write failing tests**

Create `backend/tests/test_detect_gaps.py`:

```python
import json
import sqlite3
import sys
import os
import pytest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import detect_gaps as DG


def _ev(event, css, page_url, ts, **kw):
    return dict(event=event, css_selector=css, page_url=page_url, ts=ts,
                tag=kw.get("tag", ""), href=kw.get("href", ""),
                id=kw.get("id_", ""), text=kw.get("text", ""))


BASE_URL = "https://prbentogoncalves.g-hosp.com.br/amb/interns?intern_id="


class TestExtractInternId:
    def test_query_param(self):
        url = f"{BASE_URL}12345"
        assert DG.extract_intern_id(url) == "12345"

    def test_path_based(self):
        url = "https://prbentogoncalves.g-hosp.com.br/pr/interns/67890/prconsultas"
        assert DG.extract_intern_id(url) == "67890"

    def test_non_patient_page_returns_none(self):
        assert DG.extract_intern_id("https://prbentogoncalves.g-hosp.com.br/prconsultas") is None


class TestSplitSessions:
    def test_single_session(self):
        events = [
            _ev("click", "#foo", f"{BASE_URL}100", "2026-05-20T10:00:00.000Z"),
            _ev("click", "#bar", f"{BASE_URL}100", "2026-05-20T10:01:00.000Z"),
        ]
        sessions = DG.split_sessions(events)
        assert len(sessions) == 1
        assert sessions[0]["intern_id"] == "100"
        assert len(sessions[0]["events"]) == 2

    def test_two_sessions(self):
        events = [
            _ev("click", "#a", f"{BASE_URL}1", "2026-05-20T10:00:00.000Z"),
            _ev("click", "#b", f"{BASE_URL}2", "2026-05-20T10:05:00.000Z"),
            _ev("click", "#c", f"{BASE_URL}2", "2026-05-20T10:06:00.000Z"),
        ]
        sessions = DG.split_sessions(events)
        assert len(sessions) == 2
        assert sessions[0]["intern_id"] == "1"
        assert sessions[1]["intern_id"] == "2"
        assert len(sessions[1]["events"]) == 2

    def test_non_patient_events_attached_to_last_session(self):
        events = [
            _ev("click", "#a", f"{BASE_URL}5", "2026-05-20T10:00:00.000Z"),
            _ev("click", "#b", "https://prbentogoncalves.g-hosp.com.br/prconsultas",
                "2026-05-20T10:02:00.000Z"),
        ]
        sessions = DG.split_sessions(events)
        assert len(sessions) == 1
        assert len(sessions[0]["events"]) == 2


class TestIsKnownAutomated:
    def test_save_button_is_known(self):
        ev = _ev("click", "#submit_pranamnese", f"{BASE_URL}1", "2026-05-20T10:00:00.000Z",
                 id_="submit_pranamnese")
        assert DG.is_known_automated(ev) is True

    def test_random_nav_link_is_not_gap(self):
        ev = _ev("click", "a.botao", f"{BASE_URL}1", "2026-05-20T10:00:00.000Z",
                 href="/prconsultas", tag="a")
        # Navigation to list page should be excluded
        assert DG.is_nav_click(ev) is True

    def test_unknown_click_is_gap(self):
        ev = _ev("click", "a.custom-button", f"{BASE_URL}1", "2026-05-20T10:00:00.000Z",
                 href="/amb/some_custom_action", tag="a")
        assert DG.is_known_automated(ev) is False
        assert DG.is_nav_click(ev) is False


class TestBuildGapReport:
    def test_report_shape(self):
        sessions = [
            {
                "intern_id": "42",
                "start_ts": "2026-05-20T10:00:00.000Z",
                "end_ts": "2026-05-20T10:10:00.000Z",
                "events": [
                    _ev("click", "#submit_pranamnese", f"{BASE_URL}42",
                        "2026-05-20T10:01:00.000Z", id_="submit_pranamnese"),
                    _ev("click", "a.some-unknown", f"{BASE_URL}42",
                        "2026-05-20T10:02:00.000Z", href="/amb/unknown_action"),
                ],
            }
        ]
        report = DG.build_gap_report(sessions)
        assert "gap_candidates" in report
        assert "total_sessions" in report
        assert report["total_sessions"] == 1
        # The unknown click should be a gap candidate
        assert len(report["gap_candidates"]) >= 1
        # The save button click should NOT be in gaps
        gap_selectors = [g["css_selector"] for g in report["gap_candidates"]]
        assert "#submit_pranamnese" not in gap_selectors
```

- [ ] **Step 3.2: Run tests to verify they fail**

```bash
cd /Users/admin/Dev/tocafichadr-extension/backend
python -m pytest tests/test_detect_gaps.py -v 2>&1 | head -20
```
Expected: `ModuleNotFoundError` for `detect_gaps`.

- [ ] **Step 3.3: Implement `backend/scripts/detect_gaps.py`**

```python
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
```

- [ ] **Step 3.4: Run tests**

```bash
cd /Users/admin/Dev/tocafichadr-extension/backend
python -m pytest tests/test_detect_gaps.py -v
```
Expected: All 11 tests pass.

- [ ] **Step 3.5: Run against real logs**

```bash
cd /Users/admin/Dev/tocafichadr-extension/backend
python scripts/detect_gaps.py \
    --logs-dir ~/Dev/Pediatrics/logs \
    --output /tmp/gap_report.json
```
Review the top 20 gap candidates. High-frequency entries with recognizable G-Hosp elements are automation candidates. Entries like `a.botao` or generic selectors are noise from navigation.

- [ ] **Step 3.6: Commit**

```bash
cd /Users/admin/Dev/tocafichadr-extension
git add backend/scripts/detect_gaps.py backend/tests/test_detect_gaps.py
git commit -m "feat: workflow gap detector from JSONL patient sessions"
```

---

## Task 4: CID Accuracy Pipeline

**Phase A (analysis):** Extracts CID codes the doctor actually typed into G-Hosp from JSONL, producing ground-truth frequency data for tuning the suggestion model.

**Phase B (logging):** Adds a `cid_suggested` action to `audit_log` inside the Flask `/api/suggest-cid` route so future sessions can compare suggestion vs. accepted code.

**Files:**
- Create: `backend/scripts/cid_accuracy.py`
- Modify: `backend/emr_automation/dashboard/routes.py` (add logging to `suggest_cid` endpoint)
- Create: `backend/tests/test_cid_accuracy.py`

The CID code pattern in G-Hosp: letter + 2 digits + optional decimal + optional letter (e.g. `J20.9`, `A09`, `Z00`).

- [ ] **Step 4.1: Write failing tests**

Create `backend/tests/test_cid_accuracy.py`:

```python
import sys
import os
import json
import pytest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import cid_accuracy as CA


def _cid_event(value, ts="2026-05-20T10:00:00.000Z", intern_id="99"):
    return {
        "event": "input",
        "id": "intcid_cid_id",
        "value": value,
        "ts": ts,
        "page_url": f"https://prbentogoncalves.g-hosp.com.br/amb/interns?intern_id={intern_id}",
        "css_selector": "#intcid_cid_id",
        "tag": "input",
    }


class TestIsCidCode:
    def test_valid_full(self):
        assert CA.is_cid_code("J20.9") is True

    def test_valid_short(self):
        assert CA.is_cid_code("A09") is True

    def test_valid_letter_suffix(self):
        assert CA.is_cid_code("Z00.1") is True

    def test_partial_typing_rejected(self):
        assert CA.is_cid_code("J") is False
        assert CA.is_cid_code("J2") is False

    def test_empty_rejected(self):
        assert CA.is_cid_code("") is False

    def test_description_text_rejected(self):
        assert CA.is_cid_code("Bronquite aguda") is False


class TestExtractCidInputs:
    def test_extracts_final_value_per_session(self):
        events = [
            _cid_event("J", "2026-05-20T10:00:00.000Z", "5"),
            _cid_event("J20", "2026-05-20T10:00:01.000Z", "5"),
            _cid_event("J20.9", "2026-05-20T10:00:02.000Z", "5"),
        ]
        results = CA.extract_cid_inputs(events)
        # Should capture the final valid CID per intern_id session
        assert len(results) == 1
        assert results[0]["cid_code"] == "J20.9"
        assert results[0]["intern_id"] == "5"

    def test_ignores_partial_typing(self):
        events = [_cid_event("J2", "2026-05-20T10:00:00.000Z", "7")]
        results = CA.extract_cid_inputs(events)
        assert results == []

    def test_multiple_sessions(self):
        events = [
            _cid_event("J20.9", "2026-05-20T10:00:00.000Z", "1"),
            _cid_event("A09", "2026-05-20T11:00:00.000Z", "2"),
        ]
        results = CA.extract_cid_inputs(events)
        codes = {r["cid_code"] for r in results}
        assert codes == {"J20.9", "A09"}


class TestBuildFrequencyReport:
    def test_ranks_by_frequency(self):
        inputs = [
            {"cid_code": "J20.9", "intern_id": "1", "ts": "2026-05-20T10:00:00Z"},
            {"cid_code": "J20.9", "intern_id": "2", "ts": "2026-05-20T11:00:00Z"},
            {"cid_code": "A09",   "intern_id": "3", "ts": "2026-05-20T12:00:00Z"},
        ]
        report = CA.build_frequency_report(inputs)
        assert report[0]["cid_code"] == "J20.9"
        assert report[0]["count"] == 2
        assert report[1]["cid_code"] == "A09"
        assert report[1]["count"] == 1
```

- [ ] **Step 4.2: Run tests to verify they fail**

```bash
cd /Users/admin/Dev/tocafichadr-extension/backend
python -m pytest tests/test_cid_accuracy.py -v 2>&1 | head -20
```
Expected: `ModuleNotFoundError` for `cid_accuracy`.

- [ ] **Step 4.3: Implement `backend/scripts/cid_accuracy.py`**

```python
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
```

- [ ] **Step 4.4: Run tests**

```bash
cd /Users/admin/Dev/tocafichadr-extension/backend
python -m pytest tests/test_cid_accuracy.py -v
```
Expected: All 9 tests pass.

- [ ] **Step 4.5: Add `cid_suggested` logging to Flask**

Read current `suggest_cid` function location:

```bash
grep -n "suggest.cid\|suggest_cid\|/suggest-cid" /Users/admin/Dev/tocafichadr-extension/backend/emr_automation/dashboard/routes.py | head -10
```

Then find the `suggest_cid` route handler and add audit logging. The change is a single `audit.log_action(...)` call after a successful suggestion. Open the file and locate the route:

```python
# Find the line that returns the suggestion JSON (something like):
# return jsonify({"code": suggestion["code"], ...})
# Add BEFORE the return:
try:
    audit.log_action(
        action_type="cid_suggested",
        patient_id=str(intern_id) if intern_id else None,
        details=json.dumps({"code": suggestion.get("code"), "confidence": suggestion.get("confidence")}),
        success=True,
    )
except Exception:
    pass  # audit must not break the response
```

This exact edit requires reading the current file first. After reading:

```bash
grep -n "def.*suggest\|cid_suggest\|suggest.cid" /Users/admin/Dev/tocafichadr-extension/backend/emr_automation/dashboard/routes.py
```

Make the surgical edit using the Edit tool at the identified line.

- [ ] **Step 4.6: Run all tests to verify no regression**

```bash
cd /Users/admin/Dev/tocafichadr-extension/backend
python -m pytest tests/ -v 2>&1 | tail -20
```
Expected: All existing tests pass + 9 new cid_accuracy tests pass.

- [ ] **Step 4.7: Run against real logs**

```bash
cd /Users/admin/Dev/tocafichadr-extension/backend
python scripts/cid_accuracy.py --logs-dir ~/Dev/Pediatrics/logs
```
Expected: ranked list of CID codes (e.g. J20.9 for Bronquite aguda will likely dominate pediatric UPA sessions).

- [ ] **Step 4.8: Commit**

```bash
cd /Users/admin/Dev/tocafichadr-extension
git add backend/scripts/cid_accuracy.py backend/tests/test_cid_accuracy.py \
        backend/emr_automation/dashboard/routes.py
git commit -m "feat: CID accuracy pipeline — ground truth extraction + suggestion logging"
```

---

## Full Test Suite Check

After all 4 tasks are committed, run the full suite:

```bash
cd /Users/admin/Dev/tocafichadr-extension/backend
python -m pytest tests/ -v
```
Expected: all pre-existing tests pass + 4 new test files pass (≥43 total tests).

---

## Self-Review

**Spec coverage:**
- ✅ Item 1 (selector hardening) → Task 1 (`analyze_selectors.py` → `ghosp_derived.json`)
- ✅ Item 2 (race condition calibration) → Task 2 (`calibrate_timings.py` → p50/p95/p99 table)
- ✅ Item 3 (workflow gap detection) → Task 3 (`detect_gaps.py` → gap candidates)
- ✅ Item 4 (CID accuracy tuning) → Task 4 (`cid_accuracy.py` + Flask logging)

**Placeholder scan:** None found — all code blocks are complete and runnable.

**Type consistency:** `extract_intern_id` in `detect_gaps.py` and `_extract_intern_id` in `cid_accuracy.py` are both private to their module. `split_sessions` in `detect_gaps.py` is used correctly by `build_gap_report`. `rank_selectors` in `analyze_selectors.py` is used correctly by `build_derived_config`.

**One known gap:** Task 4 Step 4.5 requires reading `routes.py` to find the exact line number before editing — this is by design (surgical change, avoids guessing at structure that changes between sessions).
