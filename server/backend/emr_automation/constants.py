"""
Constants and locators for EMR Automation.

Centralizes all magic strings, XPath selectors, and configuration defaults.
Supports both Selenium and Playwright backends.
"""

from enum import Enum
from typing import Tuple, Union

# Try to import selenium; fall back gracefully so constants stay importable without it.
try:
    from selenium.webdriver.common.by import By
    SELENIUM_AVAILABLE = True
except ImportError:
    By = None  # type: ignore
    SELENIUM_AVAILABLE = False


# ==============================================================================
# VERSION (imported from single source of truth)
# ==============================================================================
from emr_automation._version import __version__ as VERSION


# ==============================================================================
# LOCATOR TYPE ALIASES
# ==============================================================================
# Selenium uses (By, value) tuples, Playwright uses strings
SeleniumLocator = Tuple["By", str] if SELENIUM_AVAILABLE else Tuple[str, str]
PlaywrightSelector = str
DualLocator = Union[SeleniumLocator, PlaywrightSelector]


# ==============================================================================
# TIMEOUTS (seconds)
# ==============================================================================
class Timeouts:
    """Timeout constants for various operations."""
    DEFAULT = 15  # Reduced from 30 for faster failure detection
    ATENDIMENTO_MAX_WAIT = 120  # Reduced from 300 (2 min instead of 5)
    MANUAL_LOGIN_DEFAULT = 90  # Reduced from 120
    PRESCRIPTION_WAIT = 60  # Reduced from 600 (1 min instead of 10)


# ==============================================================================
# SLEEP DURATIONS (seconds)
# ==============================================================================
class SleepDurations:
    """
    Sleep durations for cases where WebDriverWait is not appropriate.
    These should be minimized and replaced with explicit waits where possible.
    """
    PAGE_LOAD = 2
    FORM_SUBMIT = 3
    BUTTON_CLICK = 1
    SCROLL_ANIMATION = 1
    PRINT_DIALOG = 2
    SUBPROCESS_STARTUP = 0.5
    CLIPBOARD_POLL = 0.5
    ATENDIMENTO_POLL = 1
    ERROR_RECOVERY = 2  # Wait after error before retry
    TIMER_UPDATE = 1    # Timer display update interval
    RELOGIN_WAIT = 30   # Wait after failed re-authentication


# ==============================================================================
# PRESCRIPTION TEMPLATES
# ==============================================================================
class PrescriptionTemplate(Enum):
    """Prescription template types with their codes and display names."""
    GASTRO1 = ("gastro1", "Gastroenterite 1", "1080", "1")
    GASTRO2 = ("gastro2", "Gastroenterite 2", "1081", "2")
    COLD1 = ("cold1", "Resfriado 6-2", "1083", "3")
    COLD2 = ("cold2", "Resfriado 2", "1082", "4")
    LARYNGITIS = ("croup", "Laringite/Crupe", None, "5")
    BRONCHOSPASM = ("bronchospasm", "Broncoespasmo/Sibilante", None, "6")
    UTI = ("uti", "ITU Baixa", None, "7")
    PHARYNGITIS = ("strep", "Faringite Bacteriana", None, "8")
    OMA = ("oma", "OMA (Otite Media Aguda)", None, "9")

    def __init__(
        self,
        code: str,
        display_name: str,
        checkbox_id: str = None,
        shortcut_key: str = None,
    ):
        self.code = code
        self.display_name = display_name
        self.checkbox_id = checkbox_id
        self.shortcut_key = shortcut_key

    @classmethod
    def from_code(cls, code: str) -> "PrescriptionTemplate":
        """Get template by code string."""
        legacy_aliases = {
            "laryngitis": "croup",
            "pharyngitis": "strep",
        }
        code = legacy_aliases.get(code, code)
        for template in cls:
            if template.code == code:
                return template
        raise ValueError(f"Unknown template code: {code}")


