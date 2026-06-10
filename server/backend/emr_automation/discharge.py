"""
Discharge and medication handling for EMR Automation.

Supports both Selenium and Playwright backends.
"""

from __future__ import annotations

import time
from datetime import datetime
from typing import TYPE_CHECKING, Optional

# Conditional Selenium imports
try:
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.common.exceptions import TimeoutException, NoSuchElementException
    SELENIUM_AVAILABLE = True
except ImportError:
    By = None  # type: ignore
    WebDriverWait = None  # type: ignore
    EC = None  # type: ignore
    TimeoutException = Exception  # type: ignore
    NoSuchElementException = Exception  # type: ignore
    SELENIUM_AVAILABLE = False

# Conditional Playwright imports
try:
    from playwright._impl._errors import TimeoutError as PlaywrightTimeoutError
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PlaywrightTimeoutError = Exception  # type: ignore
    PLAYWRIGHT_AVAILABLE = False

from emr_automation.constants import SleepDurations, Locators, PlaywrightLocators, URLPatterns
from emr_automation.utils import retry, safe_click, show_message

if TYPE_CHECKING:
    from emr_automation.core import EMRAutomation


class DischargeMixin:
    """
    Mixin class providing discharge and medication functionality.

    This is designed to be mixed into EMRAutomation class.
    Provides methods for:
    - Patient discharge processing
    - Medication page printing
    """

    @retry(max_tries=3, delay_seconds=1)
    def process_discharge(self: "EMRAutomation", intern_id: str) -> bool:
        """
        Process discharge for a given intern ID.

        Args:
            intern_id: The patient's intern ID

        Returns:
            True if discharge was processed successfully, False otherwise
        """
        try:
            self.check_and_update_patient_info()
            if not self._validate_intern_id(intern_id):
                return False

            self.logger.info(f"Processing discharge for intern ID: {intern_id}")
            timeout = int(self.config['Browser']['timeout'])

            # Navigate to discharge page
            discharge_url = URLPatterns.discharge_url(self.config['EMR']['base_url'], intern_id)

            if self._backend == "playwright":
                self.driver.goto(discharge_url)
                self.driver.locator("body").wait_for(state="attached", timeout=timeout * 1000)
                self.logger.info("Discharge page loaded")

                # Click "Inserir Alta" button
                discharge_button = self.driver.locator(self._locators.DISCHARGE_INSERT_BUTTON)
                discharge_button.wait_for(state="visible", timeout=timeout * 1000)
                discharge_button.click()
                self.logger.info("Clicked on 'Inserir Alta' button")
            else:
                self.driver.get(discharge_url)
                WebDriverWait(self.driver, timeout).until(
                    EC.presence_of_element_located((By.TAG_NAME, "body"))
                )
                self.logger.info("Discharge page loaded")

                # Click "Inserir Alta" button
                discharge_button = WebDriverWait(self.driver, timeout).until(
                    EC.element_to_be_clickable(Locators.DISCHARGE_INSERT_BUTTON)
                )
                discharge_button.click()
                self.logger.info("Clicked on 'Inserir Alta' button")

            time.sleep(SleepDurations.BUTTON_CLICK)

            # Click "Hoje" (Today) button
            if not self._click_today_button():
                raise NoSuchElementException("'Hoje' button not found")

            time.sleep(SleepDurations.BUTTON_CLICK)

            # Click save button
            if not self._click_discharge_save_button(intern_id):
                raise NoSuchElementException("'Salvar' button not found")

            # Wait for save to complete
            self._wait_for_discharge_save()

            # Return to consultations and wait
            consultations_url = URLPatterns.consultations_url(self.config['EMR']['base_url'])
            if self._backend == "playwright":
                self.driver.goto(consultations_url)
            else:
                self.driver.get(consultations_url)
            self.wait_for_atendimento()

            self.logger.info("Discharge completed successfully")
            return True

        except Exception as e:
            self.logger.error(f"Failed to process discharge for intern ID {intern_id}: {e}")
            self._save_discharge_screenshot(intern_id)
            self._navigate_to_consultations()
            return False

    def _click_today_button(self: "EMRAutomation") -> bool:
        """
        Find and click the 'Hoje' (Today) button in date picker.

        Returns:
            True if button was clicked, False otherwise
        """
        js_search_script = """
            var buttons = document.querySelectorAll('.ui-datepicker-current, button');
            for (var btn of buttons) {
                if (btn.textContent.includes('Hoje') || btn.classList.contains('ui-datepicker-current')) {
                    btn.click();
                    return true;
                }
            }
            return false;
        """

        if self._backend == "playwright":
            for selector in self._locators.TODAY_BUTTON_STRATEGIES:
                try:
                    today_button = self.driver.locator(selector).first
                    today_button.wait_for(state="visible", timeout=5000)
                    time.sleep(0.3)  # Brief stabilization delay

                    # Try native click first, then JS fallback
                    try:
                        today_button.click()
                    except Exception:
                        today_button.evaluate("el => el.click()")

                    self.logger.info(f"Found 'Hoje' button using: {selector}")
                    return True
                except PlaywrightTimeoutError:
                    continue
                except Exception:
                    continue

            # Last resort: JavaScript search
            try:
                clicked = self.driver.evaluate(f"() => {{ {js_search_script} }}")
                if clicked:
                    self.logger.info("Found 'Hoje' button using JavaScript search")
                    return True
            except Exception:
                pass
        else:
            for by_method, locator in Locators.TODAY_BUTTON_STRATEGIES:
                try:
                    today_button = WebDriverWait(self.driver, 5).until(
                        EC.element_to_be_clickable((by_method, locator))
                    )
                    time.sleep(0.3)  # Brief stabilization delay

                    # Try native click first, then JS fallback
                    try:
                        today_button.click()
                    except Exception:
                        self.driver.execute_script("arguments[0].click();", today_button)

                    self.logger.info(f"Found 'Hoje' button using: {by_method} - {locator}")
                    return True
                except (TimeoutException, NoSuchElementException):
                    continue

            # Last resort: JavaScript search
            try:
                clicked = self.driver.execute_script(js_search_script)
                if clicked:
                    self.logger.info("Found 'Hoje' button using JavaScript search")
                    return True
            except Exception:
                pass

        self.logger.error("Could not find 'Hoje' button in date picker")
        return False

    def _click_discharge_save_button(self: "EMRAutomation", intern_id: str) -> bool:
        """
        Find and click the save button for discharge form.

        Args:
            intern_id: Patient's intern ID for form element lookup

        Returns:
            True if button was clicked, False otherwise
        """
        # Playwright-style selectors
        playwright_strategies = [
            f'#new_alta_{intern_id} button[type="submit"]',
            f'#new_alta_{intern_id} button:has-text("Salvar")',
            f'#new_alta_{intern_id} .btn-primary, #new_alta_{intern_id} .btn-success',
            f'xpath=//*[@id="new_alta_{intern_id}"]/div[4]/button',
            f'xpath=//*[@id="new_alta_{intern_id}"]/div[3]/button',
            f'#new_alta_{intern_id} button:last-of-type',
        ]

        # Selenium-style locators
        selenium_strategies = [
            (By.CSS_SELECTOR, f'#new_alta_{intern_id} button[type="submit"]'),
            (By.XPATH, f'//*[@id="new_alta_{intern_id}"]//button[contains(text(), "Salvar")]'),
            (By.CSS_SELECTOR, f'#new_alta_{intern_id} .btn-primary, #new_alta_{intern_id} .btn-success'),
            (By.XPATH, f'//*[@id="new_alta_{intern_id}"]/div[4]/button'),
            (By.XPATH, f'//*[@id="new_alta_{intern_id}"]/div[3]/button'),
            (By.CSS_SELECTOR, f'#new_alta_{intern_id} button:last-of-type'),
        ] if SELENIUM_AVAILABLE else []

        if self._backend == "playwright":
            for selector in playwright_strategies:
                try:
                    save_button = self.driver.locator(selector).first
                    save_button.wait_for(state="visible", timeout=5000)
                    save_button.scroll_into_view_if_needed()
                    save_button.click()
                    self.logger.info(f"Found 'Salvar' button using: {selector}")
                    return True
                except PlaywrightTimeoutError:
                    continue
                except Exception:
                    continue
        else:
            for by_method, locator in selenium_strategies:
                try:
                    save_button = WebDriverWait(self.driver, 5).until(
                        EC.element_to_be_clickable((by_method, locator))
                    )
                    if safe_click(self.driver, save_button, scroll_first=True):
                        self.logger.info(f"Found 'Salvar' button using: {by_method} - {locator}")
                        return True
                except (TimeoutException, NoSuchElementException):
                    continue

        self.logger.error("Could not find 'Salvar' button")
        return False

    def _wait_for_discharge_save(self: "EMRAutomation") -> None:
        """Wait for discharge save to complete."""
        timeout = int(self.config['Browser']['timeout'])

        if self._backend == "playwright":
            original_url = self.driver.url
            try:
                self.driver.wait_for_function(
                    f"""() => {{
                        return document.querySelector('.alert-success, .notice, .flash-success') ||
                               window.location.href !== '{original_url}' ||
                               document.getElementById('botao-inserir-alta');
                    }}""",
                    timeout=timeout * 1000
                )
                self.logger.info("Save completed - detected state change")
            except PlaywrightTimeoutError:
                self.logger.warning("Timeout waiting for save confirmation, proceeding anyway")
        else:
            original_url = self.driver.current_url
            try:
                WebDriverWait(self.driver, timeout).until(
                    lambda drv: (
                        drv.find_elements(By.CSS_SELECTOR, ".alert-success, .notice, .flash-success") or
                        drv.current_url != original_url or
                        drv.find_elements(By.ID, "botao-inserir-alta")
                    )
                )
                self.logger.info("Save completed - detected state change")
            except TimeoutException:
                self.logger.warning("Timeout waiting for save confirmation, proceeding anyway")

    def _save_discharge_screenshot(self: "EMRAutomation", intern_id: str) -> None:
        """
        Save screenshot for discharge debugging.

        Args:
            intern_id: Patient's intern ID for filename
        """
        try:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            screenshot_path = f"logs/discharge_error_{intern_id}_{timestamp}.png"
            if self._backend == "playwright":
                self.driver.screenshot(path=screenshot_path)
            else:
                self.driver.save_screenshot(screenshot_path)
            self.logger.info(f"Screenshot saved to {screenshot_path}")
        except Exception as e:
            self.logger.debug(f"Could not save screenshot: {e}")

    @retry(max_tries=3, delay_seconds=1)
    def process_medication(self: "EMRAutomation", intern_id: str) -> bool:
        """
        Process medication for a given intern ID.

        Args:
            intern_id: The patient's intern ID

        Returns:
            True if medication was processed successfully, False otherwise
        """
        try:
            self.check_and_update_patient_info()
            if not self._validate_intern_id(intern_id):
                return False

            self.logger.info(f"Processing medication for intern ID: {intern_id}")
            timeout = int(self.config['Browser']['timeout'])

            # Navigate to medication page
            medication_url = URLPatterns.medication_url(self.config['EMR']['base_url'], intern_id)

            if self._backend == "playwright":
                self.driver.goto(medication_url)
                self.driver.locator("body").wait_for(state="attached", timeout=timeout * 1000)
            else:
                self.driver.get(medication_url)
                WebDriverWait(self.driver, timeout).until(
                    EC.presence_of_element_located((By.TAG_NAME, "body"))
                )

            self.logger.info("Medication page loaded successfully")

            # Print the page
            self._print_medication_page()

            # Return to consultations
            consultations_url = URLPatterns.consultations_url(self.config['EMR']['base_url'])
            if self._backend == "playwright":
                self.driver.goto(consultations_url)
            else:
                self.driver.get(consultations_url)
            self.wait_for_atendimento()

            self.logger.info("Medication processed successfully")
            return True

        except Exception as e:
            self.logger.error(f"Failed to process medication for intern ID {intern_id}: {e}")
            self._navigate_to_consultations()
            return False

    def _print_medication_page(self: "EMRAutomation") -> None:
        """Print the medication page."""
        print_styles_script = """
            var style = document.createElement('style');
            style.type = 'text/css';
            style.innerHTML = `
                @media print {
                    body {
                        -webkit-print-color-adjust: exact;
                        print-color-adjust: exact;
                    }
                    @page { size: A4; margin: 1cm; }
                }
            `;
            document.head.appendChild(style);
        """

        try:
            if self._backend == "playwright":
                # Inject print styles
                self.driver.evaluate(f"() => {{ {print_styles_script} }}")
                time.sleep(SleepDurations.BUTTON_CLICK)

                # Trigger print
                self.driver.evaluate("() => window.print()")
                time.sleep(SleepDurations.PRINT_DIALOG)
            else:
                # Inject print styles
                self.driver.execute_script(print_styles_script)
                self.driver.switch_to.window(self.driver.current_window_handle)
                time.sleep(SleepDurations.BUTTON_CLICK)

                # Trigger print
                self.driver.execute_script("window.print();")
                time.sleep(SleepDurations.PRINT_DIALOG)

            self.logger.info("Print command executed successfully")

        except Exception as e:
            self.logger.error(f"Print failed: {e}")
            show_message("Erro", "Falha ao imprimir. Por favor, tente imprimir manualmente.", level="error")

    def _navigate_to_consultations(self: "EMRAutomation") -> None:
        """Navigate back to the consultations page."""
        try:
            consultations_url = URLPatterns.consultations_url(self.config['EMR']['base_url'])
            if self._backend == "playwright":
                self.driver.goto(consultations_url)
            else:
                self.driver.get(consultations_url)
        except Exception as e:
            self.logger.debug(f"Failed to navigate back to consultations: {e}")
