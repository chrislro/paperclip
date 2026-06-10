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
        # Recommendation is p95 + 500ms buffer, NOT p99+buffer. p99 is unstable
        # on small samples (n=63 in 2026-05-25 logs had a single 19s outlier
        # that would have pushed the rec to 10.7s — a 9s UX regression on
        # every action to catch one fluke event). p95 catches 95% of traffic
        # comfortably; the outlier tail is flagged separately.
        rec = stats["p95"] + 500
        outlier = ""
        if stats["p99"] > stats["p95"] * 3:
            outlier = f"  ⚠ p99={stats['p99']}ms is {stats['p99']//stats['p95']}× p95 — investigate tail"
        flag = ""
        if current:
            if rec < current * 0.7:
                flag = f"← can tighten to {rec}ms (currently {current}ms)"
            elif rec > current * 1.3:
                flag = f"← INCREASE to {rec}ms (currently {current}ms) ⚠️"
            else:
                flag = f"✓ current {current}ms is fine"
        print(f"{endpoint:<25} {stats['count']:>5} {stats['p50']:>6} {stats['p95']:>6} "
              f"{stats['p99']:>6} {stats['min']:>6} {stats['max']:>6}  {flag}{outlier}")


if __name__ == "__main__":
    main()