# ==============================================================================
# ELEMENT LOCATORS (Selenium format - legacy)
# ==============================================================================
class Locators:
    """XPath and CSS selectors for EMR elements (Selenium format)."""

    # Login page
    LOGIN_EMAIL = (By.ID, "email") if SELENIUM_AVAILABLE else ("id", "email")
    LOGIN_PASSWORD = (By.ID, "password") if SELENIUM_AVAILABLE else ("id", "password")
    LOGIN_SUBMIT = (By.NAME, "commit") if SELENIUM_AVAILABLE else ("name", "commit")
    LOGIN_SUCCESS_NOTICE = (By.ID, "notice") if SELENIUM_AVAILABLE else ("id", "notice")

    # Consultations page readiness indicators (in priority order).
    # G-HOSP removed the #aba tab navigation — the /prconsultas page now
    # renders patient tables directly.  These locators confirm the page loaded.
    if SELENIUM_AVAILABLE:
        ATENDIMENTO: list[Tuple[By, str]] = [
            (By.ID, 'div-lista'),
            (By.ID, 'lista_aguardando_atendimento'),
            (By.XPATH, '//*[@id="aba"]/ul/li[1]/a'),           # legacy fallback
            (By.LINK_TEXT, 'Atendimento'),                       # legacy fallback
            (By.CSS_SELECTOR, '#aba ul li:first-child a'),       # legacy fallback
        ]
    else:
        ATENDIMENTO = []

    # Patient info
    PATIENT_INFO = (By.XPATH, '//*[@id="paciente"]/div[2]/div/div[2]/p[1]') if SELENIUM_AVAILABLE else ("xpath", '//*[@id="paciente"]/div[2]/div/div[2]/p[1]')
    CHIEF_COMPLAINT = (By.XPATH, '//*[@id="div_amb_triagem"]/div[2]/div/p') if SELENIUM_AVAILABLE else ("xpath", '//*[@id="div_amb_triagem"]/div[2]/div/p')

    # Consultation iframe
    # G-Hosp uses either new_prconsulta (first evaluation) or edit_prconsulta (return/edit).
    CONSULTATION_IFRAME = (
        By.XPATH,
        "//form[starts-with(@id,'new_prconsulta') or starts-with(@id,'edit_prconsulta')]//iframe",
    ) if SELENIUM_AVAILABLE else (
        "xpath",
        "//form[starts-with(@id,'new_prconsulta') or starts-with(@id,'edit_prconsulta')]//iframe",
    )

    # Prescription page
    PRESCRIPTION_TYPE_NORMAL = (By.ID, "tiporec_0") if SELENIUM_AVAILABLE else ("id", "tiporec_0")
    PRESCRIPTION_TYPE_RADIOS = (By.CSS_SELECTOR, 'input[type="radio"][name="tiporec"]') if SELENIUM_AVAILABLE else ("css", 'input[type="radio"][name="tiporec"]')  # verified 2026-02-28
    TEMPLATE_CHECKBOXES = (By.CSS_SELECTOR, 'input[type="radio"][name="padraorec"]') if SELENIUM_AVAILABLE else ("css", 'input[type="radio"][name="padraorec"]')  # verified 2026-02-28

    # Save buttons (in priority order)
    if SELENIUM_AVAILABLE:
        SAVE_BUTTON_STRATEGIES: list[Tuple[By, str]] = [
            (By.XPATH, "//button[contains(text(), 'Inserir')]"),  # Prescription dialog button (verified 2026-02-28)
            (By.XPATH, "//input[@type='submit' and @value='Salvar']"),
            (By.XPATH, "//input[@type='submit']"),
            (By.XPATH, "//button[contains(text(), 'Salvar')]"),
            (By.XPATH, "//button[@type='submit']"),
        ]
    else:
        SAVE_BUTTON_STRATEGIES = []

    # Print buttons (in priority order)
    if SELENIUM_AVAILABLE:
        PRINT_BUTTON_STRATEGIES: list[Tuple[By, str]] = [
            (By.XPATH, "//a[contains(@class, 'print')]"),
            (By.XPATH, "//a[contains(@href, 'print')]"),
            (By.XPATH, "//a[contains(@onclick, 'print')]"),
            (By.XPATH, "//a[contains(text(), 'Imprimir')]"),
            (By.XPATH, "//button[contains(text(), 'Imprimir')]"),
        ]
    else:
        PRINT_BUTTON_STRATEGIES = []

    # Discharge page
    DISCHARGE_INSERT_BUTTON = (By.ID, "botao-inserir-alta") if SELENIUM_AVAILABLE else ("id", "botao-inserir-alta")

    # Today button strategies for datepicker
    if SELENIUM_AVAILABLE:
        TODAY_BUTTON_STRATEGIES: list[Tuple[By, str]] = [
            (By.CSS_SELECTOR, ".ui-datepicker-current"),
            (By.XPATH, "//button[contains(text(), 'Hoje')]"),
            (By.XPATH, '//*[@id="ui-datepicker-div"]//button[contains(@class, "ui-datepicker-current")]'),
            (By.XPATH, '//*[@id="ui-datepicker-div"]/div[2]/button[1]'),
            (By.CSS_SELECTOR, "#ui-datepicker-div .ui-datepicker-buttonpane button:first-child"),
        ]
    else:
        TODAY_BUTTON_STRATEGIES = []


