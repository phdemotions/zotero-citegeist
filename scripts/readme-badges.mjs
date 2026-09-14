/**
 * The README's release and downloads badges, computed from every GitHub release.
 *
 * The badges are shields endpoint badges that read these JSON documents from the orphan `badges`
 * branch. The release badge names the newest published vMAJOR.MINOR.PATCH release, rather than
 * the tag of the run that refreshes it, so re-running an older run's refresh never shows an older
 * version. The downloads badge sums every release's .xpi downloads; update.json is left out,
 * because Zotero's auto-updater polls it on a schedule.
 *
 * release.yml's badges job runs readme-badges-cli.mjs on `gh api --paginate --slurp` output, one
 * JSON array per page, so no release past the first 100 is lost.
 */
import { isReleaseTag, newestFinalVersion } from "./release-tag.mjs";

/**
 * @param {unknown} pages the releases API's pages, each an array of releases
 * @returns {{ release: Record<string, unknown>, downloads: Record<string, unknown> }}
 */
export function badgeValues(pages) {
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    throw new Error("Expected the releases as an array of pages, each an array of releases");
  }
  const releases = pages.flat();
  const published = releases
    .filter((release) => release?.draft === false && isReleaseTag(release?.tag_name))
    .map((release) => release.tag_name.slice(1));
  if (published.length === 0) {
    throw new Error("There is no published vMAJOR.MINOR.PATCH release to show");
  }
  const downloads = releases
    .flatMap((release) => (Array.isArray(release?.assets) ? release.assets : []))
    .filter((asset) => typeof asset?.name === "string" && asset.name.endsWith(".xpi"))
    .reduce(
      (total, asset) =>
        total + (Number.isSafeInteger(asset.download_count) ? asset.download_count : 0),
      0,
    );
  return {
    release: {
      schemaVersion: 1,
      label: "release",
      message: `v${newestFinalVersion(published)}`,
      color: "5a9cff",
    },
    downloads: {
      schemaVersion: 1,
      label: "downloads",
      message: formatCount(downloads),
      color: "30d158",
    },
  };
}

/**
 * 999, then 1.0k, then 1.0M.
 * @param {number} count
 */
export function formatCount(count) {
  if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`;
  if (count >= 1e3) return `${(count / 1e3).toFixed(1)}k`;
  return String(count);
}
