"""
API functions for the Chrome extension endpoints.
Wraps transcription + GPT calls without depending on EMRAutomation or Playwright.

Transcription pipeline mirrors the Whisper scripts / audio-to-note approach:
  1. Transcribe with whisper-1 (fallback: gpt-4o-transcribe) — diarization-aware
  2. Generate SOAP as plain text using the full clinical prompt + canonical OBJETIVO block
  3. Post-process: normalize verb voice, append plan footer
  4. Separately suggest CID-10 via GPT JSON call
"""
import json
import io
import os
import re
import time
import logging
from concurrent.futures import ThreadPoolExecutor

try:
    from httpx import Client, Limits
    _http_client = Client(
        http2=True,
        limits=Limits(max_keepalive_connections=5, max_connections=10),
    )
except Exception:
    _http_client = None

from openai import OpenAI
# Pre-import OpenAI resource submodules at module load so worker threads can't
# race the import system. Without this, speculative CID + STT in parallel can
# deadlock on `_ModuleLock('openai.resources.audio')` — the SDK lazy-loads
# resource modules on first access, and Python's import lock is not reentrant
# across threads. Hit live 2026-05-10 14:13.
import openai.resources.audio  # noqa: F401
import openai.resources.chat  # noqa: F401

from emr_automation.openai_auth import build_openai_client

# ---------------------------------------------------------------------------
# Optional Groq STT client (faster, cheaper Whisper inference)
# Set GROQ_API_KEY env var to enable. Falls back to OpenAI if not set.
# ---------------------------------------------------------------------------
_STT_GROQ_MODEL = os.environ.get("STT_GROQ_MODEL", "whisper-large-v3")
_STT_OPENAI_MODEL = os.environ.get("STT_OPENAI_MODEL", "whisper-1")
_STT_OPENAI_FALLBACK_MODEL = os.environ.get("STT_OPENAI_FALLBACK_MODEL", "gpt-4o-transcribe")
_STT_OPENAI_FALLBACK_ENABLED = os.environ.get("STT_OPENAI_FALLBACK_ENABLED", "false").lower() in ("true", "1", "yes")
_SOAP_MODEL = os.environ.get("SOAP_MODEL", "gpt-4o-mini")
_CID_OPENAI_MODEL = os.environ.get("CID_OPENAI_MODEL", "gpt-4o-mini")
_GROQ_TIMEOUT_SECONDS = float(os.environ.get("GROQ_TIMEOUT_SECONDS", "20"))
_GROQ_MAX_RETRIES = int(os.environ.get("GROQ_MAX_RETRIES", "0"))

# SOAP provider selection. Set SOAP_PROVIDER=groq to use Groq for SOAP generation.
# Requires GROQ_API_KEY to be set. Falls back to OpenAI if Groq is unavailable.
_SOAP_PROVIDER = os.environ.get("SOAP_PROVIDER", "openai").lower()
_SOAP_GROQ_MODEL = os.environ.get("SOAP_GROQ_MODEL", "llama-3.3-70b-versatile")

_groq_client = None
if os.environ.get("GROQ_API_KEY"):
    _groq_kwargs = {
        "api_key": os.environ["GROQ_API_KEY"],
        "base_url": "https://api.groq.com/openai/v1",
        "max_retries": _GROQ_MAX_RETRIES,
        "timeout": _GROQ_TIMEOUT_SECONDS,
    }
    if _http_client is not None:
        _groq_kwargs["http_client"] = _http_client
    _groq_client = OpenAI(**_groq_kwargs)

# CID provider selection. Bench 2026-05-10 vs gpt-4o-mini on 8 BR-PT pediatric
# cases: Groq llama-3.3-70b-versatile = 2× faster (P50 0.52s vs 1.06s, P95
# 0.55s vs 2.09s) and +25pp accuracy (87.5% vs 62.5%). Falls back to OpenAI
# on any Groq error. Override with CID_PROVIDER=openai to force fallback.
_CID_GROQ_MODEL = os.environ.get("CID_GROQ_MODEL", "llama-3.3-70b-versatile")
_CID_FORCE_OPENAI = os.environ.get("CID_PROVIDER", "").lower() == "openai"

logger = logging.getLogger(__name__)
# Surface the actual STT + CID providers at boot, not just at call time. Same
# bug class as 2026-04-15 stale-process and 2026-05-10 silent-fallback: code
# looked fine, runtime was wrong. One log line catches it on every restart.
logger.warning(
    "STT provider on boot: %s",
    f"Groq {_STT_GROQ_MODEL}" if _groq_client else f"OpenAI {_STT_OPENAI_MODEL} (FALLBACK)",
)
logger.warning(
    "CID provider on boot: %s",
    f"Groq {_CID_GROQ_MODEL} (fallback: OpenAI {_CID_OPENAI_MODEL})"
    if _groq_client and not _CID_FORCE_OPENAI
    else f"OpenAI {_CID_OPENAI_MODEL}",
)
logger.warning(
    "SOAP provider on boot: %s",
    f"Groq {_SOAP_GROQ_MODEL} (fallback: OpenAI {_SOAP_MODEL})"
    if _SOAP_PROVIDER == "groq" and _groq_client
    else f"OpenAI {_SOAP_MODEL}",
)


def _elapsed_seconds(start: float) -> float:
    return round(time.perf_counter() - start, 3)


def _round_seconds(value: float) -> float:
    return round(value, 3)


def _soap_provider_meta(*, stream: bool = False, fallback: bool = False, error: str | None = None) -> dict:
    use_groq = _SOAP_PROVIDER == "groq" and _groq_client and not fallback
    meta = {
        "provider": "groq" if use_groq else "openai",
        "model": _SOAP_GROQ_MODEL if use_groq else _SOAP_MODEL,
        "stream": stream,
        "fallback": fallback,
    }
    if error:
        meta["error"] = error[:180]
    return meta


def get_soap_provider_metadata(*, stream: bool = False) -> dict:
    """Public helper for routes that stream SOAP outside this module."""
    return _soap_provider_meta(stream=stream)


def _attach_cid_observability(result: dict, provider: dict, elapsed_s: float) -> dict:
    data = dict(result or {})
    # Bug 68: `confidence` comes straight from an LLM. response_format=json_object
    # guarantees valid JSON but NOT that this field is numeric — models occasionally
    # emit "0.85" (string) or "alta". transcribe_audio compares it against a float
    # threshold (`spec_confidence >= _CID_SPECULATIVE_CONFIDENCE_THRESHOLD`), which
    # raises TypeError on a str in Python 3 and crashes the ENTIRE transcription —
    # the doctor loses a recorded consultation to an intermittent model quirk.
    # Normalize to float here, the single choke point every CID result flows through;
    # an unparseable value becomes 0.0 (low confidence → triggers a CID re-run, the
    # safe path), never a crash.
    if "confidence" in data:
        try:
            data["confidence"] = float(data["confidence"])
        except (TypeError, ValueError):
            data["confidence"] = 0.0
    data["_provider"] = provider
    data["_timing_s"] = _round_seconds(elapsed_s)
    return data