# ==============================================================================
# ELEMENT LOCATORS (Playwright format - new)
# ==============================================================================
class PlaywrightLocators:
    """Playwright-compatible string selectors for EMR elements."""

    # Login page
    LOGIN_EMAIL = "#email"
    LOGIN_PASSWORD = "#password"
    LOGIN_SUBMIT = "[name='commit']"
    LOGIN_SUCCESS_NOTICE = "#notice"

    # Consultations page readiness indicators (in priority order).
    # G-HOSP removed the #aba tab — /prconsultas renders tables directly.
    ATENDIMENTO = [
        "#div-lista",
        "#lista_aguardando_atendimento",
        "xpath=//*[@id='aba']/ul/li[1]/a",       # legacy fallback
        "text=Atendimento",                        # legacy fallback
        "#aba ul li:first-child a",                # legacy fallback
    ]

    # Patient info
    PATIENT_INFO = "xpath=//*[@id='paciente']/div[2]/div/div[2]/p[1]"
    CHIEF_COMPLAINT = "xpath=//*[@id='div_amb_triagem']/div[2]/div/p"

    # Consultation iframe
    # G-Hosp uses either new_prconsulta (first evaluation) or edit_prconsulta (return/edit).
    CONSULTATION_IFRAME = "xpath=//form[starts-with(@id,'new_prconsulta') or starts-with(@id,'edit_prconsulta')]//iframe"

    # Prescription page
    PRESCRIPTION_TYPE_NORMAL = "#tiporec_0"
    PRESCRIPTION_TYPE_RADIOS = "input[type='radio'][name='tiporec']"  # verified 2026-02-28
    TEMPLATE_CHECKBOXES = "input[type='radio'][name='padraorec']"  # verified 2026-02-28
    PRESCRIPTION_DIALOG = "#dialog_formularios"  # AJAX dialog loaded by #link_new_receitaalta
    PRESCRIPTION_SUBMIT = "button:text('Inserir')"  # Submit button inside dialog form
    PRESCRIPTION_TYPE_TEMPLATE = "#tiporec_0"  # 'Utilizar padroes' radio
    PRESCRIPTION_TYPE_SIMPLES = "#tiporec_1"   # SIMPLES radio (regular prescription)

    # Save buttons (in priority order)
    SAVE_BUTTON_STRATEGIES = [
        "button:has-text('Inserir')",  # Prescription dialog button (verified 2026-02-28)
        "input[type='submit'][value='Salvar']",
        "input[type='submit']",
        "button:has-text('Salvar')",
        "button[type='submit']",
    ]

    # Print buttons (in priority order)
    PRINT_BUTTON_STRATEGIES = [
        "a.print, a[class*='print']",
        "a[href*='print']",
        "a[onclick*='print']",
        "a:has-text('Imprimir')",
        "button:has-text('Imprimir')",
    ]

    # Discharge page
    DISCHARGE_INSERT_BUTTON = "#botao-inserir-alta"

    # Today button strategies for datepicker
    TODAY_BUTTON_STRATEGIES = [
        ".ui-datepicker-current",
        "button:has-text('Hoje')",
        "#ui-datepicker-div button.ui-datepicker-current",
        "#ui-datepicker-div .ui-datepicker-buttonpane button:first-child",
    ]


