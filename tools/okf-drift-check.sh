#!/usr/bin/env bash
# OKF upstream drift check.
# Compares the pinned OKF SPEC commit (docs/STANDARDS.md) to the current upstream
# HEAD of okf/SPEC.md in GoogleCloudPlatform/knowledge-catalog.
# Exit: 0 = in sync · 3 = DRIFT · 2 = error. Never re-pins automatically.
set -uo pipefail
cd "$(dirname "$0")/.."

PINNED=$(grep -i 'Pinned commit' docs/STANDARDS.md | grep -oE '[a-f0-9]{40}' | head -1)
if [ -z "${PINNED:-}" ]; then
  echo "ERROR: no pinned commit found in docs/STANDARDS.md"; exit 2
fi

HEAD=$(gh api 'repos/GoogleCloudPlatform/knowledge-catalog/commits?path=okf/SPEC.md&per_page=1' \
  --jq '.[0].sha' 2>/dev/null)
if [ -z "${HEAD:-}" ]; then
  echo "ERROR: could not fetch upstream HEAD (gh auth / network?)"; exit 2
fi

if [ "$PINNED" = "$HEAD" ]; then
  echo "OKF: in sync — pinned ${PINNED:0:12} == upstream HEAD"
  exit 0
fi

echo "OKF DRIFT DETECTED"
echo "  pinned:   $PINNED"
echo "  upstream: $HEAD"
echo "  diff:     https://github.com/GoogleCloudPlatform/knowledge-catalog/compare/${PINNED}...${HEAD}"
echo "  action:   review the okf/SPEC.md diff, update conforming docs, then re-pin in"
echo "            ~/developer/docs/standards/okf-adoption.md (canonical) + docs/STANDARDS.md."
exit 3
