#!/usr/bin/env bash
# Fails if the target site's address or any real password value would be committed.
#
# The repo is public; the site and its credentials are not. The real password values and the site
# host must live only in the gitignored output directory, never in tracked or about-to-be-tracked
# files. Run before publishing.
#
# The values to look for are read at runtime from the gitignored out/ — the site host from .env, the
# real passwords from out/findings.json. That way this script names no secret itself, and it will
# not false-positive on the site's public decoy or on the fake passwords used in the test fixtures.

set -euo pipefail
cd "$(dirname "$0")/.."

# Collect the real secrets from gitignored sources (empty if those files are absent).
secrets=""
if [[ -f .env ]]; then
  secrets+="$(grep -E '^BASE_URL=' .env | sed -E 's#^BASE_URL=https?://##; s#/.*$##')"$'\n'
fi
if [[ -f out/findings.json ]]; then
  secrets+="$(node -e '
    const f = JSON.parse(require("fs").readFileSync("out/findings.json", "utf8"));
    const values = [...(f.passwords ?? []), f.outOfBand?.password].filter(Boolean);
    process.stdout.write(values.join("\n"));
  ')"$'\n'
fi

secrets="$(printf '%s\n' "$secrets" | grep -vE '^\s*$' | sort -u || true)"
if [[ -z "$secrets" ]]; then
  echo "nothing to check against (no .env or out/findings.json) — run crawl + analyze first"
  exit 0
fi

# Files git would track: everything tracked, plus currently-untracked-but-not-ignored.
files="$( { git ls-files; git ls-files --others --exclude-standard; } | sort -u )"

leaked=0
while IFS= read -r secret; do
  hits="$(printf '%s\n' "$files" | while read -r f; do
    [[ -f "$f" ]] && grep -HnF "$secret" "$f" 2>/dev/null || true
  done)"
  if [[ -n "$hits" ]]; then
    echo "LEAK — a secret appears in a committable file:"
    echo "$hits"
    leaked=1
  fi
done <<< "$secrets"

if [[ "$leaked" -eq 0 ]]; then
  echo "clean: no site address or real password value in any committable file"
  exit 0
fi
echo
echo "Refusing to vouch for a clean repo. Move the above into .env / the gitignored out/ directory."
exit 1
