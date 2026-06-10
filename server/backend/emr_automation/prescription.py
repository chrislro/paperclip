"""
Prescription handling for EMR Automation.

Contains prescription template processing, attestation handling,
and dosage calculations.

Supports both Selenium and Playwright backends.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any, Optional

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

from emr_automation.constants import (
    PrescriptionTemplate,
    SleepDurations,
    Locators,
    PlaywrightLocators,
    URLPatterns,
)
from emr_automation.utils import retry, safe_click, ask_yes_no

if TYPE_CHECKING:
    from emr_automation.core import EMRAutomation


class PrescriptionMixin:
    """
    Mixin class providing prescription-related functionality.

    This is designed to be mixed into EMRAutomation class.
    Provides methods for:
    - Prescription template processing
    - Attestation handling
    - Gastroenteritis and cold template shortcuts
    """

    def handle_prescription_template(
        self: "EMRAutomation",
        intern_id: str,
        template_type: str,
    ) -> bool:
        """
        Handle prescription template selection and processing.

        Args:
            intern_id: The patient's intern ID
            template_type: One of 'gastro1', 'gastro2', 'cold1', 'cold2'

        Returns:
            True if prescription was successfully processed, False otherwise
        """
        try:
            self.check_and_update_patient_info()
            if not self._validate_intern_id(intern_id):
                return False

            self.logger.info(f"Processing {template_type} for intern ID: {intern_id}")

            # Navigate to patient chart page, then click prescription button (AJAX dialog)
            # NOTE: Direct goto /receitaaltas/new returns empty body (AJAX-only endpoint).
            # Correct flow verified 2026-02-28: patient page -> click #link_new_receitaalta
            patient_url = URLPatterns.patient_chart_return_url(
                self.config['EMR']['base_url'], intern_id
            )
            self.logger.info(f"Navigating to patient chart: {patient_url}")

            timeout = int(self.config['Browser']['timeout'])

            if self._backend == "playwright":
                self.driver.goto(patient_url)
                self.driver.locator("body").wait_for(state="attached", timeout=timeout * 1000)
                self.driver.wait_for_timeout(2000)

                # Click prescription button (AJAX loads into #dialog_formularios)
                presc_btn = self.driver.locator("#link_new_receitaalta")
                presc_btn.wait_for(state="visible", timeout=timeout * 1000)
                presc_btn.click()
                self.driver.wait_for_timeout(2000)

                # Wait for dialog to populate
                dialog = self.driver.locator("#dialog_formularios")
                dialog.locator(self._locators.TEMPLATE_CHECKBOXES).first.wait_for(
                    state="attached", timeout=10000
                )
            else:
                self.driver.get(patient_url)
                WebDriverWait(self.driver, timeout).until(
                    EC.presence_of_element_located((By.TAG_NAME, "body"))
                )
                time.sleep(2)
                presc_btn = WebDriverWait(self.driver, timeout).until(
                    EC.element_to_be_clickable((By.ID, "link_new_receitaalta"))
                )
                presc_btn.click()
                time.sleep(2)
                WebDriverWait(self.driver, 10).until(
                    EC.presence_of_element_located(Locators.TEMPLATE_CHECKBOXES)
                )

            # Select "Utilizar padroes" radio (tiporec_0)
            self._select_normal_prescription_type()

            # Get template and select it
            try:
                template = PrescriptionTemplate.from_code(template_type)
            except ValueError:
                self.logger.error(f"Invalid template type: {template_type}")
                return False

            if not self._select_template_checkbox(template.display_name, template_id=template.checkbox_id):
                self.logger.error(f"Could not find template for {template_type}")
                return False

            # Submit the form
            if not self._submit_prescription_form():
                return False

            # Wait for prescription modification and print
            self._wait_for_prescription_and_print()

            # Ask about attestation
            if ask_yes_no("Atestado", "Deseja imprimir um atestado?"):
                self.handle_attestation(intern_id)

            # Process discharge
            success = self.process_discharge(intern_id)
            if success:
                self.logger.info(f"{template_type} process completed successfully")
                return True
            else:
                self.logger.error(f"Failed to complete discharge after {template_type}")
                return False

        except Exception as e:
            self.logger.error(f"Failed to process {template_type} for intern ID {intern_id}: {e}")
            self._save_error_screenshot(f"template_error_{template_type}")
            self._navigate_to_consultations()
            return False

    def _select_normal_prescription_type(self: "EMRAutomation") -> None:
        """Select the normal prescription type radio button."""
        if self._backend == "playwright":
            try:
                self.driver.locator(self._locators.PRESCRIPTION_TYPE_NORMAL).click()
                self.logger.info("Clicked normal prescription radio")
            except Exception:
                # Fallback to first radio button
                radios = self.driver.locator(self._locators.PRESCRIPTION_TYPE_RADIOS)
                if radios.count() > 0:
                    radios.first.evaluate("el => el.click()")
                    self.logger.info("Clicked first radio button as fallback")
        else:
            try:
                normal_radio = self.driver.find_element(*Locators.PRESCRIPTION_TYPE_NORMAL)
                normal_radio.click()
                self.logger.info("Clicked normal prescription radio")
            except Exception:
                # Fallback to first radio button
                radio_buttons = self.driver.find_elements(*Locators.PRESCRIPTION_TYPE_RADIOS)
                if radio_buttons:
                    self.driver.execute_script("arguments[0].click();", radio_buttons[0])
                    self.logger.info("Clicked first radio button as fallback")

    def _select_template_checkbox(
        self: "EMRAutomation",
        expected_text: str,
        template_id: Optional[str] = None
    ) -> bool:
        """
        Select a template checkbox by ID or label text (using fuzzy matching).

        Args:
            expected_text: The display text to search for in labels
            template_id: Optional specific ID (value attribute) of the checkbox

        Returns:
            True if template was selected, False otherwise
        """
        from emr_automation.utils import normalize_text

        if self._backend == "playwright":
            return self._select_template_checkbox_playwright(expected_text, template_id)
        else:
            return self._select_template_checkbox_selenium(expected_text, template_id)

    def _select_template_checkbox_playwright(
        self: "EMRAutomation",
        expected_text: str,
        template_id: Optional[str] = None
    ) -> bool:
        """Playwright implementation of template checkbox selection."""
        from emr_automation.utils import normalize_text

        # 1. Try by ID if provided (Most robust)
        if template_id:
            try:
                checkbox = self.driver.locator(f"input[value='{template_id}']")
                checkbox.scroll_into_view_if_needed()
                checkbox.evaluate("el => el.click()")
                self.logger.info(f"Clicked template by ID: {template_id}")
                return True
            except Exception:
                self.logger.debug(f"Template ID {template_id} not found, falling back to text.")

        # 2. Fuzzy Text Matching using Playwright
        try:
            labels = self.driver.locator("label").all()
            normalized_expected = normalize_text(expected_text)

            for label in labels:
                try:
                    label_text = label.text_content() or ""
                    if not label_text:
                        continue

                    norm_label = normalize_text(label_text)
                    if normalized_expected in norm_label:
                        label.scroll_into_view_if_needed()
                        label.evaluate("el => el.click()")
                        self.logger.info(f"Clicked template fuzzy match: '{label_text}'")
                        return True
                except Exception:
                    continue
        except Exception as e:
            self.logger.error(f"Error during fuzzy template search: {e}")

        # 3. Fallback to JS search
        script = f"""
            var labels = document.querySelectorAll('label');
            for (var i = 0; i < labels.length; i++) {{
                if (labels[i].textContent.includes('{expected_text}')) {{
                    labels[i].click();
                    return true;
                }}
            }}
            return false;
        """
        try:
            if self.driver.evaluate(f"() => {{ {script} }}"):
                self.logger.info("Clicked template using legacy JS search")
                return True
        except Exception:
            pass

        return False

    def _select_template_checkbox_selenium(
        self: "EMRAutomation",
        expected_text: str,
        template_id: Optional[str] = None
    ) -> bool:
        """Selenium implementation of template checkbox selection."""
        from emr_automation.utils import normalize_text

        # 1. Try by ID if provided (Most robust)
        if template_id:
            try:
                checkbox = self.driver.find_element(By.CSS_SELECTOR, f"input[value='{template_id}']")
                if safe_click(self.driver, checkbox, scroll_first=True, use_js=True):
                    self.logger.info(f"Clicked template by ID: {template_id}")
                    return True
            except Exception:
                self.logger.debug(f"Template ID {template_id} not found, falling back to text.")

        # 2. Fuzzy Text Matching
        try:
            labels = self.driver.find_elements(By.TAG_NAME, "label")
            normalized_expected = normalize_text(expected_text)
            candidates = []

            for label in labels:
                try:
                    label_text = label.text
                    if not label_text:
                        continue

                    norm_label = normalize_text(label_text)
                    if normalized_expected in norm_label:
                        candidates.append(label)
                except Exception:
                    continue

            if candidates:
                target_label = candidates[0]
                if safe_click(self.driver, target_label, scroll_first=True, use_js=True):
                    self.logger.info(f"Clicked template fuzzy match: '{target_label.text}'")
                    return True

        except Exception as e:
            self.logger.error(f"Error during fuzzy template search: {e}")

        # 3. Fallback to JS search
        script = f"""
            var labels = document.querySelectorAll('label');
            for (var i = 0; i < labels.length; i++) {{
                if (labels[i].textContent.includes('{expected_text}')) {{
                    labels[i].click();
                    return true;
                }}
            }}
            return false;
        """
        try:
            if self.driver.execute_script(script):
                self.logger.info("Clicked template using legacy JS search")
                return True
        except Exception:
            pass

        return False

    def _submit_prescription_form(self: "EMRAutomation") -> bool:
        """
        Find and click the save button for the prescription form.

        Returns:
            True if form was submitted, False otherwise
        """
        if self._backend == "playwright":
            for selector in self._locators.SAVE_BUTTON_STRATEGIES:
                try:
                    buttons = self.driver.locator(selector)
                    if buttons.count() > 0:
                        buttons.first.scroll_into_view_if_needed()
                        buttons.first.evaluate("el => el.click()")
                        self.logger.info("Clicked save button")
                        return True
                except Exception as e:
                    self.logger.debug(f"Save button lookup failed: {e}")
                    continue

            # Fallback: submit form directly
            try:
                self.driver.evaluate("() => document.querySelector('form').submit()")
                self.logger.info("Submitted form using JavaScript")
                return True
            except Exception as e:
                self.logger.error(f"Could not submit form: {e}")
                return False
        else:
            for by_method, selector in Locators.SAVE_BUTTON_STRATEGIES:
                try:
                    buttons = self.driver.find_elements(by_method, selector)
                    if buttons and safe_click(self.driver, buttons[0], scroll_first=True, use_js=True):
                        self.logger.info("Clicked save button")
                        return True
                except Exception as e:
                    self.logger.debug(f"Save button lookup failed: {e}")
                    continue

            # Fallback: submit form directly
            try:
                self.driver.execute_script("document.querySelector('form').submit();")
                self.logger.info("Submitted form using JavaScript")
                return True
            except Exception as e:
                self.logger.error(f"Could not submit form: {e}")
                return False

    def _wait_for_prescription_and_print(self: "EMRAutomation") -> None:
        """Wait for prescription to be ready and trigger print."""
        timeout = int(self.config['Browser']['timeout'])
        strategy_timeout = 5

        if self._backend == "playwright":
            # Wait for page to load
            try:
                self.driver.wait_for_function(
                    "() => window.location.href.includes('receitas') || document.body",
                    timeout=timeout * 1000
                )
            except Exception:
                pass

            # Give the page a moment to fully render
            time.sleep(SleepDurations.PAGE_LOAD)

            # Find and click print button
            for selector in self._locators.PRINT_BUTTON_STRATEGIES:
                try:
                    print_button = self.driver.locator(selector).first
                    print_button.wait_for(state="visible", timeout=strategy_timeout * 1000)
                    print_button.scroll_into_view_if_needed()
                    print_button.evaluate("el => el.click()")
                    self.logger.info("Prescription printed using: %s", selector)
                    return
                except PlaywrightTimeoutError:
                    self.logger.debug("Print button not found with: %s", selector)
                    continue
                except Exception as e:
                    self.logger.debug("Error with print button strategy %s: %s", selector, e)
                    continue

            # JavaScript print as last resort
            self.logger.warning("No print button found, attempting window.print()")
            try:
                self.driver.evaluate("() => window.print()")
                self.logger.info("Triggered print via JavaScript")
            except Exception as e:
                self.logger.error("Failed to trigger print: %s", e)
        else:
            # Selenium implementation
            WebDriverWait(self.driver, timeout).until(
                lambda drv: "receitas" in drv.current_url or drv.find_elements(By.TAG_NAME, "body")
            )

            # Give the page a moment to fully render
            time.sleep(SleepDurations.PAGE_LOAD)

            for by_method, selector in Locators.PRINT_BUTTON_STRATEGIES:
                try:
                    print_button = WebDriverWait(self.driver, strategy_timeout).until(
                        EC.element_to_be_clickable((by_method, selector))
                    )
                    if safe_click(self.driver, print_button, scroll_first=True, use_js=True):
                        self.logger.info("Prescription printed using: %s", selector)
                        return
                except (TimeoutException, NoSuchElementException):
                    self.logger.debug("Print button not found with: %s", selector)
                    continue
                except Exception as e:
                    self.logger.debug("Error with print button strategy %s: %s", selector, e)
                    continue

            # JavaScript print as last resort
            self.logger.warning("No print button found, attempting window.print()")
            try:
                self.driver.execute_script("window.print();")
                self.logger.info("Triggered print via JavaScript")
            except Exception as e:
                self.logger.error("Failed to trigger print: %s", e)

    def handle_attestation(self: "EMRAutomation", intern_id: str) -> bool:
        """
        Handle printing an attestation for a patient.

        Args:
            intern_id: The patient's intern ID

        Returns:
            True if attestation was printed, False otherwise
        """
        try:
            attestation_url = URLPatterns.attestation_url(
                self.config['EMR']['base_url'], intern_id
            )
            self.logger.info(f"Opening attestation page: {attestation_url}")
            timeout = int(self.config['Browser']['timeout'])

            if self._backend == "playwright":
                # Open new page for attestation
                new_page = self._context.new_page()
                new_page.goto(attestation_url)
                new_page.locator("body").wait_for(state="attached", timeout=timeout * 1000)

                # Print and close
                new_page.evaluate("() => window.print()")
                time.sleep(SleepDurations.PRINT_DIALOG)
                new_page.close()
            else:
                # Selenium: Open in new window
                self.driver.execute_script(f"window.open('{attestation_url}', '_blank');")
                self.driver.switch_to.window(self.driver.window_handles[-1])

                WebDriverWait(self.driver, timeout).until(
                    EC.presence_of_element_located((By.TAG_NAME, "body"))
                )

                # Print and close
                self.driver.execute_script("window.print();")
                time.sleep(SleepDurations.PRINT_DIALOG)
                self.driver.close()
                self.driver.switch_to.window(self.driver.window_handles[0])

            self.logger.info("Attestation processed successfully")
            return True

        except Exception as e:
            self.logger.error(f"Failed to process attestation: {e}")
            if self._backend != "playwright":
                try:
                    self.driver.switch_to.window(self.driver.window_handles[0])
                except Exception:
                    pass
            return False

    def handle_gastroenteritis(
        self: "EMRAutomation",
        intern_id: str,
        template_num: int = 1,
    ) -> bool:
        """
        Process gastroenteritis prescription for a patient.

        Args:
            intern_id: The patient's intern ID
            template_num: Template variant (1 or 2)

        Returns:
            True if processed successfully, False otherwise
        """
        self.logger.info(f"Processing gastroenteritis {template_num} for patient ID: {intern_id}")
        template_type = f'gastro{template_num}'
        return self.handle_prescription_template(intern_id, template_type)

    def handle_cold(
        self: "EMRAutomation",
        intern_id: str,
        template_num: int = 1,
    ) -> bool:
        """
        Process cold (resfriado) prescription for a patient.

        Args:
            intern_id: The patient's intern ID
            template_num: Template variant (1 or 2)

        Returns:
            True if processed successfully, False otherwise
        """
        self.logger.info(f"Processing cold {template_num} for patient ID: {intern_id}")
        template_type = f'cold{template_num}'
        return self.handle_prescription_template(intern_id, template_type)

    # Note: _navigate_to_consultations is defined in DischargeMixin to avoid duplication