def _pop_cid_observability(result: dict) -> tuple[dict, dict, float | None]:
    if not isinstance(result, dict):
        return {}, {}, None
    data = dict(result)
    provider = data.pop("_provider", {}) or {}
    elapsed = data.pop("_timing_s", None)
    return data, provider, elapsed


def _prewarm_apis():
    """Fire lightweight pre-flight requests to warm TLS + HTTP keepalive."""
    try:
        if _groq_client:
            _groq_client.models.list()
            logger.warning("_prewarm_apis: Groq warmed")
    except Exception:
        pass
    try:
        c = build_openai_client(http_client=_http_client)
        if c:
            c.models.list()
            logger.warning("_prewarm_apis: OpenAI warmed")
    except Exception:
        pass


# Run pre-warm once at module import so the first real request is fast.
_prewarm_apis()

# ---------------------------------------------------------------------------
# Canonical clinical text blocks (match the Whisper scripts templates exactly)
# ---------------------------------------------------------------------------

OBJECTIVE_CANONICAL_BLOCK = """OBJETIVO:
Cabeça/Pescoço: Sem meningismos, sem linfadenopatias palpáveis.
Neurológico: Pupilas isocóricas e fotorreagentes, força preservada, reflexos presentes e simétricos.
Cardíaco: Ritmo regular em dois tempos (RR2T), sem sopros.
Respiratório: Murmúrio vesicular presente bilateralmente, sem ruídos adventícios.
Abdome: Normotenso, RHA presentes, Blumberg negativo, sem dor à palpação profunda em todos os quadrantes.
Membros Superiores/Inferiores: Pérvios, sem sinais de TVP.
Orofaringe: Sem particularidades.
Otoscopia: Sem particularidades.
SpO2 em consultório: 99% em ar ambiente."""

PLAN_FOOTER_TEXT = """Forneco sintomaticos.
Oriento sinais de alarme como febre persistente, dispneia, dor abdominal intensa para retorno imediato à emergência.
Em caso de piora ou ausência de melhora, buscar atendimento médico em Unidade Básica de Saúde ou Unidade de Pronto Atendimento.
Acompanhamento de rotina, vacinas e controle de condições crônicas em Unidade Básica de Saúde mais próxima.
Paciente/responsável compreendeu e concordou com as orientações."""

SOAP_TEMPLATE = """\
Você é um escriba médico especialista. Converta a conversa literal a seguir em uma nota SOAP em PT-BR.

REGRAS:
1) NÃO escreva o conteúdo da seção OBJETIVO. Em seu lugar, emita LITERALMENTE o marcador [OBJETIVO_PLACEHOLDER] em uma linha sozinha — ele será substituído por um bloco fixo no pós-processamento.
2) NÃO escreva o rodapé do PLANO. Ele será adicionado no pós-processamento.
3) SUBJETIVO: use APENAS dados explícitos no transcript. PROIBIDO inventar sintomas, durações, localizações, quantidades ou detalhes não mencionados pelo paciente. Máximo 1 a 4 frases curtas em 3ª pessoa ("Paciente relata..."). Se o paciente disse apenas "dor abdominal", escreva APENAS "Paciente refere dor abdominal." sem acrescentar nada. Se o transcript não tiver dados clínicos, escreva exatamente: SEM DADOS NO TRANSCRIPT.
4) Se houver rótulos "SPEAKER_n:", use apenas as falas do paciente para o SUBJETIVO.
5) AVALIAÇÃO: apenas 1 hipótese diagnóstica (a mais provável).
6) PLANO: condutas concisas em 1ª pessoa do singular ("Oriento", "Solicito", "Prescrevo" — nunca infinitivo). Se não houver dados, escreva "Sem dados disponíveis."
7) Retorne SOMENTE a nota SOAP, sem preâmbulos.

Formato exato (mantenha o marcador [OBJETIVO_PLACEHOLDER] como está):
SUBJETIVO:
<texto>

[OBJETIVO_PLACEHOLDER]

AVALIAÇÃO:
1. <diagnóstico>

PLANO:
<condutas>
"""

CID_SYSTEM_PROMPT = (
    "Você é um assistente médico geral (adulto e pediátrico). Dada uma nota SOAP, sugira o código CID-10 mais provável.\n"
    "Prefira códigos guarda-chuva (ex: J06.9 para IVAS, J18.9 para pneumonia) em vez de subcategorias muito específicas.\n"
    "Responda APENAS em JSON com: \"cid_code\", \"cid_name\", \"confidence\"."
)

FORMAT_SYSTEM_PROMPT = (
    "Você é um assistente médico geral (adulto e pediátrico). Formate o texto como nota SOAP em português.\n"
    "Responda APENAS em JSON com: \"formatted_soap\"."
)

# ---------------------------------------------------------------------------
# Post-processing helpers (mirror services.py in Whisper scripts)
# ---------------------------------------------------------------------------

# Anchors marking the START of the model's (paraphrased) closing boilerplate,
# stripped so it doesn't duplicate the canonical PLAN_FOOTER_TEXT appended
# unconditionally below. The model never sees the footer (rule 2 only says "do
# not write it"), so these match natural closing language, NOT a verbatim footer.
#
# Bug 78 (CHRA-2423): "forneço sintomáticos" used to be an anchor here, but it
# is the single most common pediatric *primary* conduct (rule 6 instructs
# first-person conducts) and is usually the FIRST plan line, followed by drug
# doses, lab orders, and return guidance. Matching it truncated the entire plan
# at offset 0 and wrote "Sem dados disponíveis." into the chart (and blanked the
# #recomendas_descricao auto-fill). Only true closing boilerplate — the
# chronic-care referral line and the consent line, which never carry critical
# content after them — may anchor the strip.
_PLANO_FOOTER_ANCHOR_RE = re.compile(
    r"(?i)\b(?:"
    r"vacinas\s+e\s+controle\s+de\s+condi[cç][oõ]es\s+cr[oô]nicas"
    r"|paciente\s*/\s*respons[aá]vel\s+compreendeu\s+e\s+concordou"
    r")\b"
)
_SUBJECTIVE_FIRST_PERSON_PREFIX_RE = re.compile(
    r"(^|(?<=[\.\!\?\n])\s*)(?:eu\s+)?(?:(?:estou|t(?:ô|o))\s+com|tenho)\s+",
    re.IGNORECASE,
)
_SUBJECTIVE_SECTION_RE = re.compile(r"(SUBJETIVO:\s*)([\s\S]*?)(\n\s*OBJETIVO:)", re.IGNORECASE)
_PLANO_HEADER_RE = re.compile(r"(?im)^\s*PLANO:\s*(.*?)(?:\r?\n|$)")
_PLANO_VOICE_REPLACEMENTS = {
    "avaliar": "avalio", "considerar": "considero", "realizar": "realizo",
    "orientar": "oriento", "solicitar": "solicito", "prescrever": "prescrevo",
    "encaminhar": "encaminho", "recomendar": "recomendo",
}
_PLANO_VOICE_RE = re.compile(
    r"(^|[.\n;])(\s*(?:[\-–—•*]\s*)?)("
    + "|".join(map(re.escape, _PLANO_VOICE_REPLACEMENTS.keys()))
    + r")\b",
    re.IGNORECASE | re.MULTILINE,
)


