"""
Headless Hotkey Manager for EMR Automation.

Replaces the Tkinter GUI with global keyboard shortcuts and console/notification output.
Now includes visual overlay notifications with sound feedback.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from emr_automation.core import EMRAutomation

from emr_automation.constants import (
    PrescriptionTemplate,
    SleepDurations,
    URLPatterns,
)
from emr_automation.metrics import default_metrics
from emr_automation.audit_log import get_audit_logger
from emr_automation import overlay


class HotkeyManager:
    """
    Manages global hotkeys for EMR automation without a GUI.
    
    Uses pynput for keyboard shortcuts and console output for status updates.
    """
    
    def __init__(self, automation: "EMRAutomation"):
        """
        Initialize the hotkey manager.
        
        Args:
            automation: The EMRAutomation instance to control
        """
        self.automation = automation
        self.listener = None
        self.is_running = False
        self.is_audio_recording = False
        # Share the same operation lock with the dashboard so actions can't overlap.
        # Fallback to a local lock if an older EMRAutomation instance is used.
        self._operation_lock = getattr(automation, "_operation_lock", threading.Lock())
        self._shutdown_event = threading.Event()
        self._recording_start_time = None
        self._recording_timer_stop = threading.Event()
    
    def _print_status(self, message: str, emoji: str = "ℹ️") -> None:
        """Print a status message to console."""
        print(f"{emoji} {message}")
    
    def _notify_macos(self, title: str, message: str) -> None:
        """Send a macOS notification (optional, non-blocking)."""
        try:
            subprocess.Popen([
                "osascript", "-e",
                f'display notification "{message}" with title "{title}"'
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass  # Notifications are optional
    
    def _get_intern_id(self) -> Optional[str]:
        """Extract intern_id from the current URL (legacy query param or new path-based)."""
        try:
            url = self.automation.driver.current_url
            if "intern_id=" in url:
                return url.split("intern_id=")[1].split("&")[0]
            m = __import__("re").search(r"/interns/(\d+)", url)
            if m:
                return m.group(1)
        except Exception:
            pass
        return None
    
    def _check_and_relogin(self) -> bool:
        """
        Check if session expired and re-login if needed.
        
        Returns:
            bool: True if we're logged in (either already or after re-login), False if relogin failed
        """
        try:
            current_url = self.automation.driver.current_url
            if "/users/sign_in" in current_url:
                self._print_status("Sessão expirada — fazendo login novamente...", "🔐")
                if self.automation.login():
                    self._print_status("Login realizado com sucesso", "✅")
                    # Navigate back to consultations
                    from emr_automation.constants import URLPatterns
                    consultations_url = URLPatterns.consultations_url(
                        self.automation.config['EMR']['base_url']
                    )
                    self.automation.driver.get(consultations_url)
                    time.sleep(SleepDurations.ERROR_RECOVERY)
                    return True
                else:
                    self._print_status("Falha no login automático", "❌")
                    return False
            return True
        except Exception as e:
            self.automation.logger.error(f"Error checking login status: {e}")
            return True  # Assume logged in if we can't check
    
    def _run_in_thread(self, target, *args, operation_name: str = "operation",
                       patient_id: Optional[str] = None,
                       template_name: Optional[str] = None,
                       audit_action_type: Optional[str] = None) -> None:
        """Run a function in a background thread with lock protection and audit logging."""
        def wrapper():
            if not self._operation_lock.acquire(blocking=False):
                self._print_status(f"Aguarde, operação em andamento...", "⏳")
                overlay.warning("Aguarde", "Operação em andamento...")
                return

            audit = get_audit_logger()
            start_time = time.time()
            success = False
            error_msg = None

            try:
                # Check if session expired and re-login if needed
                if not self._check_and_relogin():
                    self._print_status(f"Operação cancelada — sessão não disponível", "❌")
                    overlay.error("Sessão Perdida", "Login necessário")
                    error_msg = "Session lost"
                    return

                self._print_status(f"Executando {operation_name}...", "🔄")
                overlay.info(operation_name, "Processando...", duration=1.5, play_sound=False)
                result = target(*args)
                # Check if the target returned False (silent failure)
                if result is False:
                    success = False
                    error_msg = "Operation returned False"
                    self._print_status(f"Falha em {operation_name}", "❌")
                    overlay.error(operation_name, "Operação falhou")
                else:
                    success = True
                    self._print_status(f"{operation_name} concluído", "✅")
                    overlay.success(operation_name, "Concluído com sucesso")
            except Exception as e:
                success = False
                error_msg = str(e)[:200]
                self._print_status(f"Erro em {operation_name}: {e}", "❌")
                overlay.error(f"Erro: {operation_name}", str(e)[:50])
                self.automation.logger.error(f"Error in {operation_name}: {e}")
            finally:
                duration = time.time() - start_time
                # Log to audit trail
                try:
                    audit.log_action(
                        action_type=audit_action_type or operation_name,
                        patient_id=patient_id or self._get_intern_id(),
                        template_used=template_name,
                        success=success,
                        duration_seconds=round(duration, 2),
                        error_message=error_msg,
                    )
                except Exception as audit_err:
                    self.automation.logger.debug(f"Audit log write failed: {audit_err}")
                self._operation_lock.release()

        threading.Thread(target=wrapper, daemon=True).start()
    
    # === Hotkey Handlers ===
    
    def handle_gastroenteritis(self, template_num: int) -> None:
        """Handle gastroenteritis template hotkey."""
        intern_id = self._get_intern_id()
        if not intern_id:
            self._print_status("Nenhum paciente selecionado", "⚠️")
            overlay.warning("Nenhum Paciente", "Selecione um paciente primeiro")
            return
        self._run_in_thread(
            self.automation.handle_gastroenteritis,
            intern_id, template_num,
            operation_name=f"Gastroenterite {template_num}",
            patient_id=intern_id,
            template_name=f"Gastroenterite {template_num}",
        )
    
    def handle_cold(self, template_num: int) -> None:
        """Handle cold template hotkey."""
        intern_id = self._get_intern_id()
        if not intern_id:
            self._print_status("Nenhum paciente selecionado", "⚠️")
            overlay.warning("Nenhum Paciente", "Selecione um paciente primeiro")
            return
        template_display = "6-2" if template_num == 1 else "2"
        self._run_in_thread(
            self.automation.handle_cold,
            intern_id, template_num,
            operation_name=f"Resfriado {template_display}",
            patient_id=intern_id,
            template_name=f"Resfriado {template_display}",
        )

    def handle_prescription_template(self, template: PrescriptionTemplate) -> None:
        """Handle direct prescribe-and-print template hotkeys."""
        intern_id = self._get_intern_id()
        if not intern_id:
            self._print_status("Nenhum paciente selecionado", "⚠️")
            overlay.warning("Nenhum Paciente", "Selecione um paciente primeiro")
            return
        self._run_in_thread(
            self.automation.prescribe_and_print,
            intern_id,
            template.code,
            operation_name=template.display_name,
            patient_id=intern_id,
            template_name=template.display_name,
        )
    
    def handle_discharge(self) -> None:
        """Handle discharge hotkey."""
        intern_id = self._get_intern_id()
        if not intern_id:
            self._print_status("Nenhum paciente selecionado", "⚠️")
            overlay.warning("Nenhum Paciente", "Selecione um paciente primeiro")
            return
        self._run_in_thread(
            self.automation.process_discharge,
            intern_id,
            operation_name="Alta",
            patient_id=intern_id,
        )
    
    def handle_medication(self) -> None:
        """Handle medication hotkey."""
        intern_id = self._get_intern_id()
        if not intern_id:
            self._print_status("Nenhum paciente selecionado", "⚠️")
            overlay.warning("Nenhum Paciente", "Selecione um paciente primeiro")
            return
        self._run_in_thread(
            self.automation.process_medication,
            intern_id,
            operation_name="Medicação",
            patient_id=intern_id,
        )
    
    def handle_refresh(self) -> None:
        """Handle refresh patient data hotkey."""
        def do_refresh():
            self.automation.extract_patient_weight()
            self.automation.extract_chief_complaint()
            weight = self.automation.weight
            complaint = self.automation.chief_complaint
            self._print_status(
                f"Paciente: {weight}kg | Queixa: {complaint or 'N/A'}",
                "👶"
            )
            # Show patient info in overlay
            overlay.info(
                f"Peso: {weight}kg",
                f"Queixa: {complaint or 'Não informada'}",
                duration=3.0
            )
        self._run_in_thread(do_refresh, operation_name="Atualizar paciente")
    
    def toggle_audio_note(self) -> None:
        """Toggle audio recording on/off."""
        if not self.automation.audio_to_note_script:
            self._print_status("Script de áudio não configurado", "❌")
            overlay.error("Erro", "Script de áudio não configurado")
            return
        
        if self.is_audio_recording:
            overlay.recording("Parando Gravação", "Processando áudio...", duration=1.5)
            self._run_in_thread(
                self._stop_audio_recording,
                operation_name="Audio SOAP",
                audit_action_type="audio_soap_fill",
                patient_id=self._get_intern_id(),
            )
        else:
            overlay.recording("Gravando", "Ctrl+Alt+A para parar", duration=2.0)
            self._run_in_thread(self._start_audio_recording, operation_name="Iniciar gravação")
    
    def _start_audio_recording(self) -> None:
        """Start the audio recording subprocess."""
        # Ensure clean state before starting
        self._recording_timer_stop.set()  # Stop any existing timer
        self.is_audio_recording = False
        self._recording_start_time = None

        try:
            proc = getattr(self.automation, "audio_proc", None)
            if not proc or proc.poll() is not None:
                script_path = str(self.automation.audio_to_note_script)
                script_cwd = str(self.automation.audio_to_note_script.parent)

                self.automation.audio_proc = subprocess.Popen(
                    [sys.executable, script_path],
                    cwd=script_cwd,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    text=True,
                    bufsize=1
                )

                time.sleep(SleepDurations.SUBPROCESS_STARTUP)

                # Check if process started successfully
                if self.automation.audio_proc.poll() is not None:
                    raise RuntimeError("Audio process terminated immediately")

            if self.automation.audio_proc and self.automation.audio_proc.stdin:
                self.automation.audio_proc.stdin.write('1\n')
                self.automation.audio_proc.stdin.flush()

            # Only mark as recording after successful start
            self.is_audio_recording = True
            self._recording_start_time = time.time()
            self._recording_timer_stop.clear()

            # Start the timer display thread
            threading.Thread(target=self._display_recording_timer, daemon=True).start()

            self._notify_macos("EMR Automation", "Gravação iniciada")

        except Exception as e:
            # Clean up on failure
            self.is_audio_recording = False
            self._recording_start_time = None
            self._recording_timer_stop.set()

            # Try to kill any orphaned process
            proc = getattr(self.automation, 'audio_proc', None)
            if proc:
                try:
                    proc.kill()
                except Exception:
                    pass
                self.automation.audio_proc = None

            self.automation.logger.error(f"Failed to start audio recording: {e}")
            raise
    
    def _display_recording_timer(self) -> None:
        """Display a live recording timer in the terminal."""
        try:
            while self.is_audio_recording and not self._recording_timer_stop.wait(timeout=SleepDurations.TIMER_UPDATE):
                if self._recording_start_time and self.is_audio_recording:
                    elapsed = time.time() - self._recording_start_time
                    minutes = int(elapsed // 60)
                    seconds = int(elapsed % 60)
                    # Use \r to overwrite the same line
                    print(f"\r🎙️  Gravando... {minutes:02d}:{seconds:02d}  (Ctrl+Alt+A para parar)", end="", flush=True)
        except Exception as e:
            # Timer thread should never crash the application
            pass
        finally:
            # Print newline when done to avoid overwriting
            print()
    
    def _stop_audio_recording(self) -> bool:
        """Stop the audio recording, generate a SOAP note, and insert it into the EMR."""
        # Always stop the timer first to ensure clean state
        self._recording_timer_stop.set()

        # Calculate final duration before any operations that might fail
        duration_str = ""
        if self._recording_start_time:
            elapsed = time.time() - self._recording_start_time
            minutes = int(elapsed // 60)
            seconds = int(elapsed % 60)
            duration_str = f" (duração: {minutes:02d}:{seconds:02d})"

        try:
            proc = getattr(self.automation, 'audio_proc', None)
            if proc:
                clipboard_before = None
                try:
                    import pyperclip
                    clipboard_before = pyperclip.paste()
                except Exception:
                    clipboard_before = None

                # Signal "stop recording" to the persistent worker process.
                if proc.stdin:
                    try:
                        proc.stdin.write('\n')
                        proc.stdin.flush()
                    except (BrokenPipeError, OSError):
                        self.automation.audio_proc = None
                        raise RuntimeError("Audio process is not accepting input")

            # Try to get clipboard content
            note_text = None
            try:
                import pyperclip
                # Wait for a clipboard update from the worker.
                # Require a content change to avoid reusing stale note text.
                time.sleep(SleepDurations.CLIPBOARD_POLL)
                deadline = time.time() + 120
                while time.time() < deadline:
                    try:
                        clipboard_content = pyperclip.paste()
                        if clipboard_content and clipboard_content.strip() and (
                            clipboard_before is None or clipboard_content != clipboard_before
                        ):
                            note_text = clipboard_content
                            break
                    except Exception as clip_err:
                        self.automation.logger.debug(f"Clipboard read attempt failed: {clip_err}")
                    time.sleep(SleepDurations.CLIPBOARD_POLL)
            except ImportError:
                self.automation.logger.warning("pyperclip not installed, cannot check clipboard")

            if note_text:
                inserted = self.automation.fill_soap_note_to_emr(note_text)
                if inserted:
                    self._print_status(f"SOAP preenchido no EMR{duration_str}", "✅")
                    self._notify_macos("EMR Automation", "SOAP preenchido no EMR")
                    overlay.success("SOAP preenchido", f"Nota inserida no EMR{duration_str}")
                    return True

                self._print_status(f"SOAP gerado, mas não foi inserido no EMR{duration_str}", "⚠️")
                overlay.warning("SOAP gerado", "Falha ao preencher automaticamente no EMR")
                return False
            else:
                self._print_status(f"Nenhum texto na área de transferência{duration_str}", "⚠️")
                overlay.warning("Atenção", f"Nenhum texto na área de transferência{duration_str}")
                return False

        except Exception as e:
            self.automation.logger.error(f"Failed to stop audio recording: {e}")
            self._print_status(f"Erro ao parar gravação: {e}", "❌")
            return False
        finally:
            # Always reset state, even on error
            self.is_audio_recording = False
            self._recording_start_time = None
            self._recording_timer_stop.set()  # Ensure timer is stopped
    
    def handle_panic_restart(self) -> None:
        """Force restart WebDriver session (panic button)."""
        def do_restart():
            intern_id = self._get_intern_id()  # Try to preserve patient context
            self._print_status("Reiniciando sessão do navegador...", "🔄")
            
            try:
                # Force quit the current driver
                if self.automation.driver:
                    try:
                        self.automation.driver.quit()
                    except Exception:
                        pass
                    self.automation.driver = None
                
                # Reinitialize driver and login
                self.automation.setup_driver()
                if self.automation.login():
                    self._print_status("Sessão reiniciada com sucesso", "✅")
                    self._notify_macos("EMR Automation", "Sessão reiniciada!")
                    
                    # Try to return to patient if we had one
                    if intern_id:
                        consultations_url = URLPatterns.consultations_url(
                            self.automation.config['EMR']['base_url']
                        )
                        self.automation.driver.get(consultations_url)
                        self._print_status(f"Retornando a consultas (paciente anterior: {intern_id})", "👶")
                else:
                    self._print_status("Falha no login após reiniciar", "❌")
            except Exception as e:
                self._print_status(f"Erro ao reiniciar sessão: {e}", "❌")
                self.automation.logger.error(f"Panic restart failed: {e}")
        
        self._run_in_thread(do_restart, operation_name="Reiniciar sessão")
    
    def handle_show_metrics(self) -> None:
        """Display operation metrics summary."""
        try:
            summary = default_metrics.get_summary()
            
            if summary.get('total_operations', 0) == 0:
                self._print_status("Nenhuma métrica coletada ainda", "📊")
                return
            
            print("\n" + "=" * 50)
            print("📊 Métricas de Operação")
            print("=" * 50)
            print(f"  Total de operações: {summary['total_operations']}")
            print(f"  ✅ Sucesso: {summary['success_count']}")
            print(f"  ❌ Falhas: {summary['failure_count']}")
            
            success_rate = (summary['success_count'] / summary['total_operations'] * 100) if summary['total_operations'] > 0 else 0
            print(f"  Taxa de sucesso: {success_rate:.1f}%")
            
            print("\n  Detalhes por operação:")
            for name, stats in summary.get('operations', {}).items():
                print(f"    {name}: {stats['count']}x, {stats['success_rate']:.0f}% ok, avg {stats['avg_duration_seconds']:.1f}s")
            
            print("=" * 50 + "\n")
            
            self._notify_macos("EMR Metrics", f"Taxa de sucesso: {success_rate:.0f}%")
            
        except Exception as e:
            self._print_status(f"Erro ao exibir métricas: {e}", "❌")
    
    def handle_quit(self) -> None:
        """Handle quit hotkey."""
        self._print_status("Encerrando EMR Automation...", "👋")
        overlay.info("Encerrando", "Até logo!", duration=1.5, play_sound=False)
        self._shutdown_event.set()
    
    def start(self) -> None:
        """Start listening for hotkeys."""
        try:
            from pynput import keyboard as pynput_keyboard
            
            hotkeys = {
                '<ctrl>+<alt>+1': lambda: self.handle_gastroenteritis(1),
                '<ctrl>+<alt>+2': lambda: self.handle_gastroenteritis(2),
                '<ctrl>+<alt>+3': lambda: self.handle_cold(1),
                '<ctrl>+<alt>+4': lambda: self.handle_cold(2),
                '<ctrl>+<alt>+5': lambda: self.handle_prescription_template(
                    PrescriptionTemplate.LARYNGITIS
                ),
                '<ctrl>+<alt>+6': lambda: self.handle_prescription_template(
                    PrescriptionTemplate.BRONCHOSPASM
                ),
                '<ctrl>+<alt>+7': lambda: self.handle_prescription_template(
                    PrescriptionTemplate.UTI
                ),
                '<ctrl>+<alt>+8': lambda: self.handle_prescription_template(
                    PrescriptionTemplate.PHARYNGITIS
                ),
                '<ctrl>+<alt>+9': lambda: self.handle_prescription_template(
                    PrescriptionTemplate.OMA
                ),
                '<ctrl>+<alt>+d': self.handle_discharge,
                '<ctrl>+<alt>+m': self.handle_medication,
                '<ctrl>+<alt>+r': self.handle_refresh,
                '<ctrl>+<alt>+a': self.toggle_audio_note,
                '<ctrl>+<alt>+e': self.handle_panic_restart,  # Panic button
                '<ctrl>+<alt>+s': self.handle_show_metrics,   # Show stats
                '<ctrl>+<alt>+q': self.handle_quit,
            }
            
            self.listener = pynput_keyboard.GlobalHotKeys(hotkeys)
            self.listener.start()
            self.is_running = True
            
            self.automation.logger.info("Global hotkeys registered.")
            self._print_hotkey_help()
            
        except ImportError:
            self.automation.logger.warning("pynput not installed. Hotkeys disabled.")
            self._print_status("pynput não instalado. Hotkeys desativados.", "⚠️")
        except Exception as e:
            self.automation.logger.error(f"Failed to set up hotkeys: {e}")
            self._print_status(f"Erro ao configurar hotkeys: {e}", "❌")
    
    def _print_hotkey_help(self) -> None:
        """Print available hotkeys to console."""
        print("\n" + "=" * 50)
        print("🏥 EMR Automation — Hotkeys Ativos")
        print("=" * 50)
        print("  Ctrl+Alt+1  →  Gastroenterite 1")
        print("  Ctrl+Alt+2  →  Gastroenterite 2")
        print("  Ctrl+Alt+3  →  Resfriado 6-2")
        print("  Ctrl+Alt+4  →  Resfriado 2")
        print("  Ctrl+Alt+5  →  Laringite/Crupe")
        print("  Ctrl+Alt+6  →  Broncoespasmo/Sibilante")
        print("  Ctrl+Alt+7  →  ITU Baixa")
        print("  Ctrl+Alt+8  →  Faringite Bacteriana")
        print("  Ctrl+Alt+9  →  OMA (Otite Media Aguda)")
        print("  Ctrl+Alt+D  →  Alta")
        print("  Ctrl+Alt+M  →  Medicação")
        print("  Ctrl+Alt+R  →  Atualizar Paciente")
        print("  Ctrl+Alt+A  →  Áudio → SOAP")
        print("  Ctrl+Alt+E  →  🔄 Reiniciar Sessão (Panic)")
        print("  Ctrl+Alt+S  →  📊 Ver Métricas")
        print("  Ctrl+Alt+Q  →  Sair")
        print("=" * 50)
        print("✅ Pronto — aguardando hotkeys...\n")
    
    def stop(self) -> None:
        """Stop listening for hotkeys."""
        if self.listener:
            self.listener.stop()
            self.listener = None

        # Shut down persistent audio worker to avoid leaving orphan process.
        proc = getattr(self.automation, "audio_proc", None)
        if proc:
            try:
                if proc.stdin:
                    try:
                        proc.stdin.write('q\n')
                        proc.stdin.flush()
                    except (BrokenPipeError, OSError):
                        pass
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=2)
            except Exception:
                pass
            finally:
                self.automation.audio_proc = None

        self.is_running = False
    
    def wait_for_shutdown(self) -> None:
        """Block until shutdown is requested (via hotkey or signal)."""
        self._shutdown_event.wait()
    
    def request_shutdown(self) -> None:
        """Request shutdown from external source (e.g., signal handler)."""
        self._shutdown_event.set()