def get_locators(use_playwright: bool = False):
    """
    Get the appropriate locators class based on backend.

    Args:
        use_playwright: If True, return PlaywrightLocators, else Locators

    Returns:
        Locators class (PlaywrightLocators or Locators)
    """
    return PlaywrightLocators if use_playwright else Locators


# ==============================================================================
# URL PATTERNS
# ==============================================================================
class URLPatterns:
    """URL patterns for navigation and detection."""
    LOGIN_PATH = "/users/sign_in"
    CONSULTATIONS_PATH = "/prconsultas"
    DASHBOARD_PATH = "/dashboard"
    HOME_PATH = "/home"
    
    POST_LOGIN_PATHS = ["/prconsultas", "/dashboard", "/home"]
    
    @staticmethod
    def login_url(base_url: str) -> str:
        return f"{base_url}{URLPatterns.LOGIN_PATH}"
    
    @staticmethod
    def consultations_url(base_url: str) -> str:
        return f"{base_url}{URLPatterns.CONSULTATIONS_PATH}"
    
    @staticmethod
    def patient_chart_url(base_url: str, intern_id: str) -> str:
        return f"{base_url}/amb/interns?intern_id={intern_id}&primeira_avaliacao=true"
    
    @staticmethod
    def new_prescription_url(base_url: str, intern_id: str) -> str:
        return f"{base_url}/amb/interns/{intern_id}/receitaaltas/new"  # FIXED: /pr/receitas/new returns 404
    
    @staticmethod
    def attestation_url(base_url: str, intern_id: str) -> str:
        return f"{base_url}/pr/presatestados/new?intern_id={intern_id}"
    
    @staticmethod
    def medication_url(base_url: str, intern_id: str) -> str:
        return f"{base_url}/rcfichas/{intern_id}?tipo=5"  # FIXED: /ver_fichas URL changed
    
    @staticmethod
    def discharge_url(base_url: str, intern_id: str) -> str:
        return f"{base_url}/pr/altas?intern_id={intern_id}"

    @staticmethod
    def discharge_new_url(base_url: str, intern_id: str) -> str:
        """Create new discharge record (via botao-inserir-alta). Verified 2026-02-28."""
        return f"{base_url}/pr/altas/new?intern_id={intern_id}"

    @staticmethod
    def patient_chart_return_url(base_url: str, intern_id: str) -> str:
        """Patient chart for return/edit visit (no primeira_avaliacao param)."""
        return f"{base_url}/amb/interns?intern_id={intern_id}"



# ==============================================================================
# DEFAULT CONFIGURATION
# ==============================================================================
DEFAULT_CONFIG = {
    'EMR': {
        'base_url': 'https://prbentogoncalves.g-hosp.com.br',
        'username': '',
        'password': '',
    },
    'Browser': {
        'timeout': '30',
        'headless': 'False',
        'chromedriver_path': '',
        'disable_ssl_verify': 'False',
        'manual_login_timeout': str(Timeouts.MANUAL_LOGIN_DEFAULT),
        'use_playwright': 'True',  # Default to Playwright; Selenium is optional
    },
    'Dosages': {
        'amoxicillin_strep_dose': '50',
        'amoxicillin_strep_max': '1000',
        'amoxicillin_pneumonia_dose': '90',
        'amoxicillin_pneumonia_max': '4000',
        'cephalexin_dose': '50',
        'cephalexin_max': '2000',
        'concentration': '50',
        'ibuprofen_dose_per_kg': '10',
        'ibuprofen_max_per_dose': '400',
        'ibuprofen_concentration': '50',
        'dipyrone_dose_per_kg': '15',
        'dipyrone_max_per_dose': '1000',
        'dipyrone_concentration': '500',  # Dipirona gotas (500 mg/mL)
        'prednisolone_dose_per_kg': '1.5',
        'prednisolone_max_per_day': '40',
        'prednisolone_concentration': '3',
        'cetirizine_dose_per_kg': '0.25',
        'cetirizine_max_per_day': '10',
        'cetirizine_concentration': '1',
        'azithromycin_dose_per_kg': '10',
        'azithromycin_max_per_day': '500',
        'azithromycin_duration_days': '3',
        'azithromycin_concentration': '40',
    },
    'OpenAI': {
        'oauth_access_token': '',
        'oauth_client_id': '',
        'oauth_client_secret': '',
        'oauth_token_url': '',
        'oauth_scopes': '',
        'oauth_audience': '',
        'base_url': '',
    },
    'ExternalScripts': {
        'audio_to_note_script': '../Whisper Scripts/scripts/audio_to_note.py',
    },
    'Reliability': {
        'max_retries': '3',
        'retry_delay': '1',
    },
}


