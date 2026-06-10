import pytest
from unittest.mock import MagicMock, patch
from emr_automation.extension_api import (
    transcribe_audio,
    suggest_cid,
    format_soap,
    format_atestado_letter,
    _STT_OPENAI_FALLBACK_ENABLED,
    _soap_provider_meta,
    _SOAP_PROVIDER,
    _SOAP_MODEL,
    _SOAP_GROQ_MODEL,
    _groq_client,
)


class TestTranscribeAudio:
    def test_transcribe_returns_soap_and_cid(self):
        client = MagicMock()
        client.audio.transcriptions.create.return_value = MagicMock(
            text="Paciente com febre há 2 dias, tosse seca, coriza."
        )
        client.chat.completions.create.return_value = MagicMock(
            choices=[MagicMock(message=MagicMock(
                content='{"soap": "S: Febre há 2 dias...", "cid_code": "J06.9", "cid_name": "IVAS", "confidence": 0.9}'
            ))]
        )

        with patch("emr_automation.extension_api._groq_client", None):
            result = transcribe_audio(
                audio_bytes=b"fake-audio-data-padding-to-be-long-enough",
                mime_type="audio/webm",
                chief_complaint="febre",
                client=client,
            )

        assert result["ok"] is True
        assert "soap" in result
        # Speculative CID lookup for "febre" returns R50 deterministically.
        assert result["cid_code"] == "R50"
        assert result["confidence"] > 0
        assert result["providers"]["stt"]["provider"] == "openai"
        assert result["providers"]["stt"]["model"] == "whisper-1"
        assert result["providers"]["cid"]["provider"] == "local_lookup"
        assert result["providers"]["soap"]["provider"] == "openai"
        assert result["timing"]["stt_s"] >= 0
        assert result["audio"]["mime_type"] == "audio/webm"

    def test_transcribe_returns_raw_transcript_on_gpt_failure(self):
        client = MagicMock()
        client.audio.transcriptions.create.return_value = MagicMock(
            text="Paciente com dor abdominal intensa"
        )
        client.chat.completions.create.side_effect = Exception("GPT error")

        with patch("emr_automation.extension_api._groq_client", None):
            result = transcribe_audio(
                audio_bytes=b"fake-audio-data-padding",
                mime_type="audio/webm",
                chief_complaint="dor abdominal",
                client=client,
            )

        assert result["ok"] is True
        assert result["soap"] == "Paciente com dor abdominal intensa"
        # Speculative CID lookup for "dor abdominal" returns R10 deterministically,
        # even when the GPT call fails — the lookup runs before transcription completes.
        assert result.get("cid_code") == "R10"
        assert result["providers"]["soap"]["provider"] == "raw_transcript"
        assert result["providers"]["soap"]["fallback"] is True

    def test_transcribe_returns_503_when_groq_fails_and_fallback_disabled(self):
        """When Groq STT errors and STT_OPENAI_FALLBACK_ENABLED=false, return 503
        with provider metadata indicating Groq failed. Do not call Whisper-1."""
        mock_groq = MagicMock()
        mock_groq.audio.transcriptions.create.side_effect = Exception("Groq timeout")
        client = MagicMock()

        with patch("emr_automation.extension_api._groq_client", mock_groq), \
             patch("emr_automation.extension_api._STT_OPENAI_FALLBACK_ENABLED", False):
            result = transcribe_audio(
                audio_bytes=b"fake-audio-data-padding-to-be-long-enough",
                mime_type="audio/webm",
                chief_complaint="febre",
                client=client,
            )

        assert result["ok"] is False
        assert result["status_code"] == 503
        assert "fallback is disabled" in result["error"]
        assert result["providers"]["stt"]["provider"] == "groq"
        assert result["providers"]["stt"]["fallback"] is False
        assert "Groq timeout" in result["providers"]["stt"]["error"]
        # OpenAI fallback must NOT have been called.
        client.audio.transcriptions.create.assert_not_called()


class TestSuggestCid:
    def test_suggest_cid_returns_code(self):
        client = MagicMock()
        client.chat.completions.create.return_value = MagicMock(
            choices=[MagicMock(message=MagicMock(
                content='{"cid_code": "A09", "cid_name": "Diarreia e gastroenterite", "confidence": 0.85}'
            ))]
        )

        with patch("emr_automation.extension_api._groq_client", None):
            result = suggest_cid(
                soap_text="S: Diarreia há 3 dias...",
                chief_complaint="diarreia",
                client=client,
            )

        assert result["cid_code"] == "A09"
        assert result["confidence"] == 0.85
        assert result["providers"]["cid"]["provider"] == "openai"
        assert result["timing"]["cid_s"] >= 0


class TestFormatSoap:
    def test_format_soap_returns_formatted(self):
        client = MagicMock()
        client.chat.completions.create.return_value = MagicMock(
            choices=[MagicMock(message=MagicMock(
                content='{"formatted_soap": "S: Febre...\\nO: BEG...\\nA: IVAS\\nP: Sintomáticos"}'
            ))]
        )

        result = format_soap(
            raw_text="febre 2 dias tosse coriza",
            chief_complaint="febre",
            client=client,
        )

        assert "formatted_soap" in result
        assert result["providers"]["soap"]["provider"] == "openai"
        assert result["timing"]["soap_total_s"] >= 0


