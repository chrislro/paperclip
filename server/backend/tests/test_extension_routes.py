import pytest
import json
import re
import unicodedata
from unittest.mock import patch, MagicMock
from emr_automation.dashboard.app import create_app


@pytest.fixture
def client():
    app = create_app()
    app.config["TESTING"] = True
    with app.test_client() as client:
        yield client


class TestHealthEndpoint:
    def test_health_returns_ok(self, client):
        resp = client.get("/api/health")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["status"] == "ok"


class TestSelectorsEndpoint:
    def test_selectors_returns_ghosp_config(self, client):
        resp = client.get("/api/selectors?emr=ghosp")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["emr"] == "ghosp"
        assert "selectors" in data

    def test_selectors_returns_404_for_unknown_emr(self, client):
        resp = client.get("/api/selectors?emr=unknown")
        assert resp.status_code == 404


class TestTranscribeEndpoint:
    @patch("emr_automation.dashboard.routes.transcribe_audio")
    @patch("emr_automation.dashboard.routes._get_openai_client", return_value=MagicMock())
    def test_transcribe_returns_soap(self, mock_client, mock_transcribe, client):
        mock_transcribe.return_value = {
            "ok": True,
            "soap": "S: Febre...",
            "cid_code": "J06.9",
            "cid_name": "IVAS",
            "confidence": 0.9,
        }

        from io import BytesIO
        data = {
            "audio": (BytesIO(b"x" * 200), "recording.webm"),
            "audio_metadata": json.dumps({
                "mimeType": "audio/webm;codecs=opus",
                "audioBitsPerSecond": 32000,
                "requestedBitsPerSecond": 32000,
                "trackSettings": {
                    "sampleRate": 48000,
                    "channelCount": 1,
                    "deviceId": "should-not-be-logged",
                },
                "deviceId": "should-not-be-logged",
            }),
        }
        resp = client.post(
            "/api/transcribe",
            data=data,
            content_type="multipart/form-data",
        )
        assert resp.status_code == 200
        result = resp.get_json()
        assert result["ok"] is True
        assert result["cid_code"] == "J06.9"
        audio_metadata = mock_transcribe.call_args.kwargs["audio_metadata"]
        assert audio_metadata["mimeType"] == "audio/webm;codecs=opus"
        assert audio_metadata["trackSettings"]["sampleRate"] == 48000
        assert audio_metadata["trackSettings"]["channelCount"] == 1
        assert "deviceId" not in audio_metadata
        assert "deviceId" not in audio_metadata["trackSettings"]

    def test_transcribe_rejects_missing_audio(self, client):
        resp = client.post("/api/transcribe", data={})
        assert resp.status_code == 400


class TestSuggestCidEndpoint:
    @patch("emr_automation.dashboard.routes.suggest_cid")
    @patch("emr_automation.dashboard.routes._get_openai_client", return_value=MagicMock())
    def test_suggest_cid_returns_code(self, mock_client, mock_suggest, client):
        mock_suggest.return_value = {
            "cid_code": "A09",
            "cid_name": "Diarreia",
            "confidence": 0.85,
        }

        resp = client.post(
            "/api/suggest-cid",
            json={"soap_text": "S: Diarreia...", "complaint": "diarreia"},
        )
        assert resp.status_code == 200
        assert resp.get_json()["cid_code"] == "A09"


class TestFormatSoapEndpoint:
    @patch("emr_automation.dashboard.routes.format_soap")
    @patch("emr_automation.dashboard.routes._get_openai_client", return_value=MagicMock())
    def test_format_soap_returns_formatted(self, mock_client, mock_format, client):
        mock_format.return_value = {"formatted_soap": "S: Febre..."}

        resp = client.post(
            "/api/format-soap",
            json={"raw_text": "febre tosse", "complaint": "febre"},
        )
        assert resp.status_code == 200
        assert "formatted_soap" in resp.get_json()


