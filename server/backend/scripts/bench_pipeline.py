"""Full-pipeline latency benchmark.

Hits both /api/transcribe?skip_soap=1 and /api/soap-stream against a local
Flask backend with a synthesized BR-PT clinical clip, measuring per-stage
and end-to-end perceived latency. Repeats N times per case for variance.

Run on the Mac Mini where Flask is bound to 127.0.0.1:5050.
"""
import os
import sys
import time
import json
import argparse
import subprocess
import urllib.request
import urllib.error
from pathlib import Path
from statistics import median

BASE_URL = os.environ.get("BENCH_BASE", "http://127.0.0.1:5050")
SAMPLE_PATH = Path("/tmp/bench_sample.webm")

CASES = [
    ("febre", "Paciente de 5 anos com febre há 3 dias, tosse seca, coriza hialina. Bom estado geral."),
    ("diarreia", "Mãe relata 5 episódios de evacuações líquidas hoje. Vomitou duas vezes. Aceita líquidos. Sem febre."),
    ("dor abdominal", "Adolescente de 12 anos com dor periumbilical migrando para fossa ilíaca direita. Náusea, sem febre. Blumberg positivo."),
    ("falta de ar", "Asmático conhecido em crise. Sibilância difusa bilateral. SpO2 92% em ar ambiente. Sem melhora com salbutamol domiciliar."),
]


def synthesize(complaint, text):
    """Use macOS `say` + ffmpeg to build a small webm clip."""
    aiff = SAMPLE_PATH.with_suffix(".aiff")
    subprocess.run(
        ["say", "-v", "Luciana", "-o", str(aiff), text],
        check=True, capture_output=True,
    )
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(aiff), "-c:a", "libopus", "-b:a", "32k", str(SAMPLE_PATH)],
        check=True, capture_output=True,
    )
    return SAMPLE_PATH.stat().st_size


def post_transcribe(complaint):
    """Multipart POST. Uses curl because urllib's multipart is painful."""
    t0 = time.perf_counter()
    p = subprocess.run(
        [
            "curl", "-s", "--max-time", "60",
            "-X", "POST",
            f"{BASE_URL}/api/transcribe?skip_soap=1",
            "-F", f"audio=@{SAMPLE_PATH};type=audio/webm",
            "-F", f"chief_complaint={complaint}",
            "-F", "user_id=bench-pipeline",
        ],
        capture_output=True, text=True,
    )
    elapsed = time.perf_counter() - t0
    if p.returncode != 0:
        return elapsed, None, p.stderr
    try:
        return elapsed, json.loads(p.stdout), None
    except json.JSONDecodeError:
        return elapsed, None, f"non-JSON: {p.stdout[:200]}"


def post_soap_stream(transcript, complaint):
    """SSE-style POST. Reads until the connection closes."""
    payload = json.dumps({
        "raw_text": transcript,
        "custom_instructions": "",
    }).encode()
    req = urllib.request.Request(
        f"{BASE_URL}/api/soap-stream",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.perf_counter()
    first_byte = None
    chunks = 0
    body_bytes = 0
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            for raw in resp:
                if first_byte is None:
                    first_byte = time.perf_counter() - t0
                chunks += 1
                body_bytes += len(raw)
        total = time.perf_counter() - t0
        return total, first_byte, chunks, body_bytes, None
    except urllib.error.URLError as e:
        return time.perf_counter() - t0, first_byte, chunks, body_bytes, str(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3, help="Runs per case")
    ap.add_argument("--inter-run-delay", type=float, default=4.0,
                    help="Seconds to sleep between runs (avoid rate limiting)")
    args = ap.parse_args()

    print(f"\n{'='*92}")
    print(f"Full-pipeline latency — {len(CASES)} cases × {args.runs} runs")
    print(f"Endpoints: POST {BASE_URL}/api/transcribe?skip_soap=1 → POST {BASE_URL}/api/soap-stream")
    print(f"{'='*92}")

    all_transcribe = []
    all_soap_total = []
    all_soap_first = []
    all_e2e = []

    for complaint, text in CASES:
        size = synthesize(complaint, text)
        print(f"\n--- queixa='{complaint}' (clip {size/1024:.1f} KB)")
        for i in range(args.runs):
            t_e2e_start = time.perf_counter()
            t_xc, body, err = post_transcribe(complaint)
            if err or not body or not body.get("ok"):
                print(f"  run {i+1}: TRANSCRIBE FAILED — {err or body}")
                continue
            cid = body.get("cid_code")
            transcript = body.get("transcript", "")
            t_soap, t_first, chunks, soap_bytes, soap_err = post_soap_stream(transcript, complaint)
            t_e2e = time.perf_counter() - t_e2e_start
            if soap_err:
                print(f"  run {i+1}: SOAP FAILED — {soap_err}")
                continue
            all_transcribe.append(t_xc)
            all_soap_total.append(t_soap)
            all_soap_first.append(t_first or 0)
            all_e2e.append(t_e2e)
            print(
                f"  run {i+1}: xc={t_xc:.2f}s  soap_ttfb={t_first:.2f}s  soap_total={t_soap:.2f}s "
                f"({chunks} chunks, {soap_bytes}B)  e2e={t_e2e:.2f}s  CID={cid}"
            )
            time.sleep(args.inter_run_delay)

    print(f"\n{'='*92}")
    print("SUMMARY (P50 / P95 / worst)")
    print(f"{'='*92}")
    if all_e2e:
        for label, samples in [
            ("/api/transcribe response", all_transcribe),
            ("SOAP TTFB (first chunk)", all_soap_first),
            ("/api/soap-stream total", all_soap_total),
            ("End-to-end perceived", all_e2e),
        ]:
            srt = sorted(samples)
            p50 = median(srt)
            p95 = srt[int(0.95 * len(srt))] if len(srt) >= 2 else srt[-1]
            worst = max(srt)
            print(f"  {label:<28} P50={p50:.2f}s  P95={p95:.2f}s  worst={worst:.2f}s  (n={len(srt)})")
    else:
        print("  No successful runs.")
    print()


if __name__ == "__main__":
    sys.exit(main())
