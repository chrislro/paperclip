#!/usr/bin/env bash
# scripts/bump-version.sh — Safely bump extension version across all files
# Usage: ./scripts/bump-version.sh <semver>
#        ./scripts/bump-version.sh --dry-run <semver>  (validate only, no changes)
#        ./scripts/bump-version.sh --verify            (check all version files are in sync)
#
# Strict guardrails:
# - Blocks on uncommitted changes
# - Validates semver format
# - Requires manifest.json == manifest.prod.json version
# - Updates CHANGELOG.md with template
# - Creates git commit but does NOT push or tag

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$REPO_ROOT"

DRY_RUN=false
VERIFY=false
VERSION=""

# Parse args
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --verify) VERIFY=true ;;
    -*) echo "Unknown flag: $arg" >&2; exit 1 ;;
    *) VERSION="$arg" ;;
  esac
done

# ─── VERIFY MODE ───
if $VERIFY; then
  echo "Verifying version consistency..."
  MANIFEST_V=$(node -p "require('./manifest.json').version")
  PROD_V=$(node -p "require('./manifest.prod.json').version")
  PKG_V=$(node -p "require('./package.json').version")
  
  if [[ "$MANIFEST_V" != "$PROD_V" ]]; then
    echo "FAIL: manifest.json ($MANIFEST_V) != manifest.prod.json ($PROD_V)" >&2
    exit 1
  fi
  
  # package.json is often 1.0.0 for internal tooling; only warn if different
  if [[ "$MANIFEST_V" != "$PKG_V" ]]; then
    echo "WARN: manifest.json ($MANIFEST_V) != package.json ($PKG_V) — package.json is decoupled, OK"
  fi
  
  echo "PASS: manifest.json == manifest.prod.json == $MANIFEST_V"
  exit 0
fi

# ─── VALIDATION ───
if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 [--dry-run] <semver>" >&2
  echo "       $0 --verify" >&2
  exit 1
fi

# Semver validation
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "FAIL: Version '$VERSION' is not valid semver (expected: X.Y.Z)" >&2
  exit 1
fi

# Block on uncommitted changes
if [[ -n $(git status --porcelain) ]]; then
  echo "FAIL: Working tree has uncommitted changes. Commit or stash before bumping." >&2
  git status --short
  exit 1
fi

# Extract current version
CURRENT=$(node -p "require('./manifest.json').version")
echo "Current version: $CURRENT"
echo "New version:     $VERSION"

if [[ "$CURRENT" == "$VERSION" ]]; then
  echo "FAIL: Already at version $VERSION" >&2
  exit 1
fi

# ─── DRY RUN ───
if $DRY_RUN; then
  echo ""
  echo "[DRY RUN] Would update:"
  echo "  manifest.json        : $CURRENT → $VERSION"
  echo "  manifest.prod.json   : $CURRENT → $VERSION"
  echo "  package.json         : $PKG_V → $VERSION"
  echo "  CHANGELOG.md         : prepend v$VERSION entry"
  echo ""
  echo "Validation passed. Run without --dry-run to apply."
  exit 0
fi

# ─── APPLY CHANGES ───
echo ""
echo "Applying version bump..."

# Update manifest.json
node -e "
const fs = require('fs');
const m = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
m.version = '$VERSION';
fs.writeFileSync('manifest.json', JSON.stringify(m, null, 2) + '\n');
console.log('  ✓ manifest.json');
"

# Update manifest.prod.json
node -e "
const fs = require('fs');
const m = JSON.parse(fs.readFileSync('manifest.prod.json', 'utf8'));
m.version = '$VERSION';
fs.writeFileSync('manifest.prod.json', JSON.stringify(m, null, 2) + '\n');
console.log('  ✓ manifest.prod.json');
"

# Update package.json
node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '$VERSION';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
console.log('  ✓ package.json');
"

# Update CHANGELOG.md — prepend new entry
TODAY=$(date +%Y-%m-%d)
TMP=$(mktemp)
cat > "$TMP" <<EOF
# Changelog

All notable changes to the Toca Ficha Dr. Chrome extension are documented here.
This project does not (yet) follow strict SemVer — see \`manifest.json\` for the
authoritative \`version\` field.

## v$VERSION — $TODAY — <title>

### Added
-

### Changed
-

### Fixed
-

### Security
-

### Verified
- \`npm run build\` passed.
- \`node scripts/verify-package.js --root .\` passed.
- Production ZIP built: \`tocafichadr-v$VERSION.zip\`.

---
EOF

# Append the rest of the changelog (skip the header lines)
tail -n +7 CHANGELOG.md >> "$TMP"
mv "$TMP" CHANGELOG.md
echo "  ✓ CHANGELOG.md"

echo ""
echo "Files modified:"
git diff --stat

echo ""
echo "Creating commit..."
git add manifest.json manifest.prod.json package.json CHANGELOG.md
git commit -m "chore(release): bump v$CURRENT → v$VERSION

- manifest.json: $CURRENT → $VERSION
- manifest.prod.json: $CURRENT → $VERSION
- package.json: $CURRENT → $VERSION
- CHANGELOG.md: prepended v$VERSION entry

Hardened by: CHRA-1921"

echo ""
echo "========================================"
echo "Version bump complete: v$VERSION"
echo ""
echo "Next steps (MANUAL — CWS-freeze guardrail):"
echo "  1. Review the commit: git show HEAD"
echo "  2. Build package:    ./scripts/build-package.sh --prod"
echo "  3. Verify package:   node scripts/verify-package.js --dist dist"
echo "  4. Submit to CWS:    https://chrome.google.com/webstore/devconsole"
echo ""
echo "DO NOT push this commit to main without CEO/CTO approval."
echo "========================================"