class TestFormatAtestadoLetterEndpoint:
    @patch("emr_automation.dashboard.routes.format_atestado_letter")
    @patch("emr_automation.dashboard.routes._get_openai_client", return_value=MagicMock())
    def test_letter_returns_drafted_text_on_valid_input(
        self, mock_client, mock_format_letter, client
    ):
        mock_format_letter.return_value = {
            "letter": "Prezada Sra.,\n\nO bebê João, de 6 meses, ..."
        }

        resp = client.post(
            "/api/format-atestado-letter",
            json={
                "patient_name": "João da Silva",
                "patient_age": "6 meses",
                "diagnosis_text": "bronquiolite",
                "doctor_intent": "Orientar repouso e hidratação.",
            },
        )

        assert resp.status_code == 200
        body = resp.get_json()
        assert "letter" in body
        assert body["letter"].startswith("Prezada Sra.,")

        # Confirm helper got the right kwargs.
        mock_format_letter.assert_called_once()
        call_kwargs = mock_format_letter.call_args.kwargs
        assert call_kwargs["patient_name"] == "João da Silva"
        assert call_kwargs["patient_age"] == "6 meses"
        assert call_kwargs["diagnosis_text"] == "bronquiolite"
        assert call_kwargs["doctor_intent"] == "Orientar repouso e hidratação."

    def test_letter_rejects_missing_json_body(self, client):
        # No JSON body, no content-type — should be a 400.
        resp = client.post("/api/format-atestado-letter", data="")
        assert resp.status_code == 400
        assert "error" in resp.get_json()

    @patch("emr_automation.dashboard.routes._get_openai_client", return_value=MagicMock())
    def test_letter_rejects_empty_doctor_intent(self, mock_client, client):
        resp = client.post(
            "/api/format-atestado-letter",
            json={
                "patient_name": "Maria",
                "patient_age": "2 anos",
                "diagnosis_text": "resfriado",
                "doctor_intent": "   ",
            },
        )
        assert resp.status_code == 400
        body = resp.get_json()
        assert "error" in body
        assert "doctor_intent" in body["error"]


