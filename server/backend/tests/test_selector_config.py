import pytest
from emr_automation.selector_config import load_selectors, get_selector, clear_cache


@pytest.fixture(autouse=True)
def reset_cache():
    clear_cache()
    yield
    clear_cache()


class TestSelectorConfig:
    def test_load_ghosp_selectors(self):
        config = load_selectors("ghosp")
        assert config is not None
        assert config["emr"] == "ghosp"
        assert "selectors" in config
        assert "cid_input" in config["selectors"]
        assert isinstance(config["selectors"]["cid_input"], list)

    def test_load_unknown_emr_returns_none(self):
        config = load_selectors("unknown_emr_system")
        assert config is None

    def test_get_selector_returns_value(self):
        value = get_selector("ghosp", "soap_editor_count")
        assert value == 6

    def test_get_selector_returns_default_for_missing_key(self):
        value = get_selector("ghosp", "nonexistent_key", default="fallback")
        assert value == "fallback"
