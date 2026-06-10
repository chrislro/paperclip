#!/usr/bin/env bash
# rename-product.sh — Rename Toca Ficha Dr. → new product name across the repo
# Usage: ./scripts/rename-product.sh "Toca Ficha Dr" "tocafichadr" "tocafichadr.com.br"
#                                     ^display name   ^slug         ^domain
#
# Safe: shows diff first, requires confirmation. Handles all ~40 references
# across manifest.json, store/description.txt, PRIVACY_POLICY.md, landing/*.html,
# and llms.txt / sitemap.xml.
#
# Does NOT modify: code logic, selectors, CID database, backend. Only branding.

set -euo pipefail

if [ $# -ne 3 ]; then
  echo "Usage: $0 <display-name> <slug> <domain>"
  echo "  display-name: e.g. 'Toca Ficha Dr'"
  echo "  slug:         e.g. 'tocafichadr' (lowercase, no spaces, for URLs + file names)"
  echo "  domain:       e.g. 'tocafichadr.com.br'"
  exit 1
fi

DISPLAY_NAME="$1"
SLUG="$2"
DOMAIN="$3"

cd "$(dirname "$0")/.."

echo "============================================"
echo " Rename preview"
echo "============================================"
echo "  Toca Ficha Dr. → $DISPLAY_NAME"
echo "  tocafichadr → $SLUG (slug/URL)"
echo "  tocafichadr.com.br → $DOMAIN"
echo ""

# Files to process
FILES=(
  "manifest.json"
  "store/description.txt"
  "PRIVACY_POLICY.md"
  "landing/index.html"
  "landing/privacidade.html"
  "landing/llms.txt"
  "landing/robots.txt"
  "landing/sitemap.xml"
)

# Show what will change
echo "Files affected:"
for f in "${FILES[@]}"; do
  if [ -f "$f" ]; then
    COUNT=$(grep -ciE "tocafichadr" "$f" 2>/dev/null || echo 0)
    echo "  $f ($COUNT refs)"
  fi
done
echo ""

read -r -p "Proceed with rename? [y/N] " CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "Aborted. No files modified."
  exit 0
fi

# macOS sed requires -i '' (empty backup extension)
SED_INPLACE=(-i '')
if sed --version 2>/dev/null | grep -q GNU; then
  SED_INPLACE=(-i)
fi

for f in "${FILES[@]}"; do
  [ -f "$f" ] || continue

  # Case-preserving rename: display name first (longest match wins)
  # 1. Display name: Toca Ficha Dr. → <display_name>
  sed "${SED_INPLACE[@]}" "s/Toca Ficha Dr./$DISPLAY_NAME/g" "$f"
  # 2. Domain: tocafichadr.com.br → <domain>
  sed "${SED_INPLACE[@]}" "s/tocafichadr\.com\.br/$DOMAIN/g" "$f"
  # 3. Remaining lowercase refs: tocafichadr → <slug>
  sed "${SED_INPLACE[@]}" "s/tocafichadr/$SLUG/g" "$f"

  echo "  ✓ $f"
done

echo ""
echo "============================================"
echo " Rename applied. Review before committing:"
echo "============================================"
echo "  git diff"
echo ""
echo " Then verify the manifest name loads in Chrome:"
echo "  chrome://extensions → reload → check name"
echo ""
echo " Also update (manual):"
echo "  - popup/popup.js CLOUD_URL (after named tunnel is set up)"
echo "  - manifest.json host_permissions (remove *.trycloudflare.com, add api.$DOMAIN)"
echo "  - Any GitHub repo description / README"
