#!/usr/bin/env bash
# Create the versioned GitHub Release for a tag from the verified assets, or settle the one an
# earlier attempt left.
#
# Usage: SUMS=<build's asset sums> GH_TOKEN=<token> GH_REPO=<owner/name> \
#          scripts/publish-versioned-release.sh <tag> <assets dir>
#
# The assets dir must hold exactly the files SUMS lists; this script checks that first.
#
#   No release for the tag         Create it with the verified assets.
#   Published, verified assets     Leave it: an earlier attempt created it.
#   Published, any other assets    Refuse, and change nothing: installed copies may have taken it.
#   Draft, verified assets         Publish it. gh release create uploads to a draft first, so an
#                                  interrupted attempt can leave one.
#   Draft, any other assets        Delete it and create the release again. A draft was never public.
#
# release.yml's Publish job runs this after its tag and channel checks and before it moves the
# update channel.
set -euo pipefail

tag=${1:?usage: publish-versioned-release.sh <tag> <assets dir>}
assets=${2:?usage: publish-versioned-release.sh <tag> <assets dir>}
: "${SUMS:?SUMS must hold the asset digests from the build job}"
: "${GH_REPO:?GH_REPO must name the repository as owner/name}"

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

if ! state=$(gh release view "$tag" --json isDraft,assets --jq '[.isDraft, (.assets | length)] | @tsv' 2>"$work/view-error"); then
  if grep -q "release not found" "$work/view-error"; then
    create
    echo "Created release $tag with the verified assets"
    exit 0
  fi
  echo "::error::Could not tell whether release $tag exists: $(cat "$work/view-error")"
  exit 1
fi

read -r is_draft asset_count <<<"$state"
verified=false
if [ "$asset_count" != 0 ]; then
  mkdir "$work/existing"
  gh release download "$tag" --dir "$work/existing"
  if report=$(bash "$here/verify-release-assets.sh" "$work/existing" 2>&1); then
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
    echo "::error::Release $tag is published with assets other than the ones this run verified. A published release is never changed, because installed copies may already have taken it (docs/RELEASE-CHECKLIST.md, section 5)."
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
    echo "::error::gh reported release $tag in a state this script does not know: '$state'"
    exit 1
    ;;
esac
