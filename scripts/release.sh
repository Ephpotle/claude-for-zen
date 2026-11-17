#!/bin/bash
# One-command release of the add-on, the same way the song-catcher project does it.
#
#   ./scripts/release.sh            bump the patch version (0.2.0 -> 0.2.1) and release
#   ./scripts/release.sh 0.3.0      release a specific version
#   ./scripts/release.sh --sign-only [version]   sign, but do not publish
#
# Steps: set the version and update address in the manifest, have Mozilla sign
# the add-on as unlisted (AMO key from the environment or a vault, see below), then
# publish the signed .xpi and an updates.json as a GitHub Release. Installed
# copies check that updates.json and update themselves.
#
# The releases repository is public and holds only signed builds, never source.
set -euo pipefail

REPO="${CLAUDE_FOR_ZEN_RELEASES_REPO:-Ephpotle/claude-for-zen-releases}"
ADDON_ID="claude-for-zen@local"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$HERE/extension"
OUT="$HERE/dist"
# Machine-specific settings (not in the repository), e.g. RDM_CMD or CLAUDE_FOR_ZEN_RELEASES_REPO.
[ -f "$HERE/scripts/release.local.sh" ] && . "$HERE/scripts/release.local.sh"
REPO="${CLAUDE_FOR_ZEN_RELEASES_REPO:-$REPO}"
RDM="${RDM_CMD:-}"

PUBLISH=1
if [ "${1:-}" = "--sign-only" ]; then PUBLISH=0; shift; fi

cd "$HERE"
CUR=$(node -p "require('./extension/manifest.json').version")
NEW="${1:-$(node -p "const v='$CUR'.split('.');v[2]=+v[2]+1;v.join('.')")}"
UPDATE_URL="https://github.com/$REPO/releases/latest/download/updates.json"
echo "Releasing $CUR -> $NEW ($REPO)"

NEW="$NEW" UPDATE_URL="$UPDATE_URL" node -e "
const fs = require('fs');
const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));
manifest.version = process.env.NEW;
manifest.browser_specific_settings.gecko.update_url = process.env.UPDATE_URL;
fs.writeFileSync('extension/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = process.env.NEW;
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Sign. The secret only lives in this process's environment and is never printed.
# The AMO key comes from WEB_EXT_API_KEY / WEB_EXT_API_SECRET if they are set,
# otherwise from a Remote Desktop Manager vault entry through RDM_CMD.
if [ -z "${WEB_EXT_API_KEY:-}" ] || [ -z "${WEB_EXT_API_SECRET:-}" ]; then
  if [ -z "$RDM" ]; then
    echo "Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET (from addons.mozilla.org > Tools > Manage API Keys), or RDM_CMD." >&2
    exit 1
  fi
  creds=$("$RDM" get-apikey --name "${RDM_ENTRY:-mozilla_amo_api}")
  export WEB_EXT_API_KEY=$(printf '%s' "$creds" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).key")
  export WEB_EXT_API_SECRET=$(printf '%s' "$creds" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).secret")
  unset creds
fi
TMP=$(mktemp -d)
npx web-ext sign --channel=unlisted --source-dir "$SRC" --artifacts-dir "$TMP" --approval-timeout 900000 2>&1 \
  | sed -E "s/${WEB_EXT_API_SECRET}/[REDACTED]/g"
unset WEB_EXT_API_KEY WEB_EXT_API_SECRET
mkdir -p "$OUT"
XPI="$OUT/claude-for-zen-$NEW-signed.xpi"
mv "$TMP"/*.xpi "$XPI"; rm -rf "$TMP"
echo "Signed: $XPI"

if [ "$PUBLISH" = 0 ]; then
  echo "Not published (--sign-only). Install it from about:addons > gear > Install Add-on From File."
  exit 0
fi

# The releases repository, created on first use.
if ! gh repo view "$REPO" >/dev/null 2>&1; then
  gh repo create "$REPO" --public --add-readme \
    --description "Signed builds of Claude for Zen, an unofficial Zen/Firefox add-on that gives Claude Code browser tools. Not affiliated with Anthropic."
  sleep 3
fi

# updates.json pointing at this release's file.
STAGE=$(mktemp -d)
ASSET="claude-for-zen-$NEW.xpi"
cp "$XPI" "$STAGE/$ASSET"
ADDON_ID="$ADDON_ID" NEW="$NEW" LINK="https://github.com/$REPO/releases/download/v$NEW/$ASSET" XPI="$XPI" node -e "
const fs = require('fs');
const hash = 'sha256:' + require('crypto').createHash('sha256').update(fs.readFileSync(process.env.XPI)).digest('hex');
const updates = { addons: { [process.env.ADDON_ID]: { updates: [{ version: process.env.NEW, update_link: process.env.LINK, update_hash: hash }] } } };
process.stdout.write(JSON.stringify(updates, null, 2) + '\n');
" > "$STAGE/updates.json"

gh release create "v$NEW" --repo "$REPO" --title "Claude for Zen $NEW" --notes "Signed unlisted build." \
  "$STAGE/$ASSET" "$STAGE/updates.json"
rm -rf "$STAGE"

echo "Published v$NEW. Installed copies pick it up at their next update check"
echo "(about:addons > gear > Check for Updates to do it now)."
