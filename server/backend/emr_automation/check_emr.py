"""
Check EMR for Pediatric Patients.

This module monitors the EMR system for pediatric patients waiting for triage
and sends Telegram notifications when found.

Refactored to check logic reuse from verify EMRAutomation.core.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Tuple
from urllib import error as urllib_error
from urllib import request as urllib_request

from keychain_helper import keychain_secret

# Ensure UTF-8 output
if hasattr(sys.stdout, 'reconfigure'):
    # pylint: disable=no-member
    sys.stdout.reconfigure(encoding='utf-8')

# Stats file for sharing data with Work Launcher
STATS_FILE = Path(__file__).parent.parent / ".check_emr_stats.json"

# Sound file for alerts
ALERT_SOUND = Path(__file__).parent.parent / "zapsplat_multimedia_notification_alert_mallet_musical_sequence_short_positive_005_107275.mp3"

# Telegram config from Keychain (token revoked 2026-04-23; add new one to Keychain to restore)
TELEGRAM_BOT_TOKEN = keychain_secret("telegram-bot-token")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")

# Import shared components
from emr_automation.core import EMRAutomation
from emr_automation.constants import URLPatterns
from emr_automation.exceptions import AccountLockedError, BadCredentialsError

# Conditional imports for typing or Selenium constants
try:
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
except ImportError:
    # If Selenium is not installed (e.g. using pure Playwright in future), these might fail
    # But EMRAutomation handles the backend. For now, we assume Selenium is present.
    By = None
    WebDriverWait = None
    EC = None


def send_telegram_message(text: str) -> bool:
    """
    Send a Telegram message with notification sound.
    
    Args:
        text: Message text to send
        
    Returns:
        True if sent successfully, False otherwise
    """
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("⚠️ Telegram not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env")
        return False

    print("📩 Sending Telegram message...")
    
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
        payload = {
            "chat_id": TELEGRAM_CHAT_ID,
            "text": text,
            "disable_notification": False
        }

        try:
            import requests
        except ImportError:
            requests = None

        response_json = None
        if requests is not None:
            resp = requests.post(url, json=payload, timeout=10)
            resp.raise_for_status()
            try:
                response_json = resp.json()
            except ValueError:
                response_json = None
        else:
            print("ℹ️ 'requests' not installed; using built-in HTTP client.")
            req = urllib_request.Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib_request.urlopen(req, timeout=10) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            try:
                response_json = json.loads(raw)
            except json.JSONDecodeError:
                response_json = None

        if isinstance(response_json, dict) and not response_json.get("ok", True):
            desc = response_json.get("description", "unknown Telegram API error")
            print(f"⚠️ Error sending Telegram message: {desc}")
            return False

        print(f"✅ Telegram message sent: {text[:50]}...")
        return True
    except urllib_error.URLError as e:
        print(f"⚠️ Error sending Telegram message: {e}")
        return False
    except Exception as e:
        print(f"⚠️ Error sending Telegram message: {e}")
        return False


def update_stats(patients_found: int = 0, patient_names: Optional[List[str]] = None) -> None:
    """
    Update stats file for Work Launcher to read.
    
    Args:
        patients_found: Number of new patients found
        patient_names: List of patient names found
    """
    try:
        # Load existing stats
        today = datetime.now().strftime("%Y-%m-%d")
        
        if STATS_FILE.exists():
            try:
                with open(STATS_FILE, "r", encoding="utf-8") as f:
                    stats = json.load(f)
            except (json.JSONDecodeError, UnicodeDecodeError):
                stats = {"today": today, "total_today": 0, "patients": []}
        else:
            stats = {"today": today, "total_today": 0, "patients": []}
        
        # Reset if new day
        if stats.get("today") != today:
            stats = {"today": today, "total_today": 0, "patients": []}
        
        # Update counts
        stats["last_check"] = datetime.now().strftime("%H:%M:%S")
        if patients_found > 0:
            stats["total_today"] += patients_found
            if patient_names:
                stats["patients"].extend(patient_names)
        
        # Atomic write: avoid torn JSON reads by launcher.
        tmp_file = STATS_FILE.with_suffix(".json.tmp")
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(stats, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_file, STATS_FILE)
        
    except Exception as e:
        print(f"⚠️ Error updating stats: {e}")


def play_alert_sound() -> None:
    """Play the alert sound (non-blocking)."""
    try:
        if ALERT_SOUND.exists():
            subprocess.Popen(
                ["afplay", str(ALERT_SOUND)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
        else:
            # Fallback to system sound
            subprocess.Popen(
                ["afplay", "/System/Library/Sounds/Glass.aiff"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
    except Exception:
        pass


class PediatricChecker:
    """
    Monitors EMR for pediatric patients.
    
    Refactored to use EMRAutomation for robust browser management.
    """
    
    def __init__(self, headless: bool = True, refresh_minutes: int = 10):
        """
        Initialize the checker.
        
        Args:
            headless: Run browser in headless mode
            refresh_minutes: How often to check (in minutes)
        """
        self.headless = headless
        self.refresh_seconds = refresh_minutes * 60
        self.bot: Optional[EMRAutomation] = None
        self.driver = None
        self.base_url = ""

    def _sync_driver_reference(self) -> bool:
        """Keep local driver reference aligned with the shared EMR engine."""
        self.driver = self.bot.driver if self.bot else None
        return self.driver is not None

    def _recover_session(self, reason: str) -> bool:
        """Force a full browser/session restart and login."""
        if not self.bot:
            print("⚠️ EMR engine not initialized.")
            return False

        print("⚠️ Session lost. Re-authenticating with fresh browser session...")
        try:
            self.bot._restart_driver_session(skip_login=False, trigger_name=reason)
        except (BadCredentialsError, AccountLockedError):
            # Terminal: must propagate so the run() loop halts the process.
            raise
        except Exception as e:
            print(f"❌ Re-authentication failed: {e}")
            self._sync_driver_reference()
            return False

        if self._sync_driver_reference():
            print("✅ Session restored.")
            return True

        print("❌ Re-authentication failed: driver not available after restart.")
        return False
        
    # Age threshold in years — patients below this are considered pediatric.
    PEDIATRIC_AGE_LIMIT = 12

    # Keywords that identify pediatric patients in category columns (fallback).
    # Aligned with the sibling Pediatrics repo's list (Bug 66) so newborns/infants
    # whose category cell reads "Recém-nascido", "Bebê", or "Infantil" — and whose
    # age cell is empty/unparseable (the AJAX-blank-cell case of Bug 65) — are not
    # silently missed by the age path. These terms carry no false-positive risk in
    # the category column. Two of the sibling's keywords are DELIBERATELY excluded:
    #   • "menor"     — false-positives on the "menor complexidade" triage-acuity
    #                   label (the exact full-row-bleed class Bug 48 fixed).
    #   • "pediatria" — redundant; already covered by the "pediatr" prefix.
    PEDIATRIC_KEYWORDS = [
        "criança", "pediatr", "ped ", "pediátric", "lactente", "neonato", "rn ",
        "recem-nascido", "recém-nascido", "bebe", "bebê", "infantil",
    ]

    @staticmethod
    def _category_has_pediatric_keyword(category_text, keywords):
        """True if the priority-CATEGORY cell text names a pediatric class.

        Scoped to the category column only. Matching the full joined row text
        false-positives on adult patients when a keyword substring bleeds in
        from an adjacent cell, status text ('Chamando Consultório'), or an href
        path — the failure the sibling Pediatrics repo fixed in 0aa73d6.
        """
        cat = (category_text or "").lower()
        return any(kw in cat for kw in keywords)

    # Regex patterns for age in Brazilian EMR format.
    # Ages USUALLY appear in parentheses after the patient name:
    #   "(5a 3m )"  = 5 anos, 3 meses
    #   "(11m )"    = 11 meses
    #   "(23d )"    = 23 dias
    #   "(1a )"     = 1 ano
    # The opening paren is required HERE to avoid false matches on timestamps
    # like "há 9 min" which would otherwise match as "9m".
    _AGE_PATTERN_PAREN = re.compile(
        r'\(\s*'
        r'(?:(\d+)\s*a(?:nos?)?\s*)?'   # optional years
        r'(?:(\d+)\s*m(?:es(?:es)?)?\s*)?'  # optional months
        r'(?:(\d+)\s*d(?:ias?)?\s*)?'   # optional days
        r'\)',
        re.IGNORECASE,
    )

    # Bug 67 — aligned with the sibling Pediatrics repo: some G-Hosp views render
    # the age WITHOUT parentheses ("5 anos", "11 meses", "3 dias"). Without this
    # fallback those rows have no parseable age and reach only the keyword path.
    # A bare unit letter ("9 m") is NOT enough — _extract_age_years additionally
    # requires the SPELLED-OUT unit (ano/mes/dia), so timestamps like "há 9 min"
    # still cannot be misread as an age (the same guard the paren form gets for free).
    _AGE_PATTERN_FREE = re.compile(
        r'(?:^|\s)'
        r'(\d+)\s*(?:a(?:nos?)?|m(?:es(?:es)?)?|d(?:ias?)?)'
        r'(?:\s|$|[,;])',
        re.IGNORECASE,
    )

    @classmethod
    def _extract_age_years(cls, text: str) -> Optional[float]:
        """Extract age in years from text like '(5a 3m)', '(11m)', or '5 anos'.

        Returns None if no age pattern is found.
        """
        # Try parenthesized format first (most common in the EMR).
        for m in cls._AGE_PATTERN_PAREN.finditer(text):
            yrs_str, mos_str, days_str = m.group(1), m.group(2), m.group(3)
            if yrs_str is None and mos_str is None and days_str is None:
                continue
            years = int(yrs_str) if yrs_str else 0
            months = int(mos_str) if mos_str else 0
            days = int(days_str) if days_str else 0
            return years + months / 12.0 + days / 365.0

        # Fallback: free-standing age ("5 anos", "11 meses"). Only counted when the
        # SPELLED-OUT unit is present, so "há 9 min" / bare "9 m" never false-positive.
        for m in cls._AGE_PATTERN_FREE.finditer(text):
            age_val = int(m.group(1)) if m.group(1) else 0
            age_text = m.group(0).lower()
            if 'a' in age_text and ('ano' in age_text or 'años' in age_text):
                return float(age_val)
            elif 'm' in age_text and ('mes' in age_text or 'mês' in age_text):
                return age_val / 12.0
            elif 'd' in age_text and 'dia' in age_text:
                return age_val / 365.0

        return None

    def check_for_pediatric_patients(self) -> List[str]:
        """
        Check for pediatric patients waiting for triage.

        Returns:
            List of patient names found
        """
        found_patients = []

        try:
            print("🔍 Checking for pediatric patients...")

            if not self.bot:
                print("⚠️ EMR engine not initialized.")
                return []

            # Ensure session is active
            if not self._sync_driver_reference():
                print("⚠️ Driver lost, re-initializing...")
                if not self._recover_session("check_emr_missing_driver"):
                    send_telegram_message("⚠️ Check EMR: sessão perdida e não foi possível reconectar.")
                    return []

            # Check if we got redirected to login (session expired)
            try:
                current_url = self.driver.current_url
                if "/users/sign_in" in current_url:
                    print("⚠️ Session expired (redirected to login). Re-authenticating...")
                    if not self._recover_session("check_emr_session_expired"):
                        send_telegram_message("⚠️ Check EMR: sessão expirou e re-login falhou.")
                        return []
            except Exception:
                if not self._recover_session("check_emr_url_check_failed"):
                    send_telegram_message("⚠️ Check EMR: navegador não responde, re-login falhou.")
                    return []

            # Use the base URL from the bot config
            consultations_url = URLPatterns.consultations_url(self.base_url)

            # Navigate to consultations page
            self.driver.get(consultations_url)

            # Detect post-navigation redirect to login
            time.sleep(2)
            try:
                if "/users/sign_in" in self.driver.current_url:
                    print("⚠️ Redirected to login after navigation. Re-authenticating...")
                    if not self._recover_session("check_emr_redirect_on_nav"):
                        send_telegram_message("⚠️ Check EMR: redirecionado para login, re-autenticação falhou.")
                        return []
                    self.driver.get(consultations_url)
            except Exception:
                pass

            # Wait for table
            wait = WebDriverWait(self.driver, 30)
            try:
                table = wait.until(EC.presence_of_element_located((By.ID, "div-lista")))
                print("✅ Table loaded.")
            except Exception:
                print("⚠️ Could not find table #div-lista")
                update_stats(0, [])
                return []

            # Try to load more patients
            try:
                load_more = self.driver.find_element(By.ID, "link_carregar_aguardando_atendimento")
                if load_more.is_displayed():
                    print("🔄 Loading more patients...")
                    before_rows = len(table.find_elements(By.XPATH, './/tr'))
                    load_more.click()
                    try:
                        WebDriverWait(self.driver, 10).until(
                            lambda d: len(table.find_elements(By.XPATH, './/tr')) > before_rows
                        )
                    except Exception:
                        pass
            except Exception:
                pass

            # Find section boundaries for context logging
            aguardando_y = None
            try:
                aguardando = self.driver.find_element(
                    By.XPATH,
                    "//legend[contains(text(), 'Aguardando triagem')]"
                )
                aguardando_y = aguardando.location['y']
                print(f"📍 'Aguardando triagem' at Y: {aguardando_y}")
            except Exception:
                print("⚠️ Could not find 'Aguardando triagem' section — will scan all rows")

            # Get all rows
            rows = table.find_elements(By.XPATH, './/tr')
            print(f"📊 Found {len(rows)} rows in table.")

            # Scan ALL rows — no Y-coordinate filtering.
            # Detection strategy:
            #   1. Parse age from patient name text, e.g. "(5a 3m)" → 5.25 years
            #   2. Fallback: check for pediatric keywords like "Criança"
            for index, row in enumerate(rows):
                try:
                    columns = row.find_elements(By.TAG_NAME, "td")
                    if len(columns) < 5:
                        continue

                    # Use textContent via JS — G-Hosp loads cell text via AJAX,
                    # so Selenium's .text returns '' for every data cell (same
                    # root cause as Pediatrics fix 0aa73d6).
                    row_text_parts = [
                        self.driver.execute_script(
                            "return arguments[0].textContent || '';", col
                        ).strip()
                        for col in columns
                    ]
                    row_text_full = " ".join(row_text_parts)

                    # Strategy 1: age-based detection
                    age_years = self._extract_age_years(row_text_full)
                    is_pediatric = age_years is not None and age_years < self.PEDIATRIC_AGE_LIMIT
                    detection_reason = ""

                    if is_pediatric:
                        if age_years < 1:
                            age_display = f"{int(age_years * 12)}m"
                        else:
                            age_display = f"{age_years:.1f}a"
                        detection_reason = f"age={age_display}"

                    # Strategy 2: keyword fallback (if no age found). Scope the
                    # match to the priority-category column (index 4: "Criança",
                    # "RN", "Lactente"); matching the full joined row text
                    # false-positives on adult rows when a keyword substring bleeds
                    # in from an adjacent cell / status text / href path (sibling
                    # Pediatrics fix 0aa73d6; narrower here as it is age-gated).
                    if not is_pediatric and age_years is None:
                        category_text = row_text_parts[4] if len(row_text_parts) > 4 else ""
                        is_pediatric = self._category_has_pediatric_keyword(
                            category_text, self.PEDIATRIC_KEYWORDS
                        )
                        if is_pediatric:
                            cat_lower = category_text.lower()
                            matched_kw = next(
                                (kw for kw in self.PEDIATRIC_KEYWORDS if kw in cat_lower), "?"
                            )
                            detection_reason = f"keyword='{matched_kw}' (cat col)"

                    if is_pediatric:
                        # Extract patient name — look for the longest link text
                        patient_name = "Desconhecido"
                        for col in columns:
                            try:
                                link = col.find_element(By.TAG_NAME, "a")
                                link_text = self.driver.execute_script(
                                    "return arguments[0].textContent || '';", link
                                ).strip()
                                if link_text and not link_text.isdigit():
                                    # Remove age suffix for cleaner name
                                    clean_name = re.sub(r'\s*\(\d+[adm].*$', '', link_text).strip()
                                    if len(clean_name) > len(patient_name) or patient_name == "Desconhecido":
                                        patient_name = clean_name if clean_name else link_text
                            except Exception:
                                continue

                        print(f"🚨 Found pediatric patient: {patient_name} ({detection_reason}, row {index})")
                        found_patients.append(patient_name)

                        # Send notification
                        send_telegram_message(
                            f"🚨 Alerta: Paciente Pediátrico!\n👶 Nome: {patient_name}\n📊 {detection_reason}"
                        )

                        # Play sound after short delay
                        time.sleep(1)
                        play_alert_sound()

                except Exception as row_err:
                    print(f"⚠️ Error processing row {index}: {row_err}")
                    continue

            if not found_patients:
                # Debug: dump first few rows so we can diagnose if the issue recurs
                print("ℹ️ No pediatric patients found. Row sample for debugging:")
                for i, row in enumerate(rows[:5]):
                    try:
                        cols = row.find_elements(By.TAG_NAME, "td")
                        col_texts = [
                            self.driver.execute_script(
                                "return arguments[0].textContent || '';", c
                            ).strip()[:40]
                            for c in cols
                        ]
                        print(f"   Row {i} ({len(cols)} cols): {col_texts}")
                    except Exception:
                        pass

        except Exception as e:
            print(f"⚠️ Error checking patients: {e}")
            send_telegram_message(f"⚠️ Check EMR erro: {e}")
            # Try to recover session if it was a webdriver error
            handled = False
            try:
                if self.bot:
                    handled = self.bot._handle_driver_exception(e, "check_loop")
            except Exception:
                pass
            if handled:
                self._recover_session("check_emr_check_loop")

        update_stats(len(found_patients), found_patients)
        return found_patients
    
    def _keep_alive_wait(self) -> bool:
        """
        Wait for the refresh interval while sending periodic keep-alive
        pings to the browser so the ChromeDriver connection stays open.

        Returns:
            True if the session is still alive after waiting,
            False if it was lost (caller should recover).
        """
        KEEP_ALIVE_INTERVAL = 60  # ping every 60 seconds
        elapsed = 0

        while elapsed < self.refresh_seconds:
            sleep_chunk = min(KEEP_ALIVE_INTERVAL, self.refresh_seconds - elapsed)
            time.sleep(sleep_chunk)
            elapsed += sleep_chunk

            # Lightweight keep-alive ping
            if self.driver:
                try:
                    _ = self.driver.title
                except Exception:
                    return False
            else:
                return False

        return True

    def _quick_session_check(self) -> bool:
        """
        Lightweight check: is the WebDriver still responding?
        Unlike health_check() this does NOT navigate away from the current page.
        """
        if not self._sync_driver_reference():
            return False
        try:
            _ = self.driver.current_url
            return True
        except Exception:
            return False

    def run(self) -> None:
        """Main loop: login, check, wait, repeat."""
        MAX_LOGIN_RETRIES = 5
        LOGIN_RETRY_DELAY = 30  # seconds between retries
        MAX_CONSECUTIVE_FAILURES = 3  # failures before notifying via Telegram

        print("🤖 Initializing EMR Automation Engine...")

        # Initialize the shared engine with headless override
        self.bot = EMRAutomation(headless=self.headless)
        self.base_url = self.bot.config['EMR']['base_url']

        # Login. Credential rejection / account lockout are TERMINAL — never retry,
        # because Devise locks the account after 3 strikes and IT must unlock it.
        # Only network/UI transients are eligible for retry.
        print("🔐 Logging in via central engine...")
        login_success = False
        for attempt in range(1, MAX_LOGIN_RETRIES + 1):
            try:
                if self.bot.login() and self._sync_driver_reference():
                    login_success = True
                    break
            except BadCredentialsError as e:
                msg = f"❌ Check EMR: credenciais rejeitadas — script encerrado para evitar bloqueio da conta. ({e})"
                print(msg)
                send_telegram_message(msg)
                return
            except AccountLockedError as e:
                msg = f"❌ Check EMR: conta bloqueada — encerrado. Contate IT. ({e})"
                print(msg)
                send_telegram_message(msg)
                return
            print(f"⚠️ Login attempt {attempt}/{MAX_LOGIN_RETRIES} failed (transient).")
            if attempt < MAX_LOGIN_RETRIES:
                print(f"⏳ Retrying in {LOGIN_RETRY_DELAY}s...")
                time.sleep(LOGIN_RETRY_DELAY)
                # Restart browser for a clean slate
                try:
                    self.bot._cleanup_browser()
                except Exception:
                    pass
                self.bot = EMRAutomation(headless=self.headless)

        if not login_success:
            msg = "❌ Check EMR: login falhou após todas as tentativas. Verifique credenciais ou o sistema."
            print(msg)
            send_telegram_message(msg)
            return

        print("✅ Login successful. Starting monitoring loop.")

        consecutive_failures = 0

        try:
            while True:
                patients = self.check_for_pediatric_patients()

                # Track consecutive check failures (empty return + no error is fine,
                # but exceptions inside check_for_pediatric_patients set patients to [])
                if patients is not None:
                    consecutive_failures = 0
                else:
                    consecutive_failures += 1

                if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                    msg = f"⚠️ Check EMR: {consecutive_failures} verificações consecutivas falharam. Pode haver problema com o sistema."
                    print(msg)
                    send_telegram_message(msg)
                    consecutive_failures = 0  # reset so we don't spam

                print(f"⏳ Waiting {self.refresh_seconds // 60} minute(s)...")

                session_alive = self._keep_alive_wait()

                if not session_alive or not self._quick_session_check():
                    print("⚠️ Session lost during wait. Re-authenticating...")
                    recovered = False
                    try:
                        for attempt in range(1, MAX_LOGIN_RETRIES + 1):
                            if self._recover_session("check_emr_keepalive"):
                                recovered = True
                                break
                            print(f"⚠️ Recovery attempt {attempt}/{MAX_LOGIN_RETRIES} failed.")
                            if attempt < MAX_LOGIN_RETRIES:
                                time.sleep(LOGIN_RETRY_DELAY)
                    except BadCredentialsError as e:
                        msg = f"❌ Check EMR: credenciais rejeitadas durante re-auth — encerrado para evitar bloqueio. ({e})"
                        print(msg)
                        send_telegram_message(msg)
                        return
                    except AccountLockedError as e:
                        msg = f"❌ Check EMR: conta bloqueada durante re-auth — encerrado. Contate IT. ({e})"
                        print(msg)
                        send_telegram_message(msg)
                        return

                    if not recovered:
                        msg = "❌ Check EMR: sessão perdida e re-login falhou após várias tentativas."
                        print(msg)
                        send_telegram_message(msg)
                        print("⏳ Waiting before next attempt...")
                        time.sleep(LOGIN_RETRY_DELAY * 2)
                        # Try full restart — credential errors here also terminate.
                        try:
                            self.bot._cleanup_browser()
                        except Exception:
                            pass
                        self.bot = EMRAutomation(headless=self.headless)
                        try:
                            if self.bot.login() and self._sync_driver_reference():
                                print("✅ Full restart login successful.")
                            else:
                                print("❌ Full restart also failed. Will retry next cycle.")
                                continue
                        except BadCredentialsError as e:
                            msg = f"❌ Check EMR: credenciais rejeitadas no full restart — encerrado. ({e})"
                            print(msg)
                            send_telegram_message(msg)
                            return
                        except AccountLockedError as e:
                            msg = f"❌ Check EMR: conta bloqueada no full restart — encerrado. ({e})"
                            print(msg)
                            send_telegram_message(msg)
                            return

        except KeyboardInterrupt:
            print("\n👋 Stopping checker...")
        finally:
            if self.bot:
                self.bot._cleanup_browser()
    
    def cleanup(self) -> None:
        """Clean up resources."""
        if self.bot:
            self.bot._cleanup_browser()


def main():
    """Entry point with interactive configuration."""
    print("🏥 EMR Pediatric Patient Checker")
    print("=" * 40)
    
    # Mode selection
    print("\nChoose run mode:")
    print("  1) Headless (no browser window)")
    print("  2) Normal (visible browser)")
    try:
        choice = input("Enter 1 or 2 [default 1]: ").strip()
    except EOFError:
        choice = "1"
    
    headless = (choice != "2")
    
    # Refresh interval
    print("\n⏱️  How often should I check for new patients?")
    try:
        interval = input("Enter refresh interval in minutes [default 10]: ").strip()
    except EOFError:
        interval = ""
    
    try:
        refresh_minutes = int(interval) if interval else 10
        refresh_minutes = max(1, refresh_minutes)
    except ValueError:
        refresh_minutes = 10
    
    print(f"✅ Will check every {refresh_minutes} minute(s).\n")
    
    # Run checker
    checker = PediatricChecker(headless=headless, refresh_minutes=refresh_minutes)
    checker.run()


if __name__ == "__main__":
    main()
