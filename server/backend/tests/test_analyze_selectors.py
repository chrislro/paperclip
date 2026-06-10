import json
import sys
import os
import pytest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import analyze_selectors as AS


def _make_event(event, tag, id_="", name="", value="", href="",
                placeholder="", text="", xpath="", css="#foo",
                page_url="https://prbentogoncalves.g-hosp.com.br/amb/interns?intern_id=99",
                ts="2026-05-20T10:00:00.000Z", **kw):
    return dict(event=event, tag=tag, id=id_, name=name, value=value,
                href=href, placeholder=placeholder, text=text,
                xpath=xpath, css_selector=css, page_url=page_url,
                type=kw.get("type", ""), ts=ts, **{k: v for k, v in kw.items() if k != "type"})


class TestDetectActionType:
    def test_cid_input_by_id(self):
        ev = _make_event("input", "input", id_="intcid_cid_id", css="#intcid_cid_id")
        assert AS.detect_action_type(ev) == "cid_input"

    def test_cid_input_by_placeholder(self):
        ev = _make_event("click", "input", placeholder="Diagnóstico CID", css="input.cid-search")
        assert AS.detect_action_type(ev) == "cid_input"

    def test_prescription_link_by_href(self):
        ev = _make_event("click", "a", href="/amb/interns/1234/receitaalta/new", css="a#link_new_receitaalta")
        assert AS.detect_action_type(ev) == "prescription_link"

    def test_prescription_link_not_print(self):
        ev = _make_event("click", "a", href="/imp_receita/1234", text="Imprimir Receita", css="a.botao")
        assert AS.detect_action_type(ev) != "prescription_link"

    def test_save_button_by_id(self):
        ev = _make_event("click", "input", id_="submit_pranamnese", css="#submit_pranamnese")
        assert AS.detect_action_type(ev) == "save_button"

    def test_discharge_save_by_id(self):
        ev = _make_event("click", "input", id_="botao_gravar_alta", css="#botao_gravar_alta")
        assert AS.detect_action_type(ev) == "discharge_save"

    def test_unknown_returns_none(self):
        ev = _make_event("click", "a", href="/some/random/path", text="Random Link", css="a")
        assert AS.detect_action_type(ev) is None


class TestSpecificityBonus:
    def test_id_selector_bonus(self):
        assert AS.specificity_bonus("#intcid_cid_id") == 3

    def test_attribute_name_bonus(self):
        assert AS.specificity_bonus("input[name='commit']") == 2

    def test_pure_class_penalty(self):
        assert AS.specificity_bonus("a.botao") == -2

    def test_nth_child_penalty(self):
        assert AS.specificity_bonus("#dialog_formularios > div:nth-child(2) > a") < 3

    def test_combined_id_and_attribute(self):
        bonus = AS.specificity_bonus("#foo input[value='Gravar']")
        assert bonus >= 5  # id(+3) + attribute(+2)


class TestRankSelectors:
    def test_id_selector_wins_over_class(self):
        events = [
            _make_event("click", "input", id_="submit_pranamnese",
                        css="#submit_pranamnese", ts="2026-05-20T10:00:00.000Z"),
            _make_event("click", "input", id_="submit_pranamnese",
                        css="#submit_pranamnese", ts="2026-05-19T10:00:00.000Z"),
            _make_event("click", "input",
                        css="input.botao.pr10", ts="2026-05-20T10:01:00.000Z"),
            _make_event("click", "input",
                        css="input.botao.pr10", ts="2026-05-20T10:02:00.000Z"),
            _make_event("click", "input",
                        css="input.botao.pr10", ts="2026-05-20T10:03:00.000Z"),
        ]
        ranked = AS.rank_selectors(events, newest_ts="2026-05-20T10:03:00.000Z",
                                   oldest_ts="2026-05-19T10:00:00.000Z")
        # id-based selector should rank first despite lower raw frequency
        assert ranked[0][0] == "#submit_pranamnese"

    def test_returns_list_of_tuples(self):
        events = [_make_event("click", "input", css="#foo")]
        ranked = AS.rank_selectors(events, newest_ts="2026-05-20T10:00:00.000Z",
                                   oldest_ts="2026-05-20T10:00:00.000Z")
        assert isinstance(ranked, list)
        assert len(ranked) == 1
        css, score = ranked[0]
        assert isinstance(css, str)
        assert isinstance(score, (int, float))


class TestBuildDerivedConfig:
    def test_output_shape(self, tmp_path):
        log_file = tmp_path / "log.jsonl"
        events = [
            _make_event("click", "input", id_="submit_pranamnese",
                        css="#submit_pranamnese"),
            _make_event("input", "input", id_="intcid_cid_id",
                        css="#intcid_cid_id"),
        ]
        log_file.write_text("\n".join(json.dumps(e) for e in events))
        config = AS.build_derived_config([str(log_file)])
        assert "selectors" in config
        assert "save_button" in config["selectors"]
        assert "cid_input" in config["selectors"]
        # cid_input should be a list (multiple strategies supported)
        assert isinstance(config["selectors"]["cid_input"], list)
