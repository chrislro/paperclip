"""CHRA-2423 Bug 71 — every DEFAULT_RX_TEMPLATES medId must exist in the dosage catalog.

DEFAULT_RX_TEMPLATES (emr_automation/constants.py) is seeded into EVERY new user's
config server-side (_get_or_seed_user_config). At prescription apply-time the side
panel resolves each `medId` against the /api/dosages catalog (PEDIATRIC_MEDICATIONS
∪ ADULT_MEDICATIONS) via _findMedInCatalog — an exact `id` match across both arrays.
An unmatched medId renders the literal placeholder
"[Medicação <id> não encontrada — atualize o catálogo]" in the prescription.

Bug 71: the seeded "Dor de Garganta" template referenced `desloratadine`, but the
catalog only has `desloratadine_ped` / `desloratadine_adult` — so every user's
default sore-throat prescription rendered that broken placeholder where the
antihistamine line should be. Fixed to `desloratadine_adult` (the entry the popup
catalog labels "Desloratadina 5mg", is_adult=true — preserving the template
author's selection).

This test is the parity tripwire: it fails if any seeded-template medId is absent
from the catalog (the failure mode above), preventing the drift from recurring.
"""
from emr_automation.constants import DEFAULT_RX_TEMPLATES
from emr_automation.dashboard.routes import PEDIATRIC_MEDICATIONS, ADULT_MEDICATIONS


def _catalog_ids():
    ids = set()
    for med in list(PEDIATRIC_MEDICATIONS) + list(ADULT_MEDICATIONS):
        mid = med.get("id")
        if mid:
            ids.add(mid)
    return ids


def _template_med_ids():
    refs = []  # (template diagnosis, medId)
    for tpl in DEFAULT_RX_TEMPLATES:
        for med in tpl.get("meds", []) or []:
            mid = (med.get("medId") or "").strip()
            if mid:
                refs.append((tpl.get("diagnosis", "?"), mid))
    return refs


def test_every_default_template_med_id_resolves_in_catalog():
    catalog = _catalog_ids()
    refs = _template_med_ids()
    assert refs, "DEFAULT_RX_TEMPLATES should reference at least one medId"
    missing = [(diag, mid) for (diag, mid) in refs if mid not in catalog]
    assert missing == [], (
        "these seeded-template medIds are absent from the dosage catalog and would "
        "render '[Medicação <id> não encontrada]' at apply-time: "
        + ", ".join(f"{mid} (template '{diag}')" for diag, mid in missing)
    )


def test_desloratadine_adult_is_the_resolved_id_not_bare_desloratadine():
    """Regression-locks the exact Bug 71 fix: the sore-throat template must use the
    catalog id `desloratadine_adult`, never the non-existent bare `desloratadine`."""
    refs = {mid for _, mid in _template_med_ids()}
    assert "desloratadine" not in refs, "bare 'desloratadine' is not a catalog id (Bug 71)"
    assert "desloratadine_adult" in refs, "the sore-throat template should reference desloratadine_adult"
    assert "desloratadine_adult" in _catalog_ids()