def _normalize_plano_voice(plan_text: str) -> str:
    def repl(match):
        leading, spacing, verb = match.groups()
        replacement = _PLANO_VOICE_REPLACEMENTS.get(verb.lower(), verb)
        if verb[:1].isupper():
            replacement = replacement[:1].upper() + replacement[1:]
        return f"{leading}{spacing}{replacement}"
    return _PLANO_VOICE_RE.sub(repl, plan_text)


def _normalize_subjective_voice(soap_note: str) -> str:
    match = _SUBJECTIVE_SECTION_RE.search(soap_note)
    if not match:
        return soap_note
    prefix, subjective_body, next_header = match.groups()
    subjective_body = subjective_body or ""

    def repl(m):
        return f"{m.group(1)}Paciente relata "

    rewritten = _SUBJECTIVE_FIRST_PERSON_PREFIX_RE.sub(repl, subjective_body)
    if rewritten == subjective_body:
        return soap_note
    normalized_next_header = next_header.lstrip("\r\n")
    replacement = f"{prefix}{rewritten.rstrip()}\n\n{normalized_next_header}"
    # Use a callable replacement, NOT a replacement string: `replacement` is built
    # from model-generated SOAP text, and re.sub interprets backslash escapes and
    # group refs (\1, \g<>) in a replacement STRING. A literal "\2" in the note
    # silently duplicated a captured group into the chart, and a "\d" raised
    # re.error("bad escape") → the whole SOAP request 500'd. A function replacement
    # returns the string verbatim. (Mirrors _normalize_plano_voice, which already
    # uses a callable.)
    return _SUBJECTIVE_SECTION_RE.sub(lambda _m: replacement, soap_note, count=1)


def _strip_appended_footer(plan_body: str) -> str:
    """Remove a previously-appended canonical PLAN_FOOTER_TEXT from the end of the
    plan body, so _postprocess_soap / _extract_plan_from_soap are idempotent and
    safe to run on already-processed text.

    This matches the EXACT footer this module appends (byte-for-byte suffix), and
    must run before the fuzzy _PLANO_FOOTER_ANCHOR_RE strip. Before Bug 78, the
    "forneço sintomáticos" anchor doubled as the re-processing guard (it matched
    the appended footer's first line and cut the whole block); removing that
    anchor to stop it eating primary conducts also removed that guard, so this
    deterministic suffix strip restores it without the over-match.
    """
    if not plan_body:
        return plan_body
    stripped = plan_body.rstrip()
    if stripped.endswith(PLAN_FOOTER_TEXT):
        return stripped[: -len(PLAN_FOOTER_TEXT)].rstrip()
    return plan_body


def _postprocess_soap(soap_note: str) -> str:
    """Normalize voice, substitute OBJETIVO placeholder, ensure canonical plan footer.

    Performance note (Apr 2026): the model emits the literal token
    [OBJETIVO_PLACEHOLDER] instead of generating the ~250-word canonical
    OBJETIVO block. We substitute it here. This roughly halves the output
    token count of the SOAP call (and therefore its latency), since LLM
    generation cost is dominated by output tokens, not input.
    """
    if not soap_note:
        return soap_note
    # Substitute the OBJETIVO placeholder (or insert the block if the model omitted it)
    if "[OBJETIVO_PLACEHOLDER]" in soap_note:
        soap_note = soap_note.replace("[OBJETIVO_PLACEHOLDER]", OBJECTIVE_CANONICAL_BLOCK)
    elif "OBJETIVO:" not in soap_note:
        # Model forgot the section entirely — insert it after SUBJETIVO if possible
        soap_note = soap_note.rstrip() + "\n\n" + OBJECTIVE_CANONICAL_BLOCK
    soap_note = _normalize_subjective_voice(soap_note)
    match = _PLANO_HEADER_RE.search(soap_note)
    if not match:
        cleaned = soap_note.rstrip()
        return f"{cleaned}\n\nPLANO:\nSem dados disponíveis.\n\n{PLAN_FOOTER_TEXT}"

    prefix = soap_note[: match.start()] + "PLANO:\n"
    inline_content = (match.group(1) or "").strip()
    remainder = soap_note[match.end():]
    plan_body = (f"{inline_content}\n{remainder}" if inline_content else remainder).strip()

    plan_body = _strip_appended_footer(plan_body)
    footer_anchor = _PLANO_FOOTER_ANCHOR_RE.search(plan_body)
    if footer_anchor:
        plan_body = plan_body[: footer_anchor.start()].rstrip()

    plan_body = re.sub(r"(?m)^\s*—\s*$\n?", "", plan_body).strip()
    if not plan_body:
        plan_body = "Sem dados disponíveis."

    plan_body = _normalize_plano_voice(plan_body).rstrip()
    return f"{prefix}{plan_body}\n\n{PLAN_FOOTER_TEXT}"


def _extract_plan_from_soap(soap_note: str) -> str:
    """Extract just the PLANO section body from a post-processed SOAP note.

    Returns the plan text (without the "PLANO:" header or the canonical
    PLAN_FOOTER_TEXT), or an empty string if no plan section exists or
    the plan body is the placeholder "Sem dados disponíveis.".

    Used by the extension's v2.7.3 #recomendas_descricao auto-fill — the
    G-Hosp recomendas/conduta field is currently populated by the doctor
    typing the plan body manually after the SOAP is applied. Returning
    the plan as a separate field lets the extension fill that DOM input
    in addition to the SOAP fields.
    """
    if not soap_note:
        return ""
    match = _PLANO_HEADER_RE.search(soap_note)
    if not match:
        return ""
    # _PLANO_HEADER_RE's `\s*` after `PLANO:` may greedily consume the newline
    # immediately after the header, in which case `.*?` captures the first plan
    # line into group(1). Mirror _postprocess_soap's reconstruction logic.
    inline_content = (match.group(1) or "").strip()
    remainder = soap_note[match.end():]
    plan_body = (f"{inline_content}\n{remainder}" if inline_content else remainder).strip()
    plan_body = _strip_appended_footer(plan_body)
    footer_anchor = _PLANO_FOOTER_ANCHOR_RE.search(plan_body)
    if footer_anchor:
        plan_body = plan_body[: footer_anchor.start()].rstrip()
    plan_body = re.sub(r"(?m)^\s*—\s*$\n?", "", plan_body).strip()
    if plan_body == "Sem dados disponíveis." or not plan_body:
        return ""
    return plan_body


