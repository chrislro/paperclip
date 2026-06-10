#!/usr/bin/env python3
"""Run a small de-identified SOAP/CID regression eval.

Input JSONL schema, one case per line:
  {
    "id": "case-001",
    "raw_transcript": "Paciente refere febre...",
    "chief_complaint": "febre",
    "expected_cid_candidates": ["R50", "J06.9"],
    "forbidden_claims": ["dispneia", "vômitos"],
    "required_soap_phrases": ["febre"]
  }

This script intentionally uses explicit constraints instead of exact string
matching; SOAP wording can vary while still being clinically safe.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

from emr_automation.extension_api import format_soap, suggest_cid  # noqa: E402
from emr_automation.openai_auth import build_openai_client  # noqa: E402


def _load_cases(path: Path) -> list[dict]:
    cases: list[dict] = []
    with path.open("r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                case = json.loads(line)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"{path}:{line_no}: invalid JSON: {exc}") from exc
            if not isinstance(case, dict):
                raise SystemExit(f"{path}:{line_no}: case must be an object")
            cases.append(case)
    return cases


def _validate_cases(cases: list[dict], min_cases: int) -> None:
    if len(cases) < min_cases:
        raise SystemExit(f"Need at least {min_cases} cases; got {len(cases)}")
    required = {"id", "raw_transcript"}
    for idx, case in enumerate(cases, 1):
        missing = required - set(case)
        if missing:
            raise SystemExit(f"case #{idx} missing required fields: {sorted(missing)}")


def _contains_all(text: str, phrases: list[str]) -> list[str]:
    lower = (text or "").lower()
    return [p for p in phrases if str(p).lower() not in lower]


def _contains_any(text: str, phrases: list[str]) -> list[str]:
    lower = (text or "").lower()
    return [p for p in phrases if str(p).lower() in lower]


def _run_case(case: dict, client) -> dict:
    raw = str(case.get("raw_transcript") or "")
    complaint = str(case.get("chief_complaint") or "")

    soap_result = format_soap(raw_text=raw, chief_complaint=complaint, client=client)
    soap_text = str(soap_result.get("formatted_soap") or soap_result.get("soap") or "")

    cid_result = suggest_cid(soap_text=soap_text or raw, chief_complaint=complaint, client=client)
    cid_code = str(cid_result.get("cid_code") or "")

    expected_cids = [str(c) for c in case.get("expected_cid_candidates", [])]
    forbidden_hits = _contains_any(soap_text, [str(x) for x in case.get("forbidden_claims", [])])
    missing_required = _contains_all(soap_text, [str(x) for x in case.get("required_soap_phrases", [])])
    cid_ok = not expected_cids or cid_code in expected_cids

    critical_failures = []
    if forbidden_hits:
        critical_failures.append("forbidden_claim")
    if not cid_ok:
        critical_failures.append("cid_mismatch")

    score = 3
    if critical_failures:
        score = 0
    elif missing_required:
        score = 1
    elif expected_cids and cid_ok:
        score = 3

    return {
        "id": case.get("id"),
        "score": score,
        "cid_code": cid_code,
        "cid_ok": cid_ok,
        "forbidden_hits": forbidden_hits,
        "missing_required": missing_required,
        "providers": {
            "soap": (soap_result.get("providers") or {}).get("soap"),
            "cid": (cid_result.get("providers") or {}).get("cid"),
        },
        "timing": {
            "soap": soap_result.get("timing") or {},
            "cid": cid_result.get("timing") or {},
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cases", type=Path, help="De-identified SOAP/CID JSONL cases")
    parser.add_argument("--min-cases", type=int, default=20)
    parser.add_argument("--limit", type=int, default=0, help="Run only the first N cases")
    parser.add_argument("--check-only", action="store_true", help="Validate schema/count without calling providers")
    args = parser.parse_args()

    cases = _load_cases(args.cases)
    _validate_cases(cases, args.min_cases)
    if args.limit:
        cases = cases[: args.limit]

    if args.check_only:
        print(json.dumps({"ok": True, "cases": len(cases)}, ensure_ascii=False))
        return 0

    client = build_openai_client()
    if client is None:
        raise SystemExit("OpenAI config missing; cannot run SOAP/CID eval")

    results = [_run_case(case, client) for case in cases]
    failures = [r for r in results if r["score"] == 0]
    summary = {
        "ok": not failures,
        "cases": len(results),
        "critical_failures": len(failures),
        "avg_score": round(sum(r["score"] for r in results) / max(len(results), 1), 2),
        "results": results,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