class TestDosagesFullEndpoint:
    def test_pediatric_default_returns_flat_array_with_weight(self, client):
        resp = client.get("/api/dosages/full?weight=10")
        assert resp.status_code == 200
        data = resp.get_json()
        assert isinstance(data, list)
        # 41 base pediatric meds after CHRA-2063 de-dup + 5 aliases
        assert len(data) == 46
        assert all(med["is_adult"] is False for med in data)

    def test_pediatric_default_no_weight_400(self, client):
        resp = client.get("/api/dosages/full")
        assert resp.status_code == 400
        assert "error" in resp.get_json()

    def test_nan_weight_rejected_400(self, client):
        # CHRA-2423 Bug 41: float("nan") raises no ValueError and slips past the
        # <=0 / >150 range check (every NaN comparison is False), so it reached
        # _calculate_full_dosages and produced NaN doses on a clinical endpoint.
        resp = client.get("/api/dosages/full?weight=nan")
        assert resp.status_code == 400
        assert "error" in resp.get_json()

    def test_legacy_dosages_nan_weight_rejected_400(self, client):
        resp = client.get("/api/dosages?weight=nan")
        assert resp.status_code == 400
        assert "error" in resp.get_json()

    def test_export_nan_weight_rejected_400(self, client):
        # CHRA-2423 Bug 42: /api/dosages/export was the third weight-validation
        # site and shared the Bug-41 NaN gap. With a connected EMR, "weight=nan"
        # slipped past the range check into _find_dosage_by_id → round(nan) → 500.
        client.application.config["EMR_INSTANCE"] = MagicMock(driver=object(), weight=None)
        resp = client.post("/api/dosages/export", json={"drug": "x", "weight": "nan"})
        assert resp.status_code == 400
        assert "weight" in str(resp.get_json()).lower()

    def test_adult_returns_fixed_doses(self, client):
        resp = client.get("/api/dosages/full?type=adult")
        assert resp.status_code == 200
        data = resp.get_json()
        assert isinstance(data, list)
        # 71 base adult meds + 3 backward-compat aliases (CHRA-2048: +51 popup-parity adds)
        assert len(data) == 74
        assert all(med["is_adult"] is True for med in data)

        amox = next(med for med in data if med["id"] == "amox_adult")
        assert amox["practical"] == "500mg"

    def test_adult_chra2048_parity_additions(self, client):
        """CHRA-2048: new adult meds mirrored from the popup _MED_CATALOG_FALLBACK."""
        resp = client.get("/api/dosages/full?type=adult")
        data = resp.get_json()
        by_id = {m["id"]: m for m in data}
        # representative samples across the new cardio / endocrine / gastro / others blocks
        assert by_id["losartana"]["practical"] == "1 cp"
        assert by_id["metformina_adult"]["category"] == "endocrine"
        assert by_id["losartana"]["category"] == "cardio"
        assert by_id["ipratropio_adult"]["is_adult"] is True
        # adult desloratadine uses the _adult suffix to avoid colliding with the
        # pediatric `desloratadine_ped` id already in the catalog.
        assert "desloratadine_adult" in by_id
        ped = client.get("/api/dosages/full?weight=10").get_json()
        assert any(m["id"] == "desloratadine_ped" and m["is_adult"] is False for m in ped)

    def test_pediatric_chra2048_parity_additions(self, client):
        """CHRA-2048 batch 2/2: 15 pediatric meds mirrored from the popup
        _MED_CATALOG_FALLBACK, with weight-based dose math anchored to
        RENAME 2024 / conduta-rapida drugs.ts."""
        data = client.get("/api/dosages/full?weight=20").get_json()
        by_id = {m["id"]: m for m in data}

        new_ids = [
            "claritro_ped", "eritro_ped", "ceftriaxona_ped", "mebendazol_ped",
            "ivermectina_ped", "ipratropio_ped", "budesonida_neb_ped",
            "adren_neb_ped", "sf_nasal", "metoclopramida_ped", "bromoprida_ped",
            "lactulose_ped", "simeticona_ped", "acido_folico_ped", "adren_im_ped",
            # CHRA-2063: batch 2/2 kept canonical IDs after pediatric de-dup
            "benzatina_ped", "nistatina_ped", "dexa_ped", "loratadina_ped",
            "desloratadine_ped", "hidroxizina_ped", "ondansetrona_ped",
            "sulfato_ferroso_ped", "sulfato_zinco_ped",
        ]
        for mid in new_ids:
            assert mid in by_id, f"missing new med {mid}"
            assert by_id[mid]["is_adult"] is False

        # new pediatric categories now present on the online side
        cats = {m["category"] for m in data}
        assert {"respiratory", "gastro"} <= cats

        # ── representative dose-math checks (weight = 20 kg) ──
        # claritromicina 7,5mg/kg/dose x2 -> 150mg/dose; susp 50mg/mL = 3mL
        assert by_id["claritro_ped"]["per_dose_mg"] == 150.0
        assert by_id["claritro_ped"]["per_dose_ml"] == 3.0
        # eritromicina 10mg/kg/dose x4 -> 200mg/dose
        assert by_id["eritro_ped"]["per_dose_mg"] == 200.0
        # ceftriaxona 50mg/kg/dia 1x -> 1000mg (injetável, sem mL)
        assert by_id["ceftriaxona_ped"]["per_dose_mg"] == 1000.0
        assert by_id["ceftriaxona_ped"]["per_dose_ml"] is None
        # mebendazol dose fixa 100mg (faixa de peso)
        assert by_id["mebendazol_ped"]["practical"] == "100mg"
        # ivermectina 0,2mg/kg -> 4mg
        assert by_id["ivermectina_ped"]["per_dose_mg"] == 4.0
        # ipratrópio dose fixa 250 mcg
        assert by_id["ipratropio_ped"]["practical"] == "250mcg"
        # budesonida crupe 2mg dose fixa
        assert by_id["budesonida_neb_ped"]["practical"] == "2mg"
        # adrenalina neb 0,5mL/kg (máx 5mL): 20kg -> 5mL
        assert by_id["adren_neb_ped"]["per_dose_ml"] == 5.0
        # adrenalina IM 0,01mg/kg (máx 0,3): 20kg -> 0,2mg (sem mL p/ evitar arredondar p/ 0)
        assert by_id["adren_im_ped"]["per_dose_mg"] == 0.2
        # soro nasal: sem cálculo de dose
        assert by_id["sf_nasal"]["per_dose_mg"] is None
        assert by_id["sf_nasal"]["practical"] == "Instilar (lavagem nasal)"
        # lactulose 0,4mL/kg/dia: 20kg -> 8mL
        assert by_id["lactulose_ped"]["per_dose_ml"] == 8.0
        # metoclopramida 0,1mg/kg/dose: 20kg -> 2mg/dose
        assert by_id["metoclopramida_ped"]["per_dose_mg"] == 2.0
        # ácido fólico profilaxia 0,4mg dose fixa
        assert by_id["acido_folico_ped"]["practical"] == "0.4mg"
        # simeticona usa regra prática "1 gota/kg"
        assert "gota/kg" in by_id["simeticona_ped"]["practical"]

        # -- CHRA-2063 kept batch 2 entries: representative dose-math (weight = 20 kg) --
        # benzatina 20kg < 27kg -> 600000 UI dose fixa
        assert by_id["benzatina_ped"]["practical"] == "600000UI"
        # nistatina dose fixa 100000 UI
        assert by_id["nistatina_ped"]["practical"] == "100000UI"
        # dexametasona 0,15mg/kg * 20 = 3mg; elixir 0,1mg/mL = 30mL
        assert by_id["dexa_ped"]["per_dose_mg"] == 3.0
        assert by_id["dexa_ped"]["per_dose_ml"] == 30.0
        # loratadina 20kg < 30kg -> 5mg dose fixa; xarope 1mg/mL = 5mL.
        # Bug 46: the weight_based_doses branch now reports the administrable
        # volume for liquids (was "5mg" with per_dose_ml=None — the manual
        # mg->mL conversion this tool exists to remove).
        assert by_id["loratadina_ped"]["practical"] == "5mL"
        assert by_id["loratadina_ped"]["per_dose_ml"] == 5.0
        # desloratadina 20kg tier [0,20) boundary -> 20kg falls in [20,40) -> 2,5mg; xarope 0,5mg/mL = 5mL
        assert by_id["desloratadine_ped"]["per_dose_mg"] == 2.5
        # hidroxizina 0,5mg/kg/dose * 20 = 10mg; xarope 2mg/mL = 5mL
        assert by_id["hidroxizina_ped"]["per_dose_mg"] == 10.0
        assert by_id["hidroxizina_ped"]["per_dose_ml"] == 5.0
        # ondansetrona 15 <= 20 < 40 -> 4mg tier; sol 0,8mg/mL = 5mL
        assert by_id["ondansetrona_ped"]["per_dose_mg"] == 4.0
        # sulfato_ferroso 3mg/kg * 20 = 60mg; gotas 25mg/mL = 2,4mL
        assert by_id["sulfato_ferroso_ped"]["per_dose_mg"] == 60.0
        # sulfato_zinco 7 <= 20 -> 20mg tier; sol 4mg/mL = 5mL
        assert by_id["sulfato_zinco_ped"]["per_dose_mg"] == 20.0

    def test_chra2063_pediatric_catalog_keeps_canonical_ids_without_duplicate_substances(self, client):
        """CHRA-2063: keep one pediatric entry per duplicated medication substance."""
        data = client.get("/api/dosages/full?weight=20").get_json()
        by_id = {m["id"]: m for m in data}

        removed_ids = {
            "hydroxyzine", "iron_sulfate", "amoxclav_ped", "dexamethasone",
            "metronidazol_ped", "smxtmp_ped", "ondansetron", "desloratadine",
            "albendazol_ped", "nystatin", "loratadine", "zinc_sulfate",
        }
        kept_ids = {
            "hidroxizina_ped", "sulfato_ferroso_ped", "amox_clav", "dexa_ped",
            "metronidazole", "sulfa_tmp", "ondansetrona_ped", "desloratadine_ped",
            "albendazole", "nistatina_ped", "loratadina_ped", "sulfato_zinco_ped",
        }
        assert removed_ids.isdisjoint(by_id)
        assert kept_ids <= set(by_id)

        def normalize_substance(name):
            key = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
            key = key.lower().replace("+", " ")
            key = re.sub(r"\([^)]*\)", "", key)
            key = re.sub(r"\b(xarope|oral|diarreia)\b", "", key)
            key = re.sub(r"\s+", " ", key).strip()
            if key == "amoxi clavulanato":
                return "amoxicilina clavulanato"
            return key

        chra2063_substances = {
            "hidroxizina": "hidroxizina",
            "sulfato ferroso": "sulfato_ferroso",
            "amoxicilina clavulanato": "amoxicilina_clavulanato",
            "dexametasona": "dexametasona",
            "metronidazol": "metronidazol",
            "sulfametoxazol trimetoprima": "sulfametoxazol_trimetoprima",
            "ondansetrona": "ondansetrona",
            "desloratadina": "desloratadina",
            "albendazol": "albendazol",
            "nistatina": "nistatina",
            "loratadina": "loratadina",
            "sulfato de zinco": "sulfato_zinco",
        }
        seen = {}
        for med in data:
            substance = chra2063_substances.get(normalize_substance(med["name"]))
            if not substance:
                continue
            assert substance not in seen, f"duplicate {substance}: {seen[substance]} and {med['id']}"
            seen[substance] = med["id"]

        assert set(seen) == set(chra2063_substances.values())

    def test_both_returns_pediatric_plus_adult(self, client):
        resp = client.get("/api/dosages/full?weight=10&type=both")
        assert resp.status_code == 200
        data = resp.get_json()
        assert isinstance(data, dict)
        assert set(data.keys()) == {"pediatric", "adult"}
        assert len(data["pediatric"]) == 46
        assert len(data["adult"]) == 74
        assert all(med["is_adult"] is False for med in data["pediatric"])
        assert all(med["is_adult"] is True for med in data["adult"])

    def test_both_no_weight_400(self, client):
        resp = client.get("/api/dosages/full?type=both")
        assert resp.status_code == 400
        assert "error" in resp.get_json()

    def test_invalid_type_400(self, client):
        resp = client.get("/api/dosages/full?type=foo")
        assert resp.status_code == 400
        assert "error" in resp.get_json()
