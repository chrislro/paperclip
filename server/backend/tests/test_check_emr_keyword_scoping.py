"""CHRA-2423 Bug 48 — pediatric keyword detection must be scoped to the category column.

check_for_pediatric_patients()'s keyword fallback matched PEDIATRIC_KEYWORDS against
the full joined row text. A keyword substring that bled in from an adjacent cell,
status text ('Chamando Consultório'), or an href path then false-positived an adult
row as pediatric, firing a spurious Telegram alert on the night-shift monitor. The
fix scopes the match to the priority-category column only ('Criança', 'RN',
'Lactente').

Ported from the sibling Pediatrics repo's 0aa73d6. The category-SCOPING is shared;
the keyword LIST is aligned with the sibling for pediatric coverage (Bug 66) but
still deliberately omits the ambiguous "menor"/"pediatria" terms (see PEDIATRIC_KEYWORDS
in check_emr.py). Tests the pure category helper behaviourally + a source guard that
the call site no longer matches the full row.
"""
import inspect

from emr_automation.check_emr import PediatricChecker

KW = PediatricChecker.PEDIATRIC_KEYWORDS


def test_pediatric_category_text_matches():
    assert PediatricChecker._category_has_pediatric_keyword("Criança", KW) is True
    assert PediatricChecker._category_has_pediatric_keyword("LACTENTE", KW) is True
    assert PediatricChecker._category_has_pediatric_keyword("Pediátrico", KW) is True


def test_newborn_and_infant_category_text_matches():
    """CHRA-2423 Bug 66 — the diverged copy's keyword list dropped the
    newborn/baby/infant terms the canonical Pediatrics repo carries. A patient
    whose category cell reads 'Recém-nascido'/'Bebê'/'Infantil' AND whose age is
    unparseable (AJAX-blank cell, the Bug 65 failure mode) reaches ONLY the
    keyword fallback — so the narrower list silently missed them. These terms are
    unambiguous in the category column and must match (accented + unaccented)."""
    assert PediatricChecker._category_has_pediatric_keyword("Recém-nascido", KW) is True
    assert PediatricChecker._category_has_pediatric_keyword("Recem-nascido", KW) is True
    assert PediatricChecker._category_has_pediatric_keyword("Bebê", KW) is True
    assert PediatricChecker._category_has_pediatric_keyword("Bebe", KW) is True
    assert PediatricChecker._category_has_pediatric_keyword("Infantil", KW) is True


def test_menor_acuity_label_does_not_false_positive():
    """CHRA-2423 Bug 66 guard — the sibling repo also lists 'menor', but porting
    it here would re-open the Bug 48 false-positive class: G-Hosp's triage-acuity
    label 'menor complexidade' on an ADULT row would match. 'menor' is therefore
    DELIBERATELY excluded; this test fails loudly if a future sync adds it back."""
    assert PediatricChecker._category_has_pediatric_keyword("Menor complexidade", KW) is False
    assert PediatricChecker._category_has_pediatric_keyword("Maior complexidade", KW) is False


def test_adult_or_noise_category_does_not_match():
    assert PediatricChecker._category_has_pediatric_keyword("Adulto", KW) is False
    assert PediatricChecker._category_has_pediatric_keyword("", KW) is False
    assert PediatricChecker._category_has_pediatric_keyword(None, KW) is False
    # Status text / adjacent-cell noise that used to bleed into the full-row match
    # cannot trigger detection when only the category cell is passed in.
    assert PediatricChecker._category_has_pediatric_keyword("Chamando Consultório 3", KW) is False
    assert PediatricChecker._category_has_pediatric_keyword("/pr/interns/42", KW) is False


def test_call_site_uses_category_column_not_full_row():
    # Source guard (regression direction): the keyword fallback must read the
    # category column via the helper, never the full joined row text.
    src = inspect.getsource(PediatricChecker.check_for_pediatric_patients)
    assert "row_text_lower" not in src, \
        "keyword fallback must not match against the full joined row text (Bug 48)"
    assert "_category_has_pediatric_keyword" in src, \
        "keyword fallback must use the category-scoped helper (Bug 48)"
