"""CHRA-2423 Bug 67 — age extraction must also handle non-parenthesized ages.

`_extract_age_years` is the PRIMARY pediatric-detection path (the keyword fallback
in Bug 66 only runs when age is unparseable). The extension's diverged copy carried
only `_AGE_PATTERN_PAREN`, so a G-Hosp view that renders the age WITHOUT parentheses
("5 anos", "11 meses", "3 dias") produced no age → the patient could only be caught
by the keyword fallback. The canonical Pediatrics repo already had a free-form
fallback; this aligns the extension with it.

The free-form pattern is double-guarded against timestamp false-positives
("há 9 min" must NOT be read as 9 months): the regex needs a trailing boundary AND
the match must contain the SPELLED-OUT unit (ano/mes/dia). Both directions are
tested below.
"""
from emr_automation.check_emr import PediatricChecker

_extract = PediatricChecker._extract_age_years


def _approx(got, expected):
    return got is not None and abs(got - expected) < 1e-6


def test_parenthesized_ages_still_parse():
    # Regression: the rename _AGE_PATTERN → _AGE_PATTERN_PAREN must not change behaviour.
    assert _approx(_extract("(5a 3m )"), 5 + 3 / 12.0)
    assert _approx(_extract("(11m )"), 11 / 12.0)
    assert _approx(_extract("(23d )"), 23 / 365.0)
    assert _approx(_extract("GABRIEL MAX (22a 2m)"), 22 + 2 / 12.0)


def test_free_form_ages_now_parse():
    # Bug 67: ages without parentheses, spelled-out unit present. Fails pre-fix.
    assert _approx(_extract("JOAO SILVA 5 anos"), 5.0)
    assert _approx(_extract("MARIA 11 meses"), 11 / 12.0)
    assert _approx(_extract("RN 3 dias"), 3 / 365.0)


def test_timestamp_is_not_misread_as_age():
    """Critical false-positive guard. 'há 9 min' must stay None — a triage queue
    shows wait times next to patients, and misreading '9 min' as a 9-month-old
    would fire a spurious pediatric alert on an adult. A bare unit letter without
    the spelled-out word is also rejected."""
    assert _extract("Chamando Consultorio, ha 9 min") is None
    assert _extract("status 9 m de espera") is None  # bare 'm', no 'mes'
    assert _extract("sem idade aqui") is None
    assert _extract("") is None


def test_paren_takes_priority_over_free_form():
    # When both shapes are present the parenthesized one wins (it is the canonical
    # EMR rendering); the free-form loop is only a fallback.
    assert _approx(_extract("PACIENTE (2a ) atendido 5 anos atras"), 2.0)