def _flatten_diarized_transcript(resp) -> str:
    """Extract plain text from a Whisper transcription response, preserving speaker labels."""
    segments = None
    if isinstance(resp, dict):
        segments = resp.get("segments")
    else:
        segments = getattr(resp, "segments", None)

    if isinstance(segments, list) and segments:
        lines = []
        for seg in segments:
            text = (seg.get("text") if isinstance(seg, dict) else getattr(seg, "text", "")) or ""
            speaker = None
            for key in ("speaker", "speaker_id", "speaker_label"):
                val = seg.get(key) if isinstance(seg, dict) else getattr(seg, key, None)
                if val is not None:
                    speaker = f"SPEAKER_{val}"
                    break
            speaker = speaker or "SPEAKER_0"
            text = text.strip()
            if not text:
                continue
            if lines and lines[-1].startswith(f"{speaker}:"):
                lines[-1] += f" {text}"
            else:
                lines.append(f"{speaker}: {text}")
        if lines:
            return "\n".join(lines)

    # Fallback: plain text attribute
    if isinstance(resp, dict):
        return (resp.get("text") or "").strip()
    return (getattr(resp, "text", None) or "").strip()


# ---------------------------------------------------------------------------
# Public functions
# ---------------------------------------------------------------------------

def _resolve_client(client=None, config=None):
    resolved_client = client or build_openai_client(config)
    if resolved_client is None:
        raise RuntimeError("OpenAI OAuth not configured")
    return resolved_client


# Hardcoded lookup for the most common chief complaints — only used when
# transcript is empty (speculative CID path) to avoid bypassing clinical
# evidence from the full transcription. See NEXT_STEPS.md P1.
_CID_LOOKUP = {
    "febre": {"cid_code": "R50", "cid_name": "Febre", "confidence": 0.99},
    "diarreia": {"cid_code": "A09", "cid_name": "Diarreia", "confidence": 0.99},
    "vomito": {"cid_code": "R11", "cid_name": "Nausea e vomitos", "confidence": 0.99},
    "dor abdominal": {"cid_code": "R10", "cid_name": "Dor abdominal", "confidence": 0.99},
    "tosse": {"cid_code": "J20", "cid_name": "Bronquite aguda", "confidence": 0.99},
    "resfriado": {"cid_code": "J00", "cid_name": "Resfriado comum", "confidence": 0.99},
    "gripe": {"cid_code": "J11.1", "cid_name": "Gripe", "confidence": 0.99},
    "asma": {"cid_code": "J45.9", "cid_name": "Asma", "confidence": 0.99},
    "pneumonia": {"cid_code": "J18.9", "cid_name": "Pneumonia", "confidence": 0.99},
    "otite": {"cid_code": "H66.9", "cid_name": "Otite media", "confidence": 0.99},
    "conjuntivite": {"cid_code": "H10.9", "cid_name": "Conjuntivite", "confidence": 0.99},
    "cefaleia": {"cid_code": "R51", "cid_name": "Cefaleia", "confidence": 0.99},
    "sincope": {"cid_code": "R55", "cid_name": "Sincope", "confidence": 0.99},
    "tontura": {"cid_code": "R42", "cid_name": "Tontura", "confidence": 0.99},
    "dispneia": {"cid_code": "R06.0", "cid_name": "Dispneia", "confidence": 0.99},
    "trauma": {"cid_code": "T14.9", "cid_name": "Traumatismo nao especificado", "confidence": 0.99},
}

# Speculative-CID confidence cutoff: at or above this, we accept the
# chief-complaint-only result and skip the post-STT re-run. 0.7 chosen because
# CID-10 prompts return 0.7-0.95 on confident matches and 0.3-0.6 on guesses.
_CID_SPECULATIVE_CONFIDENCE_THRESHOLD = 0.7


def _run_cid(client, chief_complaint, transcript, *, content_label="Transcrição"):
    """Single-source CID call. Used by speculative (transcript='') and full passes.

    Tries Groq llama-3.3-70b-versatile first (faster + more accurate on BR-PT
    pediatric coding, see bench 2026-05-10). Falls back to OpenAI gpt-4o-mini
    on any Groq error or when CID_PROVIDER=openai is set.
    """
    t0 = time.perf_counter()
    # Safety guard: only use hardcoded lookup for speculative CID (empty
    # transcript) so we never bypass clinical evidence from the full dictation.
    normalized = chief_complaint.strip().lower() if chief_complaint else ""
    if not transcript and normalized in _CID_LOOKUP:
        logger.warning("CID lookup hit for chief_complaint=%s", normalized)
        return _attach_cid_observability(
            _CID_LOOKUP[normalized].copy(),
            {
                "provider": "local_lookup",
                "model": "chief_complaint_lookup",
                "fallback": False,
                "speculative": True,
            },
            time.perf_counter() - t0,
        )

    user_content = f"Queixa: {chief_complaint}\n\n{content_label}:\n{transcript}"
    messages = [
        {"role": "system", "content": CID_SYSTEM_PROMPT},
        {"role": "user", "content": user_content},
    ]

    if _groq_client and not _CID_FORCE_OPENAI:
        try:
            r = _groq_client.chat.completions.create(
                model=_CID_GROQ_MODEL,
                messages=messages,
                temperature=0.1,
                max_tokens=150,
                response_format={"type": "json_object"},
            )
            return _attach_cid_observability(
                json.loads(r.choices[0].message.content),
                {
                    "provider": "groq",
                    "model": _CID_GROQ_MODEL,
                    "fallback": False,
                    "speculative": not bool(transcript),
                },
                time.perf_counter() - t0,
            )
        except Exception as e:
            logger.warning("CID Groq failed, falling back to OpenAI: %s", str(e)[:120])

    try:
        r = client.chat.completions.create(
            model=_CID_OPENAI_MODEL,
            messages=messages,
            temperature=0.1,
            max_tokens=150,
            response_format={"type": "json_object"},
        )
        return _attach_cid_observability(
            json.loads(r.choices[0].message.content),
            {
                "provider": "openai",
                "model": _CID_OPENAI_MODEL,
                "fallback": bool(_groq_client and not _CID_FORCE_OPENAI),
                "forced": _CID_FORCE_OPENAI,
                "speculative": not bool(transcript),
            },
            time.perf_counter() - t0,
        )
    except Exception as e:
        logger.warning("CID suggestion error: %s", e)
        return _attach_cid_observability(
            {},
            {
                "provider": "none",
                "model": None,
                "fallback": bool(_groq_client and not _CID_FORCE_OPENAI),
                "error": str(e)[:180],
                "speculative": not bool(transcript),
            },
            time.perf_counter() - t0,
        )


