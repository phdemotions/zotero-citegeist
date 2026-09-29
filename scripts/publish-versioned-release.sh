#!/usr/bin/env bash
# Create the versioned GitHub Release for a tag from the verified assets, or settle the one an
# earlier attempt left.
#
# Usage: SUMS=<build's asset sums> GH_TOKEN=<token> GH_REPO=<owner/name> \
#          scripts/publish-versioned-release.sh <tag> <assets dir>
#
# The assets dir must hold exactly the files SUMS lists; this script checks that first. The tag
# must already exist on GitHub: Publish creates it in the step before this one.
#
#   No release for the tag            Create it with the verified assets.
#   Published, verified assets        Leave it: an earlier attempt created it.
#   Published, any other assets, or   Refuse, and change nothing: installed copies may have
#   assets that cannot be downloaded  taken it.
#   Draft, verified assets            Publish it. gh release create uploads to a draft first, so
#                                     an interrupted attempt can leave one.
#   Draft, any other assets, or       Delete it and create the release again. A draft was never
#   assets that cannot be downloaded  public.
#   More than one release for the tag Refuse. GitHub allows several drafts for one tag, and which
#                                     to keep is the maintainer's call.
#
# It finds the tag's release in the full list of releases, drafts included, rather than by asking
# for the tag and reading an error message, so a failed lookup never reads as "no release".
set -euo pipefail

tag=${1:?usage: publish-versioned-release.sh <tag> <assets dir>}
assets=${2:?usage: publish-versioned-release.sh <tag> <assets dir>}
: "${SUMS:?SUMS must hold the asset digests from the build job}"
: "${GH_REPO:?GH_REPO must name the repository as owner/name}"

# Every GitHub REST call pins the API version; scripts/release-github.mjs says why.
api_version="X-GitHub-Api-Version: 2022-11-28"

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

bash "$here/verify-release-assets.sh" "$assets"

create() {
  local files=() name
  while read -r _ name; do
    files+=("$assets/$name")
  done <<<"$SUMS"
  gh release create "$tag" "${files[@]}" --verify-tag --generate-notes --title "$tag"
}

# One "<tag> <draft> <asset count>" line per release, drafts included, which Publish's token can
# see. A failed listing stops the script.
listing=$(gh api --paginate -H "$api_version" "repos/$GH_REPO/releases?per_page=100" \
  --jq '.[] | [.tag_name, .draft, (.assets | length)] | @tsv')
matches=()
while IFS=$'\t' read -r name draft count; do
  if [ "$name" = "$tag" ]; then
    matches+=("$draft $count")
  fi
done <<<"$listing"

case "${#matches[@]}" in
  0)
    create
    echo "Created release $tag with the verified assets"
    exit 0
    ;;
  1)
    read -r is_draft asset_count <<<"${matches[0]}"
    ;;
  *)
    echo "::error::GitHub lists ${#matches[@]} releases for $tag. Delete the drafts that should not publish, then re-run (docs/RELEASE-RUNBOOK.md, \"Re-run recovery\")."
    exit 1
    ;;
esac

verified=false
if [ "$asset_count" != 0 ]; then
  mkdir "$work/existing"
  if ! gh release download "$tag" --dir "$work/existing" 2>"$work/download-error"; then
    if [ "$is_draft" != true ]; then
      echo "::error::Could not download published release $tag's assets to check them: $(cat "$work/download-error"). A published release is never changed; re-run once GitHub serves them (docs/RELEASE-RUNBOOK.md, \"Re-run recovery\")."
      exit 1
    fi
    echo "Could not download draft release $tag's assets ($(cat "$work/download-error")), so they cannot be the verified ones"
  elif report=$(bash "$here/verify-release-assets.sh" "$work/existing" 2>&1); then
    verified=true
  else
    printf 'Release %s does not carry the verified assets:\n%s\n' "$tag" "${report//::error::/}"
  fi
fi

case "$is_draft:$verified" in
  false:true)
    echo "Release $tag is published with the verified assets; leaving it unchanged"
    ;;
  false:false)
    echo "::error::Release $tag is published with assets other than the ones this run verified. A published release is never changed, because installed copies may already have taken it (docs/RELEASE-RUNBOOK.md, \"Re-run recovery\")."
    exit 1
    ;;
  true:true)
    gh release edit "$tag" --draft=false
    echo "Published the draft release $tag, which carries the verified assets"
    ;;
  true:false)
    gh release delete "$tag" --yes
    create
    echo "Replaced the draft release $tag, whose assets were not the verified ones"
    ;;
  *)
    echo "::error::GitHub listed release $tag in a state this script does not know: '${matches[0]}'"
    exit 1
    ;;
esac
