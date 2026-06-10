"""
Audio-to-note functionality for EMR Automation.
"""

from __future__ import annotations

import importlib
import subprocess
import sys
from typing import TYPE_CHECKING, List, Optional

from emr_automation.constants import Locators, PlaywrightLocators, SOAP_FORM_SELECTOR
from emr_automation.utils import switch_to_iframe, switch_to_iframe_playwright

if TYPE_CHECKING:
    from emr_automation.core import EMRAutomation


class AudioMixin:
    """
    Mixin class providing audio-to-note functionality.

    This is designed to be mixed into EMRAutomation class.
    Provides methods for launching the audio transcription script
    and managing its dependencies.
    """

    def run_audio_to_note_script(self: "EMRAutomation") -> bool:
        """
        Launch the external audio-to-note automation script.

        This runs the audio_to_note.py script which handles:
        - Audio recording from microphone
        - Transcription via OpenAI Whisper
        - SOAP note generation

        Returns:
            True if the script exits with status 0, False otherwise
        """
        if not self.audio_to_note_script:
            self.logger.error("Audio-to-note script path is not configured or could not be resolved.")
            self.last_audio_error = "Script de áudio não configurado. Verifique o arquivo config.ini."
            return False

        if not self._verify_audio_script_dependencies():
            self.logger.error("Missing dependencies for audio-to-note script. Aborting launch.")
            return False

        command = [sys.executable, str(self.audio_to_note_script)]
        self.logger.info("Launching audio-to-note automation: %s", command)

        try:
            process = subprocess.Popen(
                command,
                cwd=str(self.audio_to_note_script.parent),
                start_new_session=True
            )
        except Exception as exc:
            self.logger.error("Failed to launch audio-to-note script: %s", exc)
            return False

        self.logger.info("audio_to_note.py started with PID %s", process.pid)
        self.logger.info("Use o Terminal para controlar a gravação (digite '1' para iniciar quando solicitado).")

        return_code = process.wait()
        if return_code == 0:
            self.logger.info("audio_to_note.py completed successfully.")
            return True

        self.last_audio_error = (
            f"audio_to_note.py terminou com erro (status {return_code}). Consulte os logs."
        )
        self.logger.error("audio_to_note.py exited with non-zero status: %s", return_code)
        return False

    def fill_soap_note_to_emr(self: "EMRAutomation", soap_text: str) -> bool:
        """
        Append a generated SOAP note into the consultation editor inside the EMR form.

        Returns:
            True when the note was appended successfully, False otherwise.
        """
        note = (soap_text or "").strip()
        if not note:
            self.logger.warning("SOAP fill skipped: empty note.")
            self.last_audio_error = "Nota SOAP vazia."
            return False

        if not getattr(self, "driver", None):
            self.logger.error("SOAP fill failed: driver not available.")
            self.last_audio_error = "EMR não conectado."
            return False

        timeout = min(10, int(self.config["Browser"]["timeout"]))

        append_script = """
            (noteText) => {
                const body = document.body;
                if (!body) return false;
                const base = (body.innerText || '').trim();
                body.focus();
                body.innerText = base ? `${base}\\n${noteText}` : noteText;
                ['input', 'change', 'keyup', 'blur'].forEach((evt) => {
                    body.dispatchEvent(new Event(evt, { bubbles: true }));
                });
                return (body.innerText || '').includes(noteText);
            }
        """

        selenium_append_script = """
            const noteText = arguments[0];
            const body = document.body;
            if (!body) return false;
            const base = (body.innerText || '').trim();
            body.focus();
            body.innerText = base ? `${base}\\n${noteText}` : noteText;
            ['input', 'change', 'keyup', 'blur'].forEach((evt) => {
                body.dispatchEvent(new Event(evt, { bubbles: true }));
            });
            return (body.innerText || '').includes(noteText);
        """

        try:
            self.last_audio_error = None

            if self._backend == "playwright":
                self.driver.locator(SOAP_FORM_SELECTOR).first.wait_for(
                    state="attached", timeout=timeout * 1000
                )
                with switch_to_iframe_playwright(
                    self.driver, PlaywrightLocators.CONSULTATION_IFRAME, timeout
                ) as frame:
                    ok = bool(frame.locator("body").evaluate(append_script, note))
            else:
                form_exists = bool(
                    self.driver.execute_script(
                        "return !!document.querySelector(arguments[0]);",
                        SOAP_FORM_SELECTOR,
                    )
                )
                if not form_exists:
                    self.logger.warning("SOAP form selector not present in current page.")
                    self.last_audio_error = "Formulário SOAP não encontrado."
                    return False

                with switch_to_iframe(self.driver, Locators.CONSULTATION_IFRAME, timeout):
                    ok = bool(self.driver.execute_script(selenium_append_script, note))

            if ok:
                self.logger.info("SOAP note appended to EMR consultation successfully.")
                return True

            self.logger.error("SOAP fill script returned false.")
            self.last_audio_error = "Falha ao preencher nota SOAP no EMR."
            return False
        except Exception as exc:
            self.logger.error("Failed to fill SOAP note into EMR: %s", exc)
            self.last_audio_error = f"Falha ao preencher SOAP no EMR: {exc}"
            try:
                self._save_error_screenshot("audio_fill_soap_error")
            except Exception:
                pass
            return False

    def _verify_audio_script_dependencies(self: "EMRAutomation") -> bool:
        """
        Verify that required third-party packages for the audio script are installed.

        Checks for: pyaudio, dotenv, pyperclip

        Returns:
            True if all dependencies are available, False otherwise
        """
        self.last_audio_error = None
        required_modules: List[str] = ["pyaudio", "dotenv", "pyperclip"]
        missing_modules: List[str] = []

        for module_name in required_modules:
            try:
                importlib.import_module(module_name)
            except ModuleNotFoundError:
                missing_modules.append(module_name)

        if missing_modules:
            self.logger.error(
                "Audio script dependencies missing in this Python environment: %s",
                ", ".join(missing_modules)
            )
            self.logger.error(
                "Install them with: pip install pyaudio python-dotenv pyperclip "
                "(inside the same virtualenv used for EMR Automation)."
            )
            self.logger.error(
                "On macOS, PyAudio may require 'brew install portaudio' before pip install."
            )
            self.last_audio_error = (
                "Pacotes necessários para a automação de áudio não estão instalados.\n"
                "Instale-os no mesmo ambiente Python:\n"
                "pip install pyaudio python-dotenv pyperclip\n"
                "No macOS pode ser necessário executar antes:\n"
                "brew install portaudio"
            )
            return False

        return True