def transcribe_audio(
    audio_bytes,
    mime_type,
    chief_complaint="",
    *,
    client=None,
    config=None,
    custom_instructions="",
    skip_soap=False,
    audio_metadata=None,
):
    """Transcribe audio then format as SOAP via GPT.

    Optimized pipeline (Apr 2026):
      1) whisper-1 directly (skip gpt-4o-transcribe + chunking_strategy=auto
         which adds 2-4s of overhead with no quality gain on short clips).
      2) SOAP and CID calls run IN PARALLEL — both depend only on the
         transcript, not on each other. Saves ~2-3s vs the old sequential flow.
      3) response_format=text (not verbose_json) — smaller payload, faster.

    Per-step timing is logged so end-to-end latency can be tracked.

    skip_soap=True returns immediately after Whisper+CID, with soap=None. The
    caller (extension side panel, v3.1.1+) then opens an SSE connection to
    /api/soap-stream to receive SOAP tokens incrementally. Saves ~1.6-3.2s on
    the response by not blocking on the SOAP completion.
    """
    t0 = time.perf_counter()
    client = _resolve_client(client=client, config=config)
    t_client = time.perf_counter() - t0
    if t_client > 0.1:
        logger.warning("transcribe_audio: client init slow: %.2fs", t_client)

    ext = "webm" if "webm" in mime_type else "mp4"
    audio_file = io.BytesIO(audio_bytes)
    audio_file.name = f"recording.{ext}"
    audio_kb = len(audio_bytes) / 1024
    logger.warning("transcribe_audio: audio size %.1f KB", audio_kb)
    if isinstance(audio_metadata, dict) and audio_metadata:
        logger.warning("transcribe_audio: browser audio metadata %s", json.dumps(audio_metadata, ensure_ascii=False)[:600])

    # CHRA-1102: extract client timestamps from audio_metadata for observability
    client_timings = {}
    if isinstance(audio_metadata, dict):
        client_timings = audio_metadata.get("client_timestamps") or {}

    timing = {
        "client_init_s": _round_seconds(t_client),
        "audio_kb": round(audio_kb, 1),
    }
    # CHRA-1102: include raw client timestamps so the dashboard can correlate
    if client_timings:
        timing["client_timestamps"] = client_timings
    providers = {
        "stt": None,
        "cid": None,
        "soap": {"provider": "deferred", "model": None, "stream": True} if skip_soap else None,
    }
    audio_info = {
        "bytes": len(audio_bytes),
        "kb": round(audio_kb, 1),
        "mime_type": mime_type,
    }
    if isinstance(audio_metadata, dict) and audio_metadata:
        audio_info["client"] = audio_metadata

    # --- Speculative CID: fire in parallel to STT using chief_complaint only.
    # If confidence ≥ threshold post-STT, we skip the CID re-run and save the
    # CID round-trip on the critical path (≈0.5-2s observed). Skipped when
    # there's no chief_complaint to seed from.
    spec_pool = ThreadPoolExecutor(max_workers=1) if chief_complaint.strip() else None
    spec_cid_future = (
        spec_pool.submit(_run_cid, client, chief_complaint, "") if spec_pool else None
    )

    # --- Step 1: Transcription ---
    # Use Groq if available (faster + cheaper), otherwise OpenAI whisper-1.
    transcript = None
    stt_client = _groq_client or client
    stt_provider = "groq" if _groq_client else "openai"
    stt_model = _STT_GROQ_MODEL if _groq_client else _STT_OPENAI_MODEL
    t_stt = time.perf_counter()
    try:
        resp = stt_client.audio.transcriptions.create(
            model=stt_model,
            file=audio_file,
            language="pt",
            response_format="text",
        )
        transcript = (resp if isinstance(resp, str) else getattr(resp, "text", "")).strip()
        if _groq_client:
            logger.warning("transcribe_audio: used Groq %s", stt_model)
        providers["stt"] = {
            "provider": stt_provider,
            "model": stt_model,
            "fallback": False,
        }
    except Exception as e:
        # Always log when fallback would have fired so we can track Groq reliability.
        logger.warning("STT fallback would fire: %s failed (%s)", stt_provider, str(e)[:180])
        if stt_provider == "groq" and not _STT_OPENAI_FALLBACK_ENABLED:
            providers["stt"] = {
                "provider": "groq",
                "model": stt_model,
                "fallback": False,
                "error": str(e)[:180],
            }
            if spec_pool:
                spec_pool.shutdown(wait=False)
            timing["total_s"] = _elapsed_seconds(t0)
            return {
                "ok": False,
                "error": "STT provider failed and fallback is disabled",
                "providers": providers,
                "timing": timing,
                "audio": audio_info,
                "status_code": 503,
            }
        logger.warning("%s failed, falling back to %s: %s", stt_model, _STT_OPENAI_FALLBACK_MODEL, e)
        audio_file.seek(0)
        try:
            resp = client.audio.transcriptions.create(
                model=_STT_OPENAI_FALLBACK_MODEL,
                file=audio_file,
                language="pt",
                response_format="verbose_json",
                chunking_strategy="auto",
            )
            transcript = _flatten_diarized_transcript(resp)
            providers["stt"] = {
                "provider": "openai",
                "model": _STT_OPENAI_FALLBACK_MODEL,
                "fallback": True,
                "fallback_from": {"provider": stt_provider, "model": stt_model},
                "primary_error": str(e)[:180],
            }
        except Exception as e2:
            logger.error("Both transcription models failed: %s", e2)
            providers["stt"] = {
                "provider": "none",
                "model": None,
                "fallback": True,
                "fallback_from": {"provider": stt_provider, "model": stt_model},
                "primary_error": str(e)[:180],
                "fallback_error": str(e2)[:180],
            }

    t_transcribe = time.perf_counter() - t_stt
    logger.warning("transcribe_audio: whisper took %.2fs", t_transcribe)
    timing["stt_s"] = _round_seconds(t_transcribe)

    if not transcript or len(transcript.strip()) < 5:
        if spec_pool:
            spec_pool.shutdown(wait=False)
        timing["total_s"] = _elapsed_seconds(t0)
        return {
            "ok": False,
            "error": "Transcrição vazia ou muito curta",
            "providers": providers,
            "timing": timing,
            "audio": audio_info,
        }

    # --- Resolve the speculative CID and decide accept-vs-rerun ---
    spec_cid = {}
    spec_cid_provider = {}
    spec_cid_s = None
    if spec_cid_future is not None:
        try:
            spec_cid, spec_cid_provider, spec_cid_s = _pop_cid_observability(
                spec_cid_future.result(timeout=10) or {}
            )
        except Exception as e:
            logger.warning("speculative CID future failed: %s", e)
        finally:
            spec_pool.shutdown(wait=False)
    spec_confidence = spec_cid.get("confidence", 0) or 0
    spec_accepted = spec_confidence >= _CID_SPECULATIVE_CONFIDENCE_THRESHOLD
    if spec_accepted:
        logger.warning(
            "transcribe_audio: speculative CID accepted (conf=%.2f, %s)",
            spec_confidence, spec_cid.get("cid_code", "?"),
        )
    elif spec_cid:
        logger.warning(
            "transcribe_audio: speculative CID rejected (conf=%.2f), re-running",
            spec_confidence,
        )

    # --- Step 2 & 3: SOAP + CID in parallel (both only need the transcript) ---
    # NOTE (2026-04-24): chief_complaint intentionally NOT prepended here. It
    # used to be, but the model treated "Queixa principal: X" as spoken dictation
    # and leaked it into SUBJETIVO even when the doctor never said it. SOAP must
    # reflect ONLY the spoken transcript. chief_complaint still flows to the CID
    # call below, which is a separate prompt that legitimately uses it.
    user_msg = transcript
    if custom_instructions:
        user_msg += f"\n\nInstruções adicionais do médico: {custom_instructions}"

    def _call_soap():
        soap_t0 = time.perf_counter()
        msgs = [
            {"role": "system", "content": SOAP_TEMPLATE},
            {"role": "user", "content": user_msg},
        ]
        # Try Groq first if configured and available
        if _SOAP_PROVIDER == "groq" and _groq_client:
            try:
                r = _groq_client.chat.completions.create(
                    model=_SOAP_GROQ_MODEL,
                    messages=msgs,
                    temperature=0.1,
                    max_tokens=600,
                )
                return (
                    _postprocess_soap(r.choices[0].message.content or transcript),
                    _soap_provider_meta(stream=False),
                    _elapsed_seconds(soap_t0),
                )
            except Exception as e:
                logger.warning("SOAP Groq failed, falling back to OpenAI: %s", str(e)[:120])
        try:
            r = client.chat.completions.create(
                model=_SOAP_MODEL,
                messages=msgs,
                temperature=0.1,
                max_tokens=600,
            )
            return (
                _postprocess_soap(r.choices[0].message.content or transcript),
                _soap_provider_meta(stream=False, fallback=(_SOAP_PROVIDER == "groq" and _groq_client is not None)),
                _elapsed_seconds(soap_t0),
            )
        except Exception as e:
            logger.warning("SOAP generation error, using raw transcript: %s", e)
            return (
                transcript,
                {
                    "provider": "raw_transcript",
                    "model": None,
                    "fallback": True,
                    "error": str(e)[:180],
                },
                _elapsed_seconds(soap_t0),
            )

    t1 = time.perf_counter()
    if skip_soap:
        # Streaming path: caller will request SOAP via /api/soap-stream after
        # receiving the transcript. Run only CID here (or reuse speculative).
        if spec_accepted:
            cid_data = spec_cid
            cid_provider = spec_cid_provider
            cid_s = spec_cid_s
        else:
            cid_data, cid_provider, cid_s = _pop_cid_observability(
                _run_cid(client, chief_complaint, transcript)
            )
        soap_note = None
        t_parallel = time.perf_counter() - t1
        logger.warning("transcribe_audio: CID-only (skip_soap) took %.2fs", t_parallel)
    else:
        with ThreadPoolExecutor(max_workers=2) as pool:
            soap_future = pool.submit(_call_soap)
            if spec_accepted:
                # Reuse speculative CID — SOAP runs alone in the pool.
                cid_data = spec_cid
                cid_provider = spec_cid_provider
                cid_s = spec_cid_s
                soap_note, soap_provider, soap_s = soap_future.result()
            else:
                cid_future = pool.submit(_run_cid, client, chief_complaint, transcript)
                soap_note, soap_provider, soap_s = soap_future.result()
                cid_data, cid_provider, cid_s = _pop_cid_observability(cid_future.result())
        t_parallel = time.perf_counter() - t1
        logger.warning("transcribe_audio: SOAP+CID parallel took %.2fs", t_parallel)
        providers["soap"] = soap_provider
        timing["soap_s"] = soap_s
    providers["cid"] = cid_provider or {"provider": "none", "model": None, "fallback": False}
    if cid_s is not None:
        timing["cid_s"] = cid_s
    timing["post_stt_s"] = _round_seconds(t_parallel)
    timing["total_s"] = _elapsed_seconds(t0)
    logger.warning("transcribe_audio: TOTAL %.2fs", timing["total_s"])

    # CHRA-1102: build latency observability fields
    result = {
        "ok": True,
        "transcript": transcript,
        "soap": soap_note,
        # v2.7.3: extracted plan body for #recomendas_descricao auto-fill on the
        # extension side. Empty string if no plan section or placeholder body.
        # When skip_soap=True, soap is None — plan extraction returns "".
        "plan": _extract_plan_from_soap(soap_note) if soap_note else "",
        "cid_code": cid_data.get("cid_code"),
        "cid_name": cid_data.get("cid_name"),
        "confidence": cid_data.get("confidence", 0.0),
        "providers": providers,
        "timing": timing,
        "audio": audio_info,
    }

    return result