# ==============================================================================
# ADDITIONAL SELECTORS (live-verified 2026-02-28)
# ==============================================================================
# Consultation form selector handles both new and edit (return visit)
SOAP_FORM_SELECTOR = 'form[id^="new_prconsulta"], form[id^="edit_prconsulta"]'
PRESCRIPTION_BTN_ID = 'link_new_receitaalta'   # data-remote AJAX -> dialog_formularios
PRESCRIPTION_DIALOG_ID = 'dialog_formularios'
DISCHARGE_INSERT_BTN_ID = 'botao-inserir-alta'

# NOTE: Subjetivo SOAP field may be pre-populated by G-Hosp from patient history.
# audio-to-note.py output should APPEND (not overwrite) when content exists.
# Check field value length before writing.


# ==============================================================================
# DEFAULT PRESCRIPTION SHORTCUTS (server-side mirror of JS defaults)
# ==============================================================================
# Seeded into UserConfig.rx_templates on first GET /api/me/config for a new user.
# Shape mirrors sidepanel/popup smart medication shortcuts so the side panel can
# render a server-hydrated row without any shape translation.
#
# Tuple (immutable) — route handlers must deep-copy when seeding so nested meds
# lists are not shared across rows.
DEFAULT_RX_TEMPLATES = (
    {
        "id": "tpl_default_0",
        "diagnosis": "Paracetamol",
        "ageBand": "",
        "body": "",
        "frequency": 0,
        "meds": [
            {"medId": "paracetamol", "dose": "", "freq": "", "duration": "", "when": "se dor ou febre", "notes": ""},
            {"medId": "paracetamol_adult", "dose": "", "freq": "", "duration": "", "when": "se dor ou febre", "notes": ""},
        ],
        "extraText": "",
    },
    {
        "id": "tpl_default_1",
        "diagnosis": "Ibuprofeno",
        "ageBand": "",
        "body": "",
        "frequency": 0,
        "meds": [
            {"medId": "ibuprofen", "dose": "", "freq": "", "duration": "", "when": "se dor ou febre", "notes": ""},
            {"medId": "ibuprofen_adult", "dose": "", "freq": "", "duration": "", "when": "se dor ou febre", "notes": ""},
        ],
        "extraText": "",
    },
    {
        "id": "tpl_default_2",
        "diagnosis": "Amoxicilina",
        "ageBand": "",
        "body": "",
        "frequency": 0,
        "meds": [
            {"medId": "amox_pneum", "dose": "", "freq": "", "duration": "", "when": "", "notes": ""},
            {"medId": "amox_adult", "dose": "", "freq": "", "duration": "", "when": "", "notes": ""},
        ],
        "extraText": "",
    },
    {
        "id": "tpl_default_3",
        "diagnosis": "Dor de Garganta",
        "ageBand": "",
        "body": "",
        "frequency": 0,
        "meds": [
            {"medId": "amox_pneum", "dose": "", "freq": "", "duration": "7 dias", "when": "", "notes": ""},
            {"medId": "paracetamol", "dose": "", "freq": "", "duration": "", "when": "se dor ou febre", "notes": ""},
            {"medId": "desloratadine_adult", "dose": "", "freq": "", "duration": "", "when": "", "notes": ""},
            {"medId": "ibuprofen", "dose": "", "freq": "", "duration": "", "when": "se dor ou febre", "notes": ""},
        ],
        "extraText": "Retornar em 7 dias se não houver melhora.",
    },
)