class TestFormatAtestadoLetter:
    def test_letter_prompt_structure_and_anti_hallucination(self):
        """Sends the right prompt: system carries 'PROIBIDO' guard and the user
        message includes the patient context (name, age, diagnosis, intent)."""
        client = MagicMock()
        client.chat.completions.create.return_value = MagicMock(
            choices=[MagicMock(message=MagicMock(
                content="Prezada Sra.,\n\nO bebê João, de 6 meses, está em acompanhamento por bronquiolite.\n\nOriento repouso e hidratação.\n\nAtenciosamente."
            ))]
        )

        result = format_atestado_letter(
            patient_name="João da Silva",
            patient_age="6 meses",
            diagnosis_text="bronquiolite",
            doctor_intent="Orientar repouso e hidratação. Retorno em 48h se piora.",
            client=client,
        )

        assert "letter" in result
        assert result["letter"].startswith("Prezada Sra.,")

        # Inspect what was actually sent to GPT.
        client.chat.completions.create.assert_called_once()
        call_kwargs = client.chat.completions.create.call_args.kwargs
        assert call_kwargs["model"] == "gpt-4o-mini"
        assert call_kwargs["temperature"] == 0.3
        assert call_kwargs["max_tokens"] == 600

        messages = call_kwargs["messages"]
        # System prompt must explicitly forbid hallucination (Queixa-leak lesson).
        system_msg = messages[0]
        assert system_msg["role"] == "system"
        assert "PROIBIDO" in system_msg["content"]

        # Last user message must carry the patient context.
        final_user_msg = messages[-1]
        assert final_user_msg["role"] == "user"
        assert "João da Silva" in final_user_msg["content"]
        assert "6 meses" in final_user_msg["content"]
        assert "bronquiolite" in final_user_msg["content"]
        assert "repouso e hidratação" in final_user_msg["content"]

        # One-shot exemplar is present (user-then-assistant pair before the live user msg).
        assert messages[1]["role"] == "user"
        assert messages[2]["role"] == "assistant"
        assert "Ravi Miguel" in messages[2]["content"]

    def test_empty_doctor_intent_returns_error_without_calling_openai(self):
        """Graceful fallback: empty doctor_intent must not hit OpenAI and must
        return a structured error rather than raising."""
        client = MagicMock()

        result = format_atestado_letter(
            patient_name="Maria",
            patient_age="2 anos",
            diagnosis_text="resfriado comum",
            doctor_intent="   ",  # whitespace-only counts as empty
            client=client,
        )

        assert "error" in result
        assert "letter" not in result
        client.chat.completions.create.assert_not_called()


class TestSoapPostprocessReplacementSafety:
    """CHRA-2423 Bug 36: _normalize_subjective_voice built a re.sub REPLACEMENT
    STRING from model-generated SOAP text. re.sub interprets backslash escapes
    and group refs in a replacement string, so a literal backslash in the note
    either silently corrupted the chart (\\<digit> = group reference) or raised
    re.error('bad escape') (\\<letter>) → the SOAP request 500'd. The fix uses a
    callable replacement (verbatim), mirroring _normalize_plano_voice."""

    def test_backslash_digit_in_subjective_is_preserved_not_group_ref(self):
        from emr_automation.extension_api import _postprocess_soap
        note = (
            "SUBJETIVO:\nEstou com dor de cabeça há \\2 dias.\n\n"
            "[OBJETIVO_PLACEHOLDER]\n\nAVALIAÇÃO:\n1. Cefaleia\n\nPLANO:\nOriento repouso."
        )
        out = _postprocess_soap(note)
        assert "\\2 dias" in out                  # backslash-digit preserved verbatim
        assert "Paciente relata dor de cabeça" in out  # first-person rewrite still applied
        assert "Estou com" not in out             # no group-ref duplication of the body

    def test_backslash_letter_in_subjective_does_not_raise(self):
        from emr_automation.extension_api import _postprocess_soap
        note = (
            "SUBJETIVO:\nEstou com febre \\d e tosse seca.\n\n"
            "[OBJETIVO_PLACEHOLDER]\n\nAVALIAÇÃO:\n1. Gripe\n\nPLANO:\nOriento hidratação."
        )
        # Pre-fix this raised re.error('bad escape \\d'); must now return cleanly.
        out = _postprocess_soap(note)
        assert "\\d e tosse" in out
        assert "Paciente relata febre" in out


class TestSoapProviderSwitch:
    """Exercises the SOAP_PROVIDER env switch via monkeypatch of module globals."""

    def test_soap_provider_meta_defaults_to_openai(self):
        meta = _soap_provider_meta(stream=False)
        assert meta["provider"] == "openai"
        assert meta["model"] == _SOAP_MODEL
        assert meta["stream"] is False
        assert meta["fallback"] is False

    def test_soap_provider_meta_uses_groq_when_configured(self):
        mock_groq = MagicMock()
        with patch("emr_automation.extension_api._SOAP_PROVIDER", "groq"), \
             patch("emr_automation.extension_api._groq_client", mock_groq):
            meta = _soap_provider_meta(stream=False)
            assert meta["provider"] == "groq"
            assert meta["model"] == _SOAP_GROQ_MODEL

    def test_soap_provider_meta_falls_back_to_openai_on_groq_error(self):
        mock_groq = MagicMock()
        with patch("emr_automation.extension_api._SOAP_PROVIDER", "groq"), \
             patch("emr_automation.extension_api._groq_client", mock_groq):
            meta = _soap_provider_meta(stream=False, fallback=True, error="timeout")
            assert meta["provider"] == "openai"
            assert meta["model"] == _SOAP_MODEL
            assert meta["fallback"] is True
            assert meta["error"] == "timeout"

    def test_soap_provider_meta_ignores_groq_when_client_unavailable(self):
        """If GROQ_API_KEY is not set, _groq_client is None — stay on OpenAI."""
        with patch("emr_automation.extension_api._SOAP_PROVIDER", "groq"), \
             patch("emr_automation.extension_api._groq_client", None):
            meta = _soap_provider_meta(stream=False)
            assert meta["provider"] == "openai"
            assert meta["model"] == _SOAP_MODEL
