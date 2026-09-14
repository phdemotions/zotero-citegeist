#!/usr/bin/env bash
# Check that a directory holds exactly the release assets the build job recorded, byte for byte.
#
# Usage: SUMS="<sha256>  <file name>..." scripts/verify-release-assets.sh <dir>
#
# SUMS is the build job's asset-sums output: one "<64 hex digits>  <file name>" line per asset, as
# sha256sum prints it. The directory must hold those regular files and nothing else, and each must
# hash to its line. Publish runs this on the downloaded artifact, and on an existing release's
# assets before it decides what to do with that release.
#
# It uses GNU sha256sum when present, as on the runner, and shasum otherwise, as on macOS. With
# neither it fails.
set -euo pipefail

dir=${1:?usage: SUMS=... verify-release-assets.sh <dir>}
: "${SUMS:?SUMS must hold the asset digests from the build job}"

if printf '%s\n' "$SUMS" | grep -Evq '^[0-9a-f]{64}  [A-Za-z0-9._-]+$'; then
  echo "::error::SUMS has a line that is not \"<sha256>  <file name>\""
  exit 1
fi

cd -- "$dir"
shopt -s nullglob dotglob
files=(*)
for file in "${files[@]}"; do
  if [ ! -f "$file" ] || [ -L "$file" ]; then
    echo "::error::$dir/$file is not a regular file"
    exit 1
  fi
done
present=$(printf '%s\n' "${files[@]}" | sort)
listed=$(printf '%s\n' "$SUMS" | sed -E 's/^[0-9a-f]{64}  //' | sort)
if [ "${#files[@]}" -eq 0 ] || [ "$present" != "$listed" ]; then
  echo "::error::$dir holds [${present//$'\n'/ }], but the build recorded [${listed//$'\n'/ }]"
  exit 1
fi

version=$(sha256sum --version 2>/dev/null || true)
if [[ "$version" == *"GNU coreutils"* ]]; then
  printf '%s\n' "$SUMS" | sha256sum --check --strict
elif command -v shasum >/dev/null 2>&1; then
  printf '%s\n' "$SUMS" | shasum --algorithm 256 --check --strict
else
  echo "::error::Neither GNU sha256sum nor shasum is available to check the assets"
  exit 1
fi
