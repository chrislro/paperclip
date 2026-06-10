#!/usr/bin/env python3
"""
extract_emr_cids.py — Extract G-Hosp's available CID-10 "favorites" list.

Discovered endpoint (from live DOM):
  data-autocomplete="/acs/autocomplete_cid_descricao_favs"

This script requires an active G-Hosp session. Two modes:

1. Browser cookie mode (easiest):
   - Log into G-Hosp in Chrome
   - Copy the Cookie header from DevTools Network tab
   - Paste into COOKIE_STRING below and run

2. Selenium mode:
   - Set USE_SELENIUM = True
   - Script logs in and drives the browser

Output: emr_cid_extract_YYYY-MM-DD.json (array of {code, name})
"""

import json
import time
import sys
from pathlib import Path
from datetime import date

# ── Config ───────────────────────────────────────────────────────────────────
BASE_URL = "https://prbentogoncalves.g-hosp.com.br"
ENDPOINT = "/acs/autocomplete_cid_descricao_favs"
DELAY = 0.25  # seconds between requests

# Mode 1: paste your browser cookie string here (from DevTools → Network → request headers)
COOKIE_STRING = ""  # e.g., "_g_hosp_session=abc123; ..."

# Mode 2: Selenium auto-login
USE_SELENIUM = False
SELENIUM_EMAIL = ""
SELENIUM_PASSWORD = ""

# ── Search terms ─────────────────────────────────────────────────────────────
SINGLE_CHARS = list("abcdefghijklmnopqrstuvwxyz0123456789")
EXTRA_PREFIXES = [
    # Dense medical term prefixes (Portuguese)
    "ab","ac","ad","ae","af","ag","ah","ai","ak","al","am","an","ao","ap","aq","ar","as","at","au","av","ax",
    "ba","be","bi","bl","bo","br","bu","bx","ca","ce","ch","ci","cl","co","cr","cu","cx","cy","cz",
    "da","de","di","do","dr","du","dx","dy","dz","ea","eb","ec","ed","ee","ef","eg","ei","el","em","en","eo","ep","eq","er","es","et","eu","ev","ex","ey","ez",
    "fa","fe","fi","fl","fo","fr","fu","fx","ga","ge","gi","gl","go","gr","gu","gy","gz",
    "ha","he","hi","ho","hr","hu","hx","hy","ia","ib","ic","id","ie","if","ig","ih","il","im","in","io","ip","iq","ir","is","it","iu","iv","ix","iz",
    "ja","je","ji","jo","ju","ka","ke","ki","kl","ko","kr","ku","la","le","li","lo","lu","lx","ly","ma","me","mi","mn","mo","mu","mx","my","na","ne","ni","no","nu","nx","ny","oa","ob","oc","od","oe","of","og","oh","oi","ok","ol","om","on","oo","op","oq","or","os","ot","ou","ov","ox","oy","oz",
    "pa","pb","pc","pe","ph","pi","pl","pn","po","pp","pr","ps","pt","pu","py","qa","qe","qi","qu","ra","re","ri","ro","ru","rx","ry","sa","sb","sc","se","sg","sh","si","sk","sl","sm","sn","so","sp","sq","sr","ss","st","su","sv","sw","sy","ta","tb","tc","te","th","ti","to","tr","ts","tu","tx","ty","ua","ub","uc","ud","ue","uf","ug","uh","ui","uj","ul","um","un","uo","up","uq","ur","us","ut","uu","uv","ux","uz",
    "va","vc","ve","vi","vo","vu","wa","we","wi","wo","wu","xa","xe","xi","xo","xu","ya","ye","yi","yo","yu","za","ze","zi","zo","zu",
]


def parse_cookie_string(s: str) -> dict:
    cookies = {}
    for part in s.split(";"):
        if "=" in part:
            k, v = part.strip().split("=", 1)
            cookies[k.strip()] = v.strip()
    return cookies


def extract_name(label: str) -> str:
    """Extract diagnosis name from 'J00 - Nasofaringite aguda' format."""
    label = label.strip()
    if " - " in label:
        return label.split(" - ", 1)[1]
    if " – " in label:
        return label.split(" – ", 1)[1]
    return label


