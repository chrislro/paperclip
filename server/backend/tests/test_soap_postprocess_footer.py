"""Regression: _postprocess_soap must NOT delete a plan that opens with a
primary conduct phrase overlapping the canonical footer (CHRA-2423 Bug 78).

WHY this matters (not just WHAT it does): the canonical PLAN_FOOTER_TEXT is
appended to every note unconditionally in post-processing. _PLANO_FOOTER_ANCHOR_RE
exists to strip any model-generated *closing boilerplate* that semantically
duplicates that footer's tail, so the note doesn't end with two near-identical
referral/consent blocks. The model NEVER sees the footer text (rule 2 only says
"NÃO escreva o rodapé do PLANO"), so this is a fuzzy match on paraphrased
closing lines — not a verbatim-footer dedup.

The bug: the anchor also matched "Forneço sintomáticos", which is the single
most common pediatric UPA *primary* conduct (rule 6 instructs first-person
conducts exactly like it). When a doctor's plan opened with
"Forneço sintomáticos com dipirona…", `.search()` matched at offset 0 and the
code truncated the plan there — silently discarding the drug doses, return
guidance, and lab orders that followed, writing "Sem dados disponíveis." into
the medical record instead. `_extract_plan_from_soap` (the #recomendas_descricao
auto-fill source) returned "" for the same reason.

These tests pin the contract: a primary conduct that merely *resembles* the
footer's first line must survive post-processing intact, while genuine closing
boilerplate (the consent line / chronic-care referral line) is still
de-duplicated.
"""
from emr_automation import extension_api as ea


def _note(plano_body: str) -> str:
    return (
        "SUBJETIVO:\nPaciente relata febre há 2 dias.\n\n"
        "[OBJETIVO_PLACEHOLDER]\n\n"
        "AVALIAÇÃO:\n1. IVAS\n\n"
        f"PLANO:\n{plano_body}\n"
    )


class TestPlanFooterDoesNotEatConducts:
    def test_forneco_sintomaticos_primary_conduct_is_preserved(self):
        # The exact shape of the most common pediatric UPA plan: symptomatic
        # treatment with a dose, return guidance, then labs. None of it may be
        # lost — this text IS the chart.
        out = ea._postprocess_soap(_note(
            "Forneço sintomáticos com dipirona 500mg de 6/6h se febre.\n"
            "Oriento retorno se febre persistente por mais de 72h.\n"
            "Solicito hemograma e PCR."
        ))
        assert "dipirona 500mg" in out, "drug + dose was dropped from the plan"
        assert "hemograma e PCR" in out, "lab orders were dropped from the plan"
        assert "Sem dados disponíveis" not in out, "plan was blanked to placeholder"

    def test_extract_plan_returns_the_conducts(self):
        # _extract_plan_from_soap feeds the extension's #recomendas_descricao
        # auto-fill — it must yield the real conducts, never "".
        processed = ea._postprocess_soap(_note(
            "Forneço sintomáticos com dipirona.\nSolicito hemograma."
        ))
        plan = ea._extract_plan_from_soap(processed)
        assert "dipirona" in plan
        assert "hemograma" in plan
        # NO part of the canonical footer may leak into the extracted plan body —
        # this string is typed verbatim into the G-Hosp #recomendas_descricao field.
        assert "compreendeu e concordou" not in plan          # footer last line
        assert "sinais de alarme" not in plan                  # footer line 2
        assert "Acompanhamento de rotina" not in plan          # footer line 4

    def test_footer_appended_exactly_once(self):
        out = ea._postprocess_soap(_note("Forneço sintomáticos com dipirona."))
        assert out.count("compreendeu e concordou") == 1

    def test_idempotent(self):
        once = ea._postprocess_soap(_note(
            "Forneço sintomáticos com dipirona.\nSolicito hemograma."
        ))
        twice = ea._postprocess_soap(once)
        assert once == twice

    def test_genuine_closing_consent_boilerplate_still_deduped(self):
        # The anchor's real purpose: if the model emits its own consent line,
        # it must be stripped so the canonical footer's consent line is not
        # duplicated. Primary conducts above it still survive.
        out = ea._postprocess_soap(_note(
            "Solicito hemograma.\n"
            "Paciente/responsável compreendeu e concordou com as orientações."
        ))
        assert out.count("compreendeu e concordou") == 1
        assert "hemograma" in out

    def test_vaccine_conduct_not_eaten(self):
        # "Atualizo vacinas conforme calendário" is a real conduct. The vacinas
        # anchor alternative requires the full "vacinas e controle de condições
        # crônicas" boilerplate, so a bare vaccine conduct must survive.
        out = ea._postprocess_soap(_note(
            "Atualizo vacinas conforme calendário.\nSolicito teste rápido para influenza."
        ))
        assert "calendário" in out
        assert "teste rápido para influenza" in out
