#!/usr/bin/env bash
# OKF conformance check for Citegeist's docs/ bundle.
# Open Knowledge Format v0.1 — pinned in docs/STANDARDS.md.
# Asserts: every non-reserved, non-exempt docs/**/*.md has YAML frontmatter with a
# non-empty `type`; reserved docs/index.md exists and declares okf_version.
# Exempt: docs/paper/** (JOSS paper.md has its own required frontmatter contract).
# Usage: bash tools/okf-check.sh   (exit 0 = conformant, 1 = violations)
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
while IFS= read -r f; do
  base=$(basename "$f")
  [ "$base" = "index.md" ] && continue
  [ "$base" = "log.md" ] && continue
  if [ "$(head -1 "$f")" != "---" ]; then
    echo "NO-FRONTMATTER: $f"; fail=1; continue
  fi
  awk 'NR>1 && /^---$/{exit} NR>1 && /^type:[[:space:]]*[^[:space:]]/{found=1} END{exit !found}' "$f" \
    || { echo "NO-TYPE: $f"; fail=1; }
done < <(find docs -name '*.md' -not -path 'docs/paper/*')

[ -f docs/index.md ] || { echo "MISSING: docs/index.md (OKF reserved catalog)"; fail=1; }
grep -q 'okf_version' docs/index.md 2>/dev/null || { echo "MISSING: okf_version in docs/index.md"; fail=1; }

if [ "$fail" = 0 ]; then
  echo "OKF: docs/ bundle conformant (v0.1)"
else
  echo "OKF: conformance FAILED — see above"; exit 1
fi