def suggest_cid(soap_text, chief_complaint="", *, client=None, config=None):
    """Suggest CID-10 code from SOAP text via GPT."""
    t0 = time.perf_counter()
    client = _resolve_client(client=client, config=config)

    result, provider, cid_s = _pop_cid_observability(
        _run_cid(client, chief_complaint, soap_text, content_label="SOAP")
    )
    result["providers"] = {"cid": provider}
    result["timing"] = {
        "cid_s": cid_s if cid_s is not None else _elapsed_seconds(t0),
        "total_s": _elapsed_seconds(t0),
    }
    return result


# ---------------------------------------------------------------------------
# v3.1 idea #8: SOAP voice — verbosity / perspective / emphases / customRules / fewShots
# ---------------------------------------------------------------------------
# Doctors set their personal "voice" (writing style) in the extension popup.
# Built-in voices are Conciso/Padrão/Detalhado; personal voices can override
# every dial including 1-3 few-shot SOAP examples in the doctor's own style —
# the highest-leverage personalization GPT-4o-mini reliably picks up.
#
# When `soap_voice` is None (older extension versions, or user picked default),
# build_soap_messages() falls back to the SOAP_TEMPLATE-only prompt — same
# behavior as today.

VERBOSITY_RULES = {
    "curto": "Cada seção deve ter 1-2 frases. Sem redundância.",
    "medio": "Cada seção deve ter 2-4 frases. Cobertura clínica completa, sem prolixidade.",
    "longo": "Cada seção deve ter 4-6 frases. Inclua contexto e justificativa quando relevante.",
}

PERSPECTIVE_RULES = {
    "1a":         "SUBJETIVO em primeira pessoa do médico (eu observei). Não muda o restante.",
    "3a":         "SUBJETIVO em terceira pessoa (paciente refere, foi observado).",
    "impessoal":  "SUBJETIVO em voz impessoal/passiva (refere, observou-se).",
}

