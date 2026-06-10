"""Benchmark CID-10 model alternatives.

Runs identical CID prompts through 4 candidate models, measures latency,
schema adherence, and CID-10 code agreement vs the current production
model (gpt-4o-mini). Prints a comparison table.

Reads keys from the backend .env (same source Flask uses).
"""
import os
import sys
import json
import time
from pathlib import Path
from statistics import median

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

GROQ_KEY = os.environ.get("GROQ_API_KEY")
OPENAI_KEY = os.environ.get("OPENAI_OAUTH_ACCESS_TOKEN") or os.environ.get("OPENAI_API_KEY")

if not GROQ_KEY or not OPENAI_KEY:
    sys.exit(f"Missing keys: GROQ={'set' if GROQ_KEY else 'MISSING'} OPENAI={'set' if OPENAI_KEY else 'MISSING'}")

CID_SYSTEM_PROMPT = (
    "Você é um assistente médico geral (adulto e pediátrico). Dada uma nota SOAP, sugira o código CID-10 mais provável.\n"
    "Prefira códigos guarda-chuva (ex: J06.9 para IVAS, J18.9 para pneumonia) em vez de subcategorias muito específicas.\n"
    'Responda APENAS em JSON com: "cid_code", "cid_name", "confidence".'
)

# Real Brazilian Portuguese pediatric scenarios. expected_prefix is the
# CID-10 chapter we'd consider correct; multiple acceptable codes per case.
TEST_CASES = [
    {
        "id": "ivas",
        "complaint": "febre",
        "transcript": "Paciente, 5 anos, com febre há 3 dias até 38.8°C, tosse seca, coriza hialina. Nega dispneia. Orofaringe hiperemiada sem placas. Otoscopia normal. Bom estado geral, hidratado.",
        "accept_codes": ["J06.9", "J00", "J06"],
    },
    {
        "id": "gastro",
        "complaint": "diarreia",
        "transcript": "Mãe relata 5 episódios de evacuações líquidas hoje, sem sangue ou muco. Vomitou duas vezes pela manhã. Aceita líquidos via oral. Sem febre. Abdome flácido sem dor.",
        "accept_codes": ["A09", "A09.9", "K52.9"],
    },
    {
        "id": "appendicite",
        "complaint": "dor abdominal",
        "transcript": "Adolescente de 12 anos com dor abdominal periumbilical há 12h, agora migrando para fossa ilíaca direita. Náusea, anorexia, sem febre. Blumberg positivo. Murphy negativo.",
        "accept_codes": ["K35.8", "K35.80", "K35", "K35.9"],
    },
    {
        "id": "asma",
        "complaint": "falta de ar",
        "transcript": "Paciente asmático conhecido, em crise. Sibilância difusa bilateral, taquidispneia, SpO2 92% em ar ambiente. Uso de musculatura acessória. Já em uso domiciliar de salbutamol sem melhora.",
        "accept_codes": ["J45.9", "J45.0", "J45.1", "J45"],
    },
    {
        "id": "otite",
        "complaint": "dor de ouvido",
        "transcript": "Criança de 3 anos com otalgia à direita há 24h, febre 38°C, irritabilidade. Otoscopia: membrana timpânica direita hiperemiada e abaulada. Resfriado prévio há 4 dias.",
        "accept_codes": ["H66.9", "H66.0", "H66"],
    },
    {
        "id": "bronquiolite",
        "complaint": "tosse e chiado",
        "transcript": "Lactente de 8 meses, segundo episódio de sibilância. Coriza há 3 dias, hoje com tosse, taquipneia 60irpm, tiragem subcostal leve. SpO2 95%. Sibilos difusos. Boa hidratação.",
        "accept_codes": ["J21.9", "J21.0", "J21"],
    },
    {
        "id": "ivu",
        "complaint": "dor para urinar",
        "transcript": "Menina de 6 anos com disúria há 2 dias, polaciúria, urina turva e fétida. Sem febre. EAS: leucocitúria, nitrito positivo.",
        "accept_codes": ["N39.0", "N30.9", "N30.0"],
    },
    {
        "id": "varicela",
        "complaint": "lesões na pele",
        "transcript": "Criança de 4 anos com surgimento há 2 dias de lesões vesiculares pruriginosas em couro cabeludo, tronco e membros, em diferentes estágios evolutivos. Febre baixa. Contato escolar com caso confirmado.",
        "accept_codes": ["B01.9", "B01"],
    },
]

PROVIDERS = [
    {
        "name": "OpenAI gpt-4o-mini (current)",
        "client": OpenAI(api_key=OPENAI_KEY),
        "model": "gpt-4o-mini",
        "cost_in_per_1m": 0.150,
        "cost_out_per_1m": 0.600,
    },
    {
        "name": "OpenAI gpt-4.1-nano",
        "client": OpenAI(api_key=OPENAI_KEY),
        "model": "gpt-4.1-nano",
        "cost_in_per_1m": 0.100,
        "cost_out_per_1m": 0.400,
    },
    {
        "name": "Groq llama-3.1-8b-instant",
        "client": OpenAI(api_key=GROQ_KEY, base_url="https://api.groq.com/openai/v1"),
        "model": "llama-3.1-8b-instant",
        "cost_in_per_1m": 0.05,
        "cost_out_per_1m": 0.08,
    },
    {
        "name": "Groq llama-3.3-70b-versatile",
        "client": OpenAI(api_key=GROQ_KEY, base_url="https://api.groq.com/openai/v1"),
        "model": "llama-3.3-70b-versatile",
        "cost_in_per_1m": 0.59,
        "cost_out_per_1m": 0.79,
    },
]

