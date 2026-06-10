"""CHRA-2423 Bug 46 — weight_based_doses LIQUIDS must report an administrable mL volume.

`_calculate_full_dosages()`'s `weight_based_doses` branch set per_dose_ml /
per_dose_drops to None unconditionally, so the four fixed-dose oral liquids that
carry a `concentration` (loratadina, desloratadine, ondansetrona, sulfato_zinco)
showed only the mg dose with no mL — forcing a manual mg→mL conversion at the
bedside, the exact error this dosing tool exists to remove. The standard-dose
branch already derives mL from concentration; this asserts the fixed-dose branch
does too, while NOT inventing a volume for fixed-UNIT presentations (benzetacil).

Same bug-class as the sibling Pediatrics repo's CHRA-1591 fix (d7ba07e), which was
never ported to this shipping backend until Bug 46. Behavioural test: calls the
pure dosing function directly, so it fails against the pre-fix code (per_dose_ml
was None for the liquids).
"""
from emr_automation.dashboard.routes import _calculate_full_dosages


def _by_id(rows, med_id):
    return next((r for r in rows if r["id"] == med_id), None)


def test_weight_based_liquids_report_ml_volume():
    rows = _calculate_full_dosages(15.0)  # 15 kg reference child

    # med_id -> expected per_dose_ml at 15 kg (dose_mg / concentration).
    expected_ml = {
        "loratadina_ped": 5.0,      # 5mg   / 1.0 mg/mL
        "desloratadine_ped": 2.5,   # 1.25mg / 0.5 mg/mL
        "ondansetrona_ped": 5.0,    # 4mg   / 0.8 mg/mL
        "sulfato_zinco_ped": 5.0,   # 20mg  / 4.0 mg/mL
    }
    for med_id, ml in expected_ml.items():
        row = _by_id(rows, med_id)
        assert row is not None, f"{med_id} missing from dosage output"
        assert row["per_dose_ml"] == ml, (
            f"{med_id}: expected per_dose_ml={ml} (liquid with a concentration), "
            f"got {row['per_dose_ml']!r} — fixed-dose liquids must report a volume, "
            f"not None (Bug 46)"
        )
        # The bedside 'practical' string must carry the volume, not a bare mg dose.
        assert "mL" in row["practical"], (
            f"{med_id}: practical instruction should carry the mL volume, got "
            f"{row['practical']!r}"
        )


def test_fixed_unit_injection_keeps_unit_and_invents_no_volume():
    # benzetacil is an IM injection dosed in UI with NO concentration — the fix
    # must NOT fabricate a mL volume for it (regression guard the other way).
    rows = _calculate_full_dosages(15.0)
    benz = _by_id(rows, "benzetacil")
    assert benz is not None, "benzetacil missing from dosage output"
    assert benz["per_dose_ml"] is None, (
        "fixed-unit injection (no concentration) must not be assigned a mL volume"
    )
    assert benz["practical"].endswith("UI"), (
        f"benzetacil practical should be a UI dose, got {benz['practical']!r}"
    )


# ---------------------------------------------------------------------------
# CHRA-2423 — dose-math INVARIANT guards. _calculate_full_dosages relies on two
# catalog properties that, if a future edit broke them, would silently produce a
# WRONG (potentially overdose) prescription. These lock them in.
# ---------------------------------------------------------------------------
from emr_automation.dashboard.routes import PEDIATRIC_MEDICATIONS, ADULT_MEDICATIONS


def _all_meds():
    return list(PEDIATRIC_MEDICATIONS) + list(ADULT_MEDICATIONS)


class TestDosageMathInvariants:
    def test_weight_based_tiers_start_at_zero_and_have_no_gaps(self):
        # On NO tier match, _calculate_full_dosages falls back to the LAST (highest)
        # tier. That's safe for a weight ABOVE all tiers, but an underweight patient
        # BELOW the lowest tier would fall through to the HIGHEST dose — an overdose.
        # Every weight_based_doses must therefore start at min_kg=0 and be contiguous.
        offenders = []
        for med in _all_meds():
            tiers = med.get("weight_based_doses")
            if not tiers:
                continue
            if tiers[0]["min_kg"] != 0:
                offenders.append(f"{med['id']}: first tier min_kg={tiers[0]['min_kg']} (must be 0)")
            for a, b in zip(tiers, tiers[1:]):
                if a["max_kg"] != b["min_kg"]:
                    offenders.append(f"{med['id']}: gap {a['max_kg']}→{b['min_kg']}")
        assert offenders == [], (
            "weight-tier coverage gap → an out-of-range weight falls to the highest "
            "tier (overdose risk): " + "; ".join(offenders))

    def test_practical_rule_is_only_one_drop_per_kg(self):
        # The display renders `round(weight)` gotas for a practical_rule — correct
        # ONLY for "1 gota/kg". A different multiplier would mis-state the drop count.
        bad = [
            f"{med['id']}: {med['practical_rule']!r}"
            for med in _all_meds()
            if med.get("practical_rule") and med["practical_rule"] != "1 gota/kg"
        ]
        assert bad == [], (
            "practical_rule other than '1 gota/kg' is mis-displayed as round(weight) "
            "gotas — honor the multiplier in the display first: " + "; ".join(bad))