EMPHASIS_RULES = {
    "red-flags":      "Destaque sinais de alarme em AVALIAÇÃO. Em PLANO, mencione critérios de retorno imediato.",
    "sinais-vitais":  "Em OBJETIVO, sempre liste FC, FR, SatO2, T, PA quando disponíveis. Comente alterações.",
    "contexto-social":"Em SUBJETIVO, inclua contexto familiar/escolar/laboral relevante quando mencionado.",
}


def build_soap_messages(raw_text, custom_instructions="", soap_voice=None):
    """Compose the chat-completions messages for SOAP generation.

    Centralizes the prompt assembly so the streaming and non-streaming endpoints
    can share it. When `soap_voice` is None or empty, returns the legacy
    SOAP_TEMPLATE prompt (identical behavior to pre-v3.1).
    """
    voice = soap_voice or {}
    has_voice = bool(voice and (
        voice.get("verbosity") or voice.get("perspective")
        or voice.get("emphases") or voice.get("customRules") or voice.get("fewShots")
    ))

    if not has_voice:
        # Legacy path — keep behavior identical to format_soap()/transcribe_audio()
        # so existing extensions and tests continue to match.
        user_msg = f"Texto:\n{raw_text}"
        if custom_instructions:
            user_msg += f"\n\nInstruções: {custom_instructions}"
        return [
            {"role": "system", "content": SOAP_TEMPLATE},
            {"role": "user", "content": user_msg},
        ]

    verbosity   = voice.get("verbosity") or "medio"
    perspective = voice.get("perspective") or "impessoal"
    emphases    = voice.get("emphases") or []
    custom      = (voice.get("customRules") or "").strip()
    few_shots   = (voice.get("fewShots") or [])[:3]

    parts = [SOAP_TEMPLATE.strip()]
    parts.append(VERBOSITY_RULES.get(verbosity, VERBOSITY_RULES["medio"]))
    parts.append(PERSPECTIVE_RULES.get(perspective, PERSPECTIVE_RULES["impessoal"]))
    for e in emphases:
        rule = EMPHASIS_RULES.get(e)
        if rule:
            parts.append(rule)
    if custom:
        parts.append(f"Regras pessoais do médico (devem ser respeitadas): {custom}")
    if custom_instructions:
        parts.append(f"Instruções adicionais: {custom_instructions}")

    msgs = [{"role": "system", "content": "\n\n".join(parts)}]

    # Few-shots — strongest personalization signal. Each pair tells GPT
    # "input like X → output in MY style like Y".
    for ex in few_shots:
        complaint = (ex.get("complaint") or "").strip()
        output    = (ex.get("output") or "").strip()
        if not complaint or not output:
            continue
        msgs.append({"role": "user",      "content": f"Texto:\n{complaint}"})
        msgs.append({"role": "assistant", "content": output})

    msgs.append({"role": "user", "content": f"Texto:\n{raw_text}"})
    return msgs


def format_soap_stream(raw_text, *, client=None, config=None, custom_instructions="", soap_voice=None):
    """Generator that yields SOAP tokens as they arrive from GPT.

    Yields plain strings (delta content). Caller wraps in SSE framing. Returns
    immediately if the SDK call fails — caller handles error framing.
    """
    client = _resolve_client(client=client, config=config)
    msgs = build_soap_messages(
        raw_text=raw_text,
        custom_instructions=custom_instructions,
        soap_voice=soap_voice,
    )
    soap_client = _groq_client if (_SOAP_PROVIDER == "groq" and _groq_client) else client
    soap_model = _SOAP_GROQ_MODEL if (_SOAP_PROVIDER == "groq" and _groq_client) else _SOAP_MODEL
    stream = soap_client.chat.completions.create(
        model=soap_model,
        messages=msgs,
        temperature=0.1,
        max_tokens=1200,
        stream=True,
    )
    for chunk in stream:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta.content or ""
        if delta:
            yield delta


def format_soap(
    raw_text,
    chief_complaint="",
    *,
    client=None,
    config=None,
    custom_instructions="",
    soap_voice=None,
):
    """Format raw text as a SOAP note via GPT.

    2026-05-25: aligned with the streaming path so the SSE-fallback flow
    (sidepanel hits /api/format-soap when /api/soap-stream errors) produces
    the same plain-text SOAP shape that streaming does. Previously this
    endpoint used FORMAT_SYSTEM_PROMPT which asked the model to "Responda
    APENAS em JSON com formatted_soap" — the model emitted a JSON-shaped
    string that was then wrapped in another {formatted_soap: ...} layer
    server-side. Sidepanel pasted the literal JSON string into the
    G-Hosp wysihtml5 editor.

    Now uses build_soap_messages (same prompt as streaming → SOAP_TEMPLATE)
    AND _postprocess_soap (placeholder substitution + voice + footer) so
    both endpoints return identically-shaped notes. The
    chief_complaint parameter is preserved in the signature for backward
    compatibility but, like the streaming path, is intentionally NOT
    prepended (queixa-from-triage leak prevention — 2026-04-24 note).
    """
    t0 = time.perf_counter()
    client = _resolve_client(client=client, config=config)

    msgs = build_soap_messages(
        raw_text=raw_text,
        custom_instructions=custom_instructions,
        soap_voice=soap_voice,
    )

    soap_client = _groq_client if (_SOAP_PROVIDER == "groq" and _groq_client) else client
    soap_model = _SOAP_GROQ_MODEL if (_SOAP_PROVIDER == "groq" and _groq_client) else _SOAP_MODEL
    try:
        response = soap_client.chat.completions.create(
            model=soap_model,
            messages=msgs,
            # Mirror the streaming path's settings: temp 0.1 + 1200 tokens.
            # Pre-2026-05-25 used 0.3 + 600 which truncated long SOAPs.
            temperature=0.1,
            max_tokens=1200,
        )
        raw_soap = response.choices[0].message.content or ""
        # Apply the same post-processing as the streaming + transcribe paths:
        # substitutes [OBJETIVO_PLACEHOLDER], normalizes voice perspective,
        # appends the canonical PLAN_FOOTER_TEXT.
        processed = _postprocess_soap(raw_soap)
        elapsed = _elapsed_seconds(t0)
        return {
            "formatted_soap": processed,
            "providers": {"soap": _soap_provider_meta(stream=False)},
            "timing": {"soap_total_s": elapsed, "total_s": elapsed},
        }
    except Exception as e:
        logger.error("Format SOAP error: %s", e)
        elapsed = _elapsed_seconds(t0)
        return {
            "error": str(e),
            "providers": {"soap": _soap_provider_meta(stream=False, fallback=True, error=str(e))},
            "timing": {"soap_total_s": elapsed, "total_s": elapsed},
        }


