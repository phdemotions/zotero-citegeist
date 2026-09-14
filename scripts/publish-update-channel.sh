#!/usr/bin/env bash
# Publish an update.json to the auto-update channel: the GitHub Release named
# `release`, whose update.json asset every installed copy's manifest update_url
# reads (releases/download/release/update.json).
#
# Usage: GH_TOKEN=<token> GH_REPO=<owner/name> scripts/publish-update-channel.sh <path/to/update.json>
#
# release.yml's Publish job calls this after its tag and channel-version checks;
# the republish workflow (plan U15) will call it for cap raises. Every caller
# must run in the `release-channel` concurrency group so two publishes never
# interleave. It overwrites the channel's update.json by design and touches no
# versioned release.
set -euo pipefail

manifest=${1:?usage: publish-update-channel.sh <path/to/update.json>}
: "${GH_REPO:?GH_REPO must name the repository as owner/name}"

if [ "$(basename "$manifest")" != "update.json" ]; then
  echo "::error::$manifest must be named update.json: the asset name is the path Zotero requests"
  exit 1
fi
if [ ! -s "$manifest" ]; then
  echo "::error::$manifest is missing or empty"
  exit 1
fi

# The update_url path resolves only while a Release named `release` exists with
# update.json attached; moving the tag alone is not enough.
if ! gh release view release >/dev/null 2>&1; then
  gh release create release \
    --title "Auto-update channel" \
    --latest=false \
    --notes "Serves update.json for Zotero's built-in auto-updater. Do not download from here manually — install Citegeist from the latest versioned release."
fi
gh release upload release "$manifest" --clobber
echo "Published $manifest to the release channel of $GH_REPO"