def fetch_requests_mode():
    import requests

    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*;q=0.01",
    })
    if COOKIE_STRING:
        session.cookies.update(parse_cookie_string(COOKIE_STRING))

    all_codes = {}
    requests_made = 0

    def fetch_term(term: str):
        nonlocal requests_made
        url = f"{BASE_URL}{ENDPOINT}"
        try:
            r = session.get(url, params={"term": term}, timeout=10)
            requests_made += 1
            if r.status_code != 200:
                print(f'  "{term}" → HTTP {r.status_code}')
                return []
            data = r.json()
            return data if isinstance(data, list) else []
        except Exception as e:
            print(f'  "{term}" → ERROR: {e}')
            return []

    def record(items):
        for item in items:
            code = str(item.get("value") or item.get("code") or item.get("id") or "").strip()
            label = str(item.get("label") or item.get("name") or item.get("descricao") or "").strip()
            if not code:
                continue
            name = extract_name(label) or label
            all_codes.setdefault(code, name)

    # Phase 1: single chars
    print("[CID Extractor] Phase 1: single-character prefixes...")
    for ch in SINGLE_CHARS:
        items = fetch_term(ch)
        record(items)
        if items:
            print(f'  "{ch}" → {len(items)} results (total unique: {len(all_codes)})')
        time.sleep(DELAY)

    # Phase 2: two-char prefixes
    print("[CID Extractor] Phase 2: two-character prefixes...")
    for prefix in EXTRA_PREFIXES:
        items = fetch_term(prefix)
        record(items)
        if items:
            print(f'  "{prefix}" → {len(items)} results (total unique: {len(all_codes)})')
        time.sleep(DELAY)

    # Phase 3: CID chapter codes (A0..Z9)
    print("[CID Extractor] Phase 3: CID chapter prefixes...")
    chapters = list("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    for ch in chapters:
        for i in range(10):
            term = f"{ch}{i}"
            items = fetch_term(term)
            record(items)
            if items:
                print(f'  "{term}" → {len(items)} results (total unique: {len(all_codes)})')
            time.sleep(DELAY)

    return all_codes, requests_made


def fetch_selenium_mode():
    from selenium import webdriver
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC

    driver = webdriver.Chrome()
    wait = WebDriverWait(driver, 15)

    try:
        driver.get(f"{BASE_URL}/users/sign_in")
        wait.until(EC.presence_of_element_located((By.ID, "email"))).send_keys(SELENIUM_EMAIL)
        driver.find_element(By.ID, "password").send_keys(SELENIUM_PASSWORD)
        driver.find_element(By.NAME, "commit").click()
        wait.until(EC.url_contains("/prconsultas"))
        print("[CID Extractor] Logged in via Selenium.")

        # Navigate to any patient chart to be on the right domain
        driver.get(f"{BASE_URL}/prconsultas")
        time.sleep(2)

        all_codes = {}
        requests_made = 0

        def fetch_term(term: str):
            nonlocal requests_made
            url = f"{BASE_URL}{ENDPOINT}?term={term}"
            try:
                driver.execute_script(f"""
                    window.__cidExtractResult = null;
                    fetch("{url}", {{
                        credentials: 'same-origin',
                        headers: {{
                            'X-Requested-With': 'XMLHttpRequest',
                            'Accept': 'application/json, text/javascript, */*;q=0.01'
                        }}
                    }}).then(r => r.json()).then(data => {{
                        window.__cidExtractResult = data;
                    }}).catch(e => {{
                        window.__cidExtractResult = [];
                    }});
                """)
                time.sleep(0.5)
                result = driver.execute_script("return window.__cidExtractResult;")
                requests_made += 1
                return result if isinstance(result, list) else []
            except Exception as e:
                print(f'  "{term}" → ERROR: {e}')
                return []

        def record(items):
            for item in items:
                code = str(item.get("value") or item.get("code") or item.get("id") or "").strip()
                label = str(item.get("label") or item.get("name") or item.get("descricao") or "").strip()
                if not code:
                    continue
                name = extract_name(label) or label
                all_codes.setdefault(code, name)

        print("[CID Extractor] Phase 1: single-character prefixes...")
        for ch in SINGLE_CHARS:
            items = fetch_term(ch)
            record(items)
            if items:
                print(f'  "{ch}" → {len(items)} results (total unique: {len(all_codes)})')
            time.sleep(DELAY)

        print("[CID Extractor] Phase 2: two-character prefixes...")
        for prefix in EXTRA_PREFIXES:
            items = fetch_term(prefix)
            record(items)
            if items:
                print(f'  "{prefix}" → {len(items)} results (total unique: {len(all_codes)})')
            time.sleep(DELAY)

        return all_codes, requests_made
    finally:
        driver.quit()


def main():
    if USE_SELENIUM:
        if not SELENIUM_EMAIL or not SELENIUM_PASSWORD:
            sys.exit("Set SELENIUM_EMAIL and SELENIUM_PASSWORD for Selenium mode.")
        all_codes, requests_made = fetch_selenium_mode()
    else:
        if not COOKIE_STRING:
            print("WARNING: COOKIE_STRING is empty. The script will run unauthenticated.")
            print("Copy your Cookie header from DevTools while logged into G-Hosp.")
        all_codes, requests_made = fetch_requests_mode()

    sorted_codes = sorted(all_codes.items(), key=lambda x: x[0])
    output = [{"code": code, "name": name} for code, name in sorted_codes]

    out_path = Path(f"emr_cid_extract_{date.today().isoformat()}.json")
    out_path.write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"\n{'='*50}")
    print(f"Done. Requests: {requests_made}")
    print(f"Unique CID codes: {len(output)}")
    print(f"Saved to: {out_path.resolve()}")

    # Also print cid.js snippet
    print("\n--- cid.js snippet ---")
    for code, name in sorted_codes:
        print(f'  {{ code: "{code}", name: "{name}" }},')


if __name__ == "__main__":
    main()