RUNS_PER_CASE = 3


def run_once(provider, complaint, transcript):
    t0 = time.perf_counter()
    try:
        r = provider["client"].chat.completions.create(
            model=provider["model"],
            messages=[
                {"role": "system", "content": CID_SYSTEM_PROMPT},
                {"role": "user", "content": f"Queixa: {complaint}\n\nTranscrição:\n{transcript}"},
            ],
            temperature=0.1,
            max_tokens=150,
            response_format={"type": "json_object"},
        )
        latency = time.perf_counter() - t0
        content = r.choices[0].message.content
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            return {"latency": latency, "result": None, "error": "invalid_json", "raw": content[:120]}
        usage = getattr(r, "usage", None)
        return {
            "latency": latency,
            "result": parsed,
            "error": None,
            "in_tokens": getattr(usage, "prompt_tokens", 0) if usage else 0,
            "out_tokens": getattr(usage, "completion_tokens", 0) if usage else 0,
        }
    except Exception as e:
        return {"latency": time.perf_counter() - t0, "result": None, "error": str(e)[:200]}


def code_matches(predicted, accepted):
    if not predicted:
        return False
    predicted = predicted.strip().upper()
    for ok in accepted:
        ok = ok.upper()
        if predicted == ok or predicted.startswith(ok) or ok.startswith(predicted):
            return True
    return False


def main():
    print(f"\n{'='*88}")
    print(f"CID-10 Model Benchmark — {len(TEST_CASES)} cases × {RUNS_PER_CASE} runs × {len(PROVIDERS)} models")
    print(f"{'='*88}")

    summaries = {p["name"]: {"latencies": [], "matches": 0, "errors": 0, "in_tokens": 0, "out_tokens": 0} for p in PROVIDERS}

    for case in TEST_CASES:
        print(f"\n--- Case [{case['id']}] queixa='{case['complaint']}' (accept: {case['accept_codes']})")
        for prov in PROVIDERS:
            runs = [run_once(prov, case["complaint"], case["transcript"]) for _ in range(RUNS_PER_CASE)]
            latencies = [r["latency"] for r in runs if r["error"] is None]
            errors = sum(1 for r in runs if r["error"] is not None)
            successful = [r for r in runs if r["error"] is None]
            if latencies:
                med = median(latencies)
                worst = max(latencies)
            else:
                med = worst = float("nan")
            best = successful[0]["result"] if successful else None
            code = (best or {}).get("cid_code")
            name = (best or {}).get("cid_name")
            confidence = (best or {}).get("confidence", 0)
            match = code_matches(code, case["accept_codes"])
            in_tok = sum(r.get("in_tokens", 0) for r in successful)
            out_tok = sum(r.get("out_tokens", 0) for r in successful)
            summaries[prov["name"]]["latencies"].extend(latencies)
            summaries[prov["name"]]["matches"] += 1 if match else 0
            summaries[prov["name"]]["errors"] += errors
            summaries[prov["name"]]["in_tokens"] += in_tok
            summaries[prov["name"]]["out_tokens"] += out_tok
            ok_marker = "✓" if match else "✗"
            print(f"  {ok_marker} {prov['name']:<38} med={med:.2f}s worst={worst:.2f}s  {code} {str(name)[:30]:<30} conf={confidence}")
            if errors:
                last_err = next((r["error"] for r in runs if r["error"] is not None), None)
                print(f"      ↳ errors: {errors}/{RUNS_PER_CASE} ({last_err})")

    print(f"\n{'='*88}")
    print("SUMMARY")
    print(f"{'='*88}")
    print(f"{'Model':<38} {'P50':>6} {'P95':>6} {'Worst':>7} {'Acc':>5}/{len(TEST_CASES):<2} {'$/1k calls':>11}")
    print(f"{'-'*88}")
    for prov in PROVIDERS:
        s = summaries[prov["name"]]
        if s["latencies"]:
            sorted_lat = sorted(s["latencies"])
            p50 = median(sorted_lat)
            p95 = sorted_lat[int(0.95 * len(sorted_lat))] if len(sorted_lat) >= 2 else sorted_lat[-1]
            worst = max(sorted_lat)
        else:
            p50 = p95 = worst = float("nan")
        # cost per 1k calls based on observed token usage
        avg_in = s["in_tokens"] / max(len(s["latencies"]), 1)
        avg_out = s["out_tokens"] / max(len(s["latencies"]), 1)
        cost_per_call = (avg_in * prov["cost_in_per_1m"] + avg_out * prov["cost_out_per_1m"]) / 1_000_000
        cost_1k = cost_per_call * 1000
        print(
            f"{prov['name']:<38} {p50:>5.2f}s {p95:>5.2f}s {worst:>6.2f}s {s['matches']:>5}/{len(TEST_CASES):<2} "
            f"${cost_1k:>9.4f}"
        )
    print()


if __name__ == "__main__":
    main()
