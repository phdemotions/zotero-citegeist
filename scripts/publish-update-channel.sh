#!/usr/bin/env bash
# Publish an update.json to the auto-update channel: the GitHub Release named `release`, whose
# update.json asset every installed copy's manifest update_url reads
# (releases/download/release/update.json).
#
# Usage: GH_TOKEN=<token> GH_REPO=<owner/name> scripts/publish-update-channel.sh <path/to/update.json>
#
# The Publish release workflow's Publish job calls this after its tag and channel checks, and a
# republish workflow for cap raises will too. Every caller must run in the `release-channel`
# concurrency group so two publishes never interleave. It overwrites the channel's update.json by
# design and touches no versioned release. `--clobber` deletes the old asset before uploading the
# new one, so an upload that fails part way leaves the channel with no update.json;
# docs/RELEASE-RUNBOOK.md ("The channel's update.json is missing") says how a re-run or a manual
# upload restores it.
set -euo pipefail

manifest=${1:?usage: publish-update-channel.sh <path/to/update.json>}
: "${GH_REPO:?GH_REPO must name the repository as owner/name}"

# Every GitHub REST call pins the API version; scripts/release-github.mjs says why.
api_version="X-GitHub-Api-Version: 2022-11-28"

if [ "$(basename "$manifest")" != "update.json" ]; then
  echo "::error::$manifest must be named update.json: the asset name is the path Zotero requests"
  exit 1
fi
if [ ! -s "$manifest" ]; then
  echo "::error::$manifest is missing or empty"
  exit 1
fi

errors=$(mktemp)
trap 'rm -f -- "$errors"' EXIT

# The update_url path resolves only while a Release named `release` exists with update.json
# attached; moving the tag alone is not enough. The status line gh prints with --include is
# GitHub's own, so only a real 404 counts as missing: a network failure, a missing token or a 5xx
# prints no 404 and stops here.
response=$(gh api --include -H "$api_version" "repos/$GH_REPO/releases/tags/release" 2>"$errors") || true
read -r _ status _ <<<"$response"
case "${status:-}" in
  200) ;;
  404)
    gh release create release \
      --title "Auto-update channel" \
      --latest=false \
      --notes "Serves update.json for Zotero's built-in auto-updater. Do not download from here manually — install Citegeist from the latest versioned release."
    ;;
  *)
    echo "::error::Could not tell whether the release channel exists (HTTP ${status:-no response}): $(cat "$errors")"
    exit 1
    ;;
esac
gh release upload release "$manifest" --clobber
echo "Published $manifest to the release channel of $GH_REPO"
