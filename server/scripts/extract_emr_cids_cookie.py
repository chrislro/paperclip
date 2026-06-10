#!/usr/bin/env python3
"""
extract_emr_cids_cookie.py — Extract G-Hosp CID favorites via Python + browser cookie.

1. Log into G-Hosp in Chrome (prbentogoncalves.g-hosp.com.br)
2. Open DevTools → Network tab → click ANY request
3. In the Request Headers section, find "Cookie:" and copy the entire value
4. Paste it below where it says PASTE_COOKIE_HERE
5. Run: python extract_emr_cids_cookie.py
"""

import json
import time
import sys

# ================================================================
# STEP 1: PASTE YOUR COOKIE STRING HERE (inside the quotes)
# Example: "_g_hosp_session=abc123; _g_hosp_user_id=456; ..."
# ================================================================
COOKIE_STRING = ""  # <-- PASTE BETWEEN THESE QUOTES

BASE_URL = "https://prbentogoncalves.g-hosp.com.br"
ENDPOINT = "/acs/autocomplete_cid_descricao_favs"
DELAY = 0.25


def parse_cookie_string(s: str) -> dict:
    cookies = {}
    for part in s.split(";"):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            cookies[k.strip()] = v.strip()
    return cookies


def main():
    if not COOKIE_STRING.strip():
        print("ERROR: You must paste your cookie string into COOKIE_STRING at the top of this file.")
        print()
        print("How to get your cookie:")
        print("  1. In Chrome, open G-Hosp and log in")
        print("  2. Press F12 → Network tab")
        print("  3. Click any request (e.g. the page load or an XHR)")
        print("  4. Scroll to 'Request Headers' → find 'cookie: ...'")
        print("  5. Copy the entire value after 'cookie: '")
        print("  6. Paste it between the quotes on line 18 of this file")
        sys.exit(1)

    try:
        import requests
    except ImportError:
        print("Installing requests...")
        import subprocess
        subprocess.check_call([sys.executable, "-m", "pip", "install", "requests", "-q"])
        import requests

    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*;q=0.01",
    })
    session.cookies.update(parse_cookie_string(COOKIE_STRING))

    codes = {}
    chars = list("abcdefghijklmnopqrstuvwxyz0123456789")
    requests_made = 0

    print("Fetching CID list from G-Hosp...")
    for c in chars:
        url = f"{BASE_URL}{ENDPOINT}"
        try:
            r = session.get(url, params={"term": c}, timeout=10)
            requests_made += 1
            if r.status_code != 200:
                print(f'  "{c}" → HTTP {r.status_code}')
                continue
            data = r.json()
            if not isinstance(data, list):
                continue
            for item in data:
                code = str(item.get("value") or item.get("id") or item.get("code") or "").strip()
                name = str(item.get("label") or item.get("name") or "").strip()
                # Extract name from "J00 - Nasofaringite aguda"
                if " - " in name:
                    name = name.split(" - ", 1)[1]
                if code:
                    codes[code] = name
            print(f'  "{c}" → {len(data)} results (total unique: {len(codes)})')
        except Exception as e:
            print(f'  "{c}" → ERROR: {e}')
        time.sleep(DELAY)

    # Save
    sorted_codes = sorted(codes.items(), key=lambda x: x[0])
    output = [{"code": code, "name": name} for code, name in sorted_codes]
    filename = "emr_cids_extracted.json"

    with open(filename, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\n{'='*50}")
    print(f"Done!")
    print(f"Requests made: {requests_made}")
    print(f"Unique CID codes found: {len(output)}")
    print(f"Saved to: {filename}")
    print(f"\nFirst 10 codes:")
    for item in output[:10]:
        print(f"  {item['code']} - {item['name']}")


if __name__ == "__main__":
    main()
