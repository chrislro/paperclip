# ASR, SOAP, CID, And Audio Observability

Updated: 2026-05-15

This document records the production provider choices, fallback behavior, audio
capture settings, and verification gates for the Toca Ficha Dr. transcription
and note-generation path.

## Current Provider Matrix

| Stage | Primary | Fallback | Config |
|---|---|---|---|
| STT | Groq `whisper-large-v3` when `GROQ_API_KEY` is present | OpenAI `gpt-4o-transcribe` if primary STT fails | `STT_GROQ_MODEL`, `STT_OPENAI_FALLBACK_MODEL` |
| STT without Groq | OpenAI `whisper-1` | OpenAI `gpt-4o-transcribe` on failure | `STT_OPENAI_MODEL` |
| CID | Groq `llama-3.3-70b-versatile` when Groq is present and `CID_PROVIDER` is not `openai` | OpenAI `gpt-4o-mini` | `CID_GROQ_MODEL`, `CID_OPENAI_MODEL`, `CID_PROVIDER` |
| SOAP | OpenAI `gpt-4o-mini` | raw transcript if non-streaming SOAP generation fails | `SOAP_MODEL` |
| SOAP stream | OpenAI `gpt-4o-mini` streaming chat completion | client receives `SOAP_ERROR`; side panel can fall back to full SOAP endpoint | `SOAP_MODEL` |
| Atestado letter | OpenAI `gpt-4o-mini` | error response with provider/timing metadata | `SOAP_MODEL` |

Runtime truth should be taken from response metadata and logs, not comments.
Before this change, recent production logs showed Groq STT handling requests:
`STT provider on boot: Groq whisper-large-v3` and no observed OpenAI fallback
lines in the sampled log window.

## Provider Response Metadata

Backend responses now include observability fields alongside the existing
clinical payload:

```json
{
  "providers": {
    "stt": {"provider": "groq", "model": "whisper-large-v3", "fallback": false},
    "cid": {"provider": "groq", "model": "llama-3.3-70b-versatile", "fallback": false},
    "soap": {"provider": "openai", "model": "gpt-4o-mini", "stream": true, "fallback": false}
  },
  "timing": {
    "stt_s": 1.234,
    "cid_s": 0.456,
    "soap_first_token_s": 0.789,
    "soap_total_s": 2.345,
    "total_s": 3.456
  }
}
```

The exact keys depend on the endpoint:

- `/api/transcribe`: STT, CID, optional deferred SOAP metadata, total timing,
  and sanitized audio metadata.
- `/api/soap-stream`: streaming SOAP provider, first-token timing, total timing,
  token chunk count, and error metadata when the stream fails.
- `/api/suggest-cid`, `/api/format-soap`, and `/api/format-atestado-letter`:
  provider and timing fields for their model calls.

## Audit Logging

The dashboard writes provider and timing telemetry to the existing audit logger
with these action types:

- `transcribe_observability`
- `suggest_cid_observability`
- `format_soap_observability`
- `soap_stream_observability`
- `atestado_observability`

These audit records intentionally exclude PHI-bearing fields. Do not add raw
transcripts, generated SOAP, patient names, CPF, chart IDs, or audio blobs to
these audit details.

## Audio Capture Configuration

Audio is captured in `content/audio-capture.js` through browser
`MediaRecorder`:

| Setting | Value |
|---|---|
| Microphone request | `navigator.mediaDevices.getUserMedia({ audio: true })` |
| MIME preference | `audio/webm;codecs=opus`, then `audio/webm`, then `audio/mp4` |
| Requested bitrate | `32000` bps |
| Chunk interval | `1000` ms |
| Minimum blob size | `500` bytes |
| VAD FFT size | `1024` |
| VAD smoothing | `0.2` |
| VAD poll interval | `50` ms |

The extension now records the actual browser-negotiated values for each
recording:

- `mimeType`
- `audioBitsPerSecond`
- `requestedBitsPerSecond`
- track settings: `sampleRate`, `sampleSize`, `channelCount`, `latency`,
  `echoCancellation`, `noiseSuppression`, `autoGainControl`

Device identifiers are stripped before reaching backend logs or audit records.
The sanitizer must continue to reject `deviceId`, `groupId`, labels, and any
other hardware identifier fields.

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `GROQ_API_KEY` | unset | Enables Groq STT and CID client |
| `GROQ_TIMEOUT_SECONDS` | `20` | Groq OpenAI-compatible client timeout |
| `GROQ_MAX_RETRIES` | `0` | Groq OpenAI-compatible client retry count |
| `STT_GROQ_MODEL` | `whisper-large-v3` | Groq STT model |
| `STT_OPENAI_MODEL` | `whisper-1` | OpenAI STT model when Groq is unavailable |
| `STT_OPENAI_FALLBACK_MODEL` | `gpt-4o-transcribe` | Fallback model after STT failure |
| `CID_GROQ_MODEL` | `llama-3.3-70b-versatile` | Groq CID model |
| `CID_OPENAI_MODEL` | `gpt-4o-mini` | OpenAI CID fallback model |
| `CID_PROVIDER` | unset | Set to `openai` to force OpenAI CID |
| `SOAP_MODEL` | `gpt-4o-mini` | SOAP and atestado generation model |

Changing provider, model, prompt, or audio-processing behavior requires an eval
or a documented production-risk acceptance.

## SOAP/CID Eval Gate

Use de-identified JSONL cases only. Minimum case shape:

```json
{"id":"case-001","raw_transcript":"Paciente refere febre...","chief_complaint":"febre","expected_cid_candidates":["R50"],"forbidden_claims":["dispneia"],"required_soap_phrases":["febre"]}
```

Validate a case file without calling providers:

```bash
python backend/scripts/eval_soap_cid.py path/to/cases.jsonl --check-only
```

Run the live eval with configured OpenAI credentials:

```bash
python backend/scripts/eval_soap_cid.py path/to/cases.jsonl
```

Hold deployment on any new score `0` unless the owner explicitly accepts the
regression. Never send live PHI through a new provider without explicit approval.

## Verification Notes

The 2026-05-15 implementation pass was checked with:

```bash
venv/bin/python -m py_compile \
  backend/emr_automation/extension_api.py \
  backend/emr_automation/dashboard/routes.py \
  backend/scripts/eval_soap_cid.py

PYTHONPATH=backend ALLOW_MISSING_OPENAI=1 SECRET_KEY=test-secret \
  venv/bin/pytest backend/tests -q

npm run build
node scripts/verify-package.js --root .
```

`npm run test:static` also covers prescription selector tripwires. If that
suite fails, fix or document the prescription selector issue before claiming a
fully green extension gate.
