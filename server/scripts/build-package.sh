#!/usr/bin/env bash
# build-package.sh — builds a clean Chrome Web Store zip
# Usage: ./scripts/build-package.sh
# Output: tocafichadr-v<version>.zip in repo root (gitignored)

set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(grep '"version"' manifest.json | head -1 | sed -E 's/.*"version": *"([^"]+)".*/\1/')
OUT="tocafichadr-v${VERSION}.zip"
DIST="dist"

echo "Building tocafichadr v${VERSION}..."

# v3.0.2/3: bundle the popup + service worker with esbuild (Clerk SDK is ESM-only).
echo "→ Bundling popup + service worker with esbuild..."
npm run build

rm -rf "$DIST"
mkdir -p "$DIST"

# Determine manifest to use (dev or prod)
MANIFEST="manifest.json"
if [[ "${1:-}" == "--prod" ]]; then
  MANIFEST="manifest.prod.json"
  echo "→ Using PRODUCTION manifest (no dev hosts)"
else
  echo "→ Using DEV manifest (includes localhost, tunnel, Tailscale)"
fi

# Copy ONLY the files Chrome needs at runtime
cp -r background content icons popup sidepanel offscreen styles shared "$DIST/"
cp "$MANIFEST" "$DIST/manifest.json"
# Strip _comments block from manifest — it's documentation, not runtime data,
# and verify-package.js flags the localhost mentions inside it as false positives.
node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync('$DIST/manifest.json','utf8')); delete m._comments; fs.writeFileSync('$DIST/manifest.json', JSON.stringify(m,null,2)+'\\n');"
# v3.0.5: post-auth landing page (Clerk redirect target, listed in
# web_accessible_resources). Required for sign-in flow to complete cleanly.
cp auth-success.html auth-success.js "$DIST/"

# Strip any dev-only files that may have sneaked in
find "$DIST" -name ".DS_Store" -delete
find "$DIST" -name "*.map" -delete
find "$DIST" -name "*.test.js" -delete
# .src.js are the sources (used only at build time); the .bundle.js are what ships.
rm -f "$DIST/popup/popup.src.js" "$DIST/background/service-worker.src.js"
rm -rf "$DIST/.claude" "$DIST/.superpowers" "$DIST/node_modules" "$DIST/docs" "$DIST/landing" "$DIST/store" "$DIST/scripts"
rm -rf "$DIST/icons/_v3.0-backup"

# Convert the copied package into the production runtime surface and verify
# every manifest-referenced file exists before zipping.
node scripts/verify-package.js --prepare-prod "$DIST"
node scripts/verify-package.js --dist "$DIST"

# Build zip
rm -f "$OUT"
(cd "$DIST" && zip -qr "../$OUT" .)

# Report
SIZE=$(du -h "$OUT" | awk '{print $1}')
FILES=$(unzip -l "$OUT" | tail -1 | awk '{print $2}')
echo ""
echo "✓ Built $OUT ($SIZE, $FILES files)"
echo ""
echo "Upload to: https://chrome.google.com/webstore/devconsole"
echo ""
echo "Contents preview:"
unzip -l "$OUT" | awk 'NR <= 30 { print }'