# ---------------------------------------------------------------------------
# Atestado letter-mode (pediatric guidance letter)
# ---------------------------------------------------------------------------
# Drafts a Brazilian-Portuguese pediatric guidance letter (atestado em formato
# de carta) given patient context + the doctor's intent. The LLM amplifies the
# doctor's intent into formal prose — it MUST NOT add new clinical claims.
#
# Same Rule 3 spirit as SOAP_TEMPLATE: PROIBIDO inventar diagnósticos,
# medicamentos, durações, doses ou quaisquer dados clínicos não fornecidos.
# This explicitly extends the Queixa-leak lesson (2026-04-24): the doctor's
# intent IS the source of truth for output, but the model must never expand
# beyond what was provided.
ATESTADO_LETTER_SYSTEM_PROMPT = """\
Você é um pediatra brasileiro experiente redigindo uma carta de orientação aos pais ou responsáveis. Transforme a intenção do médico em prosa formal em português brasileiro, no formato de carta-orientação pediátrica.

REGRAS:
1) Saída APENAS o corpo da carta — sem preâmbulos, sem aspas, sem cabeçalhos extras, sem assinatura no final.
2) Saudação: use "Prezada Sra.," quando o contexto sugerir mãe/responsável feminino; caso contrário use "Prezado(a),".
3) Estrutura obrigatória:
   - Saudação (uma linha).
   - Parágrafo de contexto clínico: nome do paciente, idade e diagnóstico/quadro, baseado APENAS nos dados fornecidos.
   - Parágrafo(s) de orientação: transforme a intenção do médico em prosa formal, mantendo o sentido EXATO da orientação.
   - Encerramento cortês curto.
4) PROIBIDO inventar diagnósticos, medicamentos, durações, doses, exames, faixas etárias específicas ou quaisquer dados clínicos que NÃO estejam explicitamente no input. Você AMPLIFICA a intenção do médico em prosa formal — nunca adiciona novas alegações clínicas.
5) Se o input não tiver nome, idade ou diagnóstico, omita esses elementos do parágrafo de contexto sem inventar substitutos. Não escreva "[nome não informado]" ou similares — apenas omita.
6) Registro: português brasileiro formal, terceira pessoa, claro e respeitoso. Sem jargão técnico desnecessário.
7) Não use markdown, listas com bullets, negritos ou itálicos. Apenas parágrafos em prosa contínua separados por linha em branco.
"""

ATESTADO_LETTER_FEWSHOT_INPUT = """\
Nome do paciente: Ravi Miguel de Campos Queiroz
Idade do paciente: 5 meses
Diagnóstico/quadro: gastroenterite, com vômitos e redução da aceitação alimentar
Intenção do médico: Orientar a mãe a NÃO oferecer mel, carnes, churrasco ou alimentos inadequados para a idade. Reforçar que mel é proibido para menores de 1 ano e que alimentos sólidos como carne devem ser introduzidos gradualmente conforme orientação pediátrica, geralmente a partir dos 6 meses de idade."""

ATESTADO_LETTER_FEWSHOT_OUTPUT = """\
Prezada Sra.,

O bebê Ravi Miguel de Campos Queiroz, de 5 meses de idade, está em acompanhamento médico por quadro de gastroenterite, com vômitos e redução da aceitação alimentar.

Oriento que não sejam oferecidos ao bebê mel, carnes, churrasco ou quaisquer outros alimentos inadequados para a idade. Nesta fase, a alimentação deve seguir apenas o que foi orientado pela mãe e pela equipe de saúde.

O mel não deve ser oferecido a crianças menores de 1 ano. Além disso, alimentos como carne e outros alimentos sólidos devem ser introduzidos gradualmente, conforme orientação pediátrica, geralmente a partir dos 6 meses de idade, e não como mencionados."""


def _build_atestado_letter_user_msg(patient_name, patient_age, diagnosis_text, doctor_intent):
    """Compose the user message for the atestado letter prompt.

    Empty fields are still listed (with empty value) so the model can clearly
    see what is and isn't provided. Rule 5 in the system prompt instructs the
    model to omit missing elements from the output rather than fabricate.
    """
    return (
        f"Nome do paciente: {(patient_name or '').strip()}\n"
        f"Idade do paciente: {(patient_age or '').strip()}\n"
        f"Diagnóstico/quadro: {(diagnosis_text or '').strip()}\n"
        f"Intenção do médico: {(doctor_intent or '').strip()}"
    )


def format_atestado_letter(
    patient_name,
    patient_age,
    diagnosis_text,
    doctor_intent,
    *,
    client=None,
    config=None,
):
    """Draft a pediatric guidance letter (atestado em formato de carta) via GPT.

    Returns {"letter": "..."} on success, {"error": "..."} on failure.

    Inputs:
      patient_name    — patient full name (may be empty)
      patient_age     — age string, e.g. "5 meses" / "3 anos" (may be empty)
      diagnosis_text  — clinical context / hypothesis (may be empty)
      doctor_intent   — what the doctor wants to convey (REQUIRED, non-empty)

    The LLM amplifies doctor_intent into formal prose. PROIBIDO inventar
    quaisquer dados clínicos não fornecidos — same Rule 3 spirit as SOAP_TEMPLATE.
    """
    t0 = time.perf_counter()
    intent = (doctor_intent or "").strip()
    if not intent:
        return {"error": "doctor_intent é obrigatório"}

    client = _resolve_client(client=client, config=config)
    user_msg = _build_atestado_letter_user_msg(
        patient_name, patient_age, diagnosis_text, doctor_intent,
    )

    try:
        response = client.chat.completions.create(
            model=_SOAP_MODEL,
            messages=[
                {"role": "system",    "content": ATESTADO_LETTER_SYSTEM_PROMPT},
                {"role": "user",      "content": ATESTADO_LETTER_FEWSHOT_INPUT},
                {"role": "assistant", "content": ATESTADO_LETTER_FEWSHOT_OUTPUT},
                {"role": "user",      "content": user_msg},
            ],
            temperature=0.3,
            max_tokens=600,
        )
        letter = (response.choices[0].message.content or "").strip()
        if not letter:
            elapsed = _elapsed_seconds(t0)
            return {
                "error": "Resposta vazia do modelo",
                "providers": {"atestado_letter": _soap_provider_meta(stream=False, fallback=True, error="empty response")},
                "timing": {"model_total_s": elapsed, "total_s": elapsed},
            }
        elapsed = _elapsed_seconds(t0)
        return {
            "letter": letter,
            "providers": {"atestado_letter": _soap_provider_meta(stream=False)},
            "timing": {"model_total_s": elapsed, "total_s": elapsed},
        }
    except Exception as e:
        logger.error("Atestado letter error: %s", e)
        elapsed = _elapsed_seconds(t0)
        return {
            "error": str(e),
            "providers": {"atestado_letter": _soap_provider_meta(stream=False, fallback=True, error=str(e))},
            "timing": {"model_total_s": elapsed, "total_s": elapsed},
        }
