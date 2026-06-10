"""
Flask backend integration suite — Phase 3 API-layer tests.

These tests verify the backend API endpoints used by the extension.
They run against a local test database and do not require production
credentials or external services.

Run with:
    make test-backend
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch, call

import pytest

from emr_automation.extension_api import transcribe_audio, suggest_cid, format_soap


def _mock_chat_create(cid_json, soap_text):
    """Return a side_effect function that distinguishes CID vs SOAP calls.

    CID calls pass response_format={"type": "json_object"}; SOAP calls do not.
    """
    def _side_effect(*args, **kwargs):
        if kwargs.get("response_format") == {"type": "json_object"}:
            return MagicMock(choices=[MagicMock(message=MagicMock(content=json.dumps(cid_json)))])
        return MagicMock(choices=[MagicMock(message=MagicMock(content=soap_text))])
    return _side_effect


@pytest.mark.backend
class TestTranscribeAudio:
    """Integration tests for the transcribe_audio endpoint."""

    def test_transcribe_returns_soap_and_cid(self):
        """Audio transcription returns structured SOAP + CID data."""
        client = MagicMock()
        client.audio.transcriptions.create.return_value = MagicMock(
            text="Paciente com artralgia há 2 dias, sem febre."
        )
        client.chat.completions.create.side_effect = _mock_chat_create(
            cid_json={"cid_code": "M79.3", "cid_name": "Paniculite", "confidence": 0.85},
            soap_text="SUBJETIVO: Artralgia há 2 dias.\nOBJETIVO: Sem febre.\nAVALIAÇÃO: Artralgia.\nPLANO: Analgésico.",
        )

        # Patch the module-level Groq client so the injected mock is used for STT
        # and CID (both paths use _groq_client when it is set).
        with patch("emr_automation.extension_api._groq_client", None):
            result = transcribe_audio(
                audio_bytes=b"fake-audio-data-padding-to-be-long-enough",
                mime_type="audio/webm",
                # Use a chief_complaint that is NOT in the hardcoded _CID_LOOKUP
                # so the mock's CID response is actually used.
                chief_complaint="artralgia",
                client=client,
            )

        assert result["ok"] is True
        assert result["cid_code"] == "M79.3"
        assert result["confidence"] == 0.85

    def test_transcribe_fallback_on_gpt_failure(self):
        """When GPT fails for SOAP, the raw transcript is returned as soap."""
        client = MagicMock()
        client.audio.transcriptions.create.return_value = MagicMock(
            text="Paciente com dor abdominal intensa"
        )
        # All chat.completions calls throw — SOAP falls back to raw transcript.
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


@pytest.mark.backend
class TestSuggestCID:
    """Integration tests for the suggest_cid endpoint."""

    def test_suggest_cid_returns_code_and_name(self):
        """CID suggestion returns a valid code and name."""
        client = MagicMock()
        client.chat.completions.create.return_value = MagicMock(
            choices=[MagicMock(message=MagicMock(
                content='{"cid_code": "J06.9", "cid_name": "IVAS", "confidence": 0.85}'
            ))]
        )

        # Patch the module-level Groq client so the injected mock handles CID.
        with patch("emr_automation.extension_api._groq_client", None):
            result = suggest_cid(
                soap_text="Paciente com febre e tosse",
                client=client,
            )

        # suggest_cid does not return an "ok" key — it returns the CID fields directly.
        assert result["cid_code"] == "J06.9"
        assert result["cid_name"] == "IVAS"
        assert result["confidence"] == pytest.approx(0.85)


@pytest.mark.backend
class TestFormatSOAP:
    """Integration tests for the format_soap endpoint."""

    def test_format_soap_returns_structured_note(self):
        """SOAP formatting returns a formatted note under the 'formatted_soap' key."""
        client = MagicMock()
        soap_content = (
            "SUBJETIVO: Febre há 2 dias\n"
            "OBJETIVO: T: 38.5°C\n"
            "AVALIAÇÃO: IVAS\n"
            "PLANO: Antitérmico, repouso"
        )
        client.chat.completions.create.return_value = MagicMock(
            choices=[MagicMock(message=MagicMock(content=soap_content))]
        )

        # format_soap uses _resolve_client which returns the passed client when
        # it is not None, so _groq_client patching is not required here.
        result = format_soap(
            raw_text="Paciente com febre há 2 dias",
            client=client,
        )

        # format_soap returns 'formatted_soap', not 'soap', and has no 'ok' key.
        assert "formatted_soap" in result
        assert result["formatted_soap"]  # non-empty
