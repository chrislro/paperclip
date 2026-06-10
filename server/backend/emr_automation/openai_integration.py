"""
OpenAI integration for EMR Automation.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from emr_automation.utils import show_message

if TYPE_CHECKING:
    from emr_automation.core import EMRAutomation


class OpenAIMixin:
    """
    Mixin class providing OpenAI integration functionality.

    This is designed to be mixed into EMRAutomation class.
    Provides AI-powered clinical decision support using OpenAI's API.
    """

    def send_to_openai(self: "EMRAutomation") -> Optional[str]:
        """
        Send patient information to OpenAI and retrieve clinical recommendations.

        This method constructs a prompt with the patient's chief complaint and weight,
        then requests differential diagnoses and management suggestions from the AI.

        Requirements:
            Configure OpenAI OAuth via environment variables or the [OpenAI]
            section in config.ini.

        The response will be copied to clipboard and shown in a message box.

        Returns:
            The content returned by the OpenAI API, or None if the call failed.
        """
        # Ensure we have the latest patient data
        if self.chief_complaint is None:
            self.extract_chief_complaint()
        if self.weight is None:
            self.extract_patient_weight()

        if not self.openai_client:
            warning_msg = (
                "OAuth da OpenAI nao configurado. Defina OPENAI_OAUTH_ACCESS_TOKEN "
                "ou as credenciais OAuth no config.ini."
            )
            self.logger.error(warning_msg)
            show_message("Erro", warning_msg, level="error")
            return None

        try:
            prompt = self._build_clinical_prompt()

            response = self.openai_client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3,
                max_tokens=400
            )

            result = (response.choices[0].message.content or "").strip()
            self.logger.info("Resposta da OpenAI:\n%s", result)

            # Copy to clipboard for convenience
            self._copy_to_clipboard(result)

            # Show in a simple dialog
            show_message("Sugestões da OpenAI", result, level="info")
            return result

        except Exception as e:
            self.logger.error(f"Falha na comunicação com OpenAI: {e}")
            show_message("Erro", f"Falha na comunicação com OpenAI: {e}", level="error")
            return None

    def _build_clinical_prompt(self: "EMRAutomation") -> str:
        """
        Build the prompt for OpenAI clinical recommendations.

        Returns:
            Formatted prompt string
        """
        chief_complaint = self.chief_complaint if self.chief_complaint else "Queixa não informada"
        weight = f"{self.weight} kg" if self.weight else "desconhecido"

        return (
            f"Você é um médico pediatra experiente. O paciente apresenta: "
            f"{chief_complaint}. "
            f"Peso: {weight}. "
            "Liste 3 a 5 diagnósticos diferenciais e sugira um plano de manejo conciso."
        )

    def _copy_to_clipboard(self: "EMRAutomation", text: str) -> bool:
        """
        Copy text to clipboard safely.

        Args:
            text: Text to copy

        Returns:
            True if successful, False otherwise
        """
        try:
            import pyperclip
            pyperclip.copy(text)
            return True
        except ImportError:
            self.logger.warning("pyperclip not installed, cannot copy to clipboard")
            return False
        except Exception as e:
            self.logger.warning(f"Failed to copy to clipboard: {e}")
            return False
