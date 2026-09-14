/**
 * Publish's check of the live update channel, before it creates a release or moves the channel.
 * Every installed copy reads releases/download/release/update.json, so the channel must never
 * move backwards, and a re-run of a publish must be safe.
 *
 * It reports one state, which Publish's later steps act on:
 *
 *   advance  The channel's newest version is older than this one. Publish.
 *   current  The channel's newest version is this one, and its update.json is byte for byte the
 *            one this run verified: an earlier attempt finished. Nothing to upload.
 *   first    No channel Release exists yet. This is the first release.
 *   repair   The channel Release exists but its update.json is gone, as an interrupted
 *            `gh release upload --clobber` leaves it, and this run may restore it: this tag's
 *            versioned release is published with the verified assets, and no published release
 *            is newer.
 *
 * It refuses an older version, this version with other bytes, a channel that is not JSON, and a
 * missing update.json this run may not restore. check-channel-version-cli.mjs runs it.
 *
 * Publish runs the runner image's own Node and installs nothing, so this file uses no dependency.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  compareFinalVersions,
  finalVersionParts,
  isReleaseTag,
  newestFinalVersion,
} from "./release-tag.mjs";

const PROCEDURE = "docs/RELEASE-CHECKLIST.md, section 5";
const FETCH_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 5_000;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SUM_LINE = /^([0-9a-f]{64}) {2}([A-Za-z0-9._-]+)$/;
const VERIFY_ASSETS = fileURLToPath(new URL("./verify-release-assets.sh", import.meta.url));

/** @typedef {"advance" | "current" | "first" | "repair"} ChannelState */

/**
 * Every version an update manifest lists, across all of its add-ons.
 * @param {any} manifest
 * @returns {unknown[]}
 */
export function listedVersions(manifest) {
  const addons = manifest?.addons;
  if (addons === null || typeof addons !== "object") {
    throw new Error("the live update.json has no addons object");
  }
  const versions = Object.values(addons).flatMap((addon) =>
    Array.isArray(addon?.updates) ? addon.updates.map((entry) => entry?.version) : [],
  );
  if (versions.length === 0) {
    throw new Error("the live update.json lists no versions");
  }
  return versions;
}

/**
 * The build job's asset-sums output, `<sha256>  <file name>` per line, as a name-to-digest map.
 * @param {unknown} sums
 * @returns {Map<string, string>}
 */
export function parseSums(sums) {
  const digests = new Map();
  for (const line of String(sums ?? "").split("\n")) {
    if (line === "") continue;
    const match = SUM_LINE.exec(line);
    if (!match) throw new Error(`SUMS line ${JSON.stringify(line)} is not "<sha256>  <file name>"`);
    if (digests.has(match[2])) throw new Error(`SUMS lists ${match[2]} twice`);
    digests.set(match[2], match[1]);
  }
  if (digests.size === 0) throw new Error("SUMS holds no asset digests");
  return digests;
}

/**
 * The state for a live update.json this run could read.
 * @param {{ version: string, manifest: any, liveSha256: string, verifiedSha256: string }} options
 * @returns {{ state: ChannelState, message: string }}
 */
export function assessLiveChannel({ version, manifest, liveSha256, verifiedSha256 }) {
  finalVersionParts(version, "The release version");
  const listed = listedVersions(manifest).map((entry) => {
    finalVersionParts(entry, "The live update.json lists version");
    return /** @type {string} */ (entry);
  });
  const newest = newestFinalVersion(listed);
  const order = compareFinalVersions(version, newest);
  if (order > 0) {
    return {
      state: "advance",
      message: `${version} is newer than every version on the live channel: ${listed.join(", ")}`,
    };
  }
  if (order < 0) {
    throw new Error(
      `${version} is older than ${newest}, which the live update channel already serves. ` +
        `Publishing it would move installed copies backwards (${PROCEDURE}).`,
    );
  }
  if (liveSha256 !== verifiedSha256) {
    throw new Error(
      `The live update channel already serves ${version}, from an update.json (sha256 ` +
        `${liveSha256}) other than the one this run verified (sha256 ${verifiedSha256}). A ` +
        `version publishes once; release the next patch version (${PROCEDURE}).`,
    );
  }
  return {
    state: "current",
    message: `The live update channel already serves this run's verified update.json for ${version}`,
  };
}

/**
 * The state when the live update.json is missing (HTTP 404).
 * @param {{
 *   version: string,
 *   channelReleaseExists: boolean,
 *   release?: { isDraft: boolean, assetsVerified: boolean } | null,
 *   publishedVersions?: string[],
 * }} options `release` is this tag's versioned release, null when it does not exist.
 *   `publishedVersions` lists the final versions of every published release.
 * @returns {{ state: ChannelState, message: string }}
 */
export function assessMissingChannel({
  version,
  channelReleaseExists,
  release = null,
  publishedVersions = [],
}) {
  finalVersionParts(version, "The release version");
  if (!channelReleaseExists) {
    return {
      state: "first",
      message: `No update channel exists yet, so ${version} will be its first version`,
    };
  }
  const tag = `v${version}`;
  const newer = publishedVersions.filter((listed) => compareFinalVersions(listed, version) > 0);
  const reason = !release
    ? `release ${tag} does not exist yet`
    : release.isDraft
      ? `release ${tag} is still a draft`
      : !release.assetsVerified
        ? `release ${tag} carries assets other than the ones this run verified`
        : newer.length > 0
          ? `${newestFinalVersion(newer)} is a newer published release`
          : null;
  if (reason !== null) {
    throw new Error(
      `The channel Release has no update.json, so installed copies find no update, and this run ` +
        `may not restore it: ${reason}. Restore the channel from the newest published release's ` +
        `update.json with gh release upload release <update.json> --clobber (${PROCEDURE}).`,
    );
  }
  return {
    state: "repair",
    message:
      `The channel Release has no update.json. Release ${tag} is published with this run's ` +
      "verified assets and no published release is newer, so this run restores the channel",
  };
}

/**
 * Reads the live channel and GitHub's releases, and returns the state Publish acts on.
 * @param {{ version: string, url: string, sums: unknown, repository: string, env?: Record<string, string | undefined> }} options
 * @returns {Promise<{ state: ChannelState, message: string }>}
 */
export async function checkChannel({ version, url, sums, repository, env = process.env }) {
  finalVersionParts(version, "The release version");
  const verifiedSha256 = parseSums(sums).get("update.json");
  if (!verifiedSha256) throw new Error("SUMS has no digest for update.json");
  if (!REPOSITORY.test(repository)) {
    throw new Error(`The repository must be owner/name, got ${JSON.stringify(repository)}`);
  }

  const response = await fetchChannel(url);
  if (response.status === 404) {
    if (viewRelease("release", env) === null) {
      return assessMissingChannel({ version, channelReleaseExists: false });
    }
    const tag = `v${version}`;
    const view = viewRelease(tag, env);
    const release =
      view === null
        ? null
        : {
            isDraft: view.isDraft,
            assetsVerified: !view.isDraft && view.assetCount > 0 && releaseCarries(tag, sums, env),
          };
    return assessMissingChannel({
      version,
      channelReleaseExists: true,
      release,
      publishedVersions: publishedFinalVersions(repository, env),
    });
  }
  if (!response.ok) {
    throw new Error(`fetching ${url} returned HTTP ${response.status}`);
  }

  const body = Buffer.from(await response.arrayBuffer());
  let manifest;
  try {
    manifest = JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new Error(`${url} is not JSON`, { cause: error });
  }
  const liveSha256 = createHash("sha256").update(body).digest("hex");
  return assessLiveChannel({ version, manifest, liveSha256, verifiedSha256 });
}

/** @param {string} url */
async function fetchChannel(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (response.status < 500 || attempt === FETCH_ATTEMPTS) return response;
    } catch (error) {
      if (attempt === FETCH_ATTEMPTS) throw error;
    }
    await sleep(RETRY_DELAY_MS);
  }
}

/**
 * A release's draft state and asset count, or null when GitHub has no release for the tag. gh finds
 * a draft by its pending tag name too.
 * @param {string} tag
 * @param {Record<string, string | undefined>} env
 * @returns {{ isDraft: boolean, assetCount: number } | null}
 */
function viewRelease(tag, env) {
  const result = spawnSync("gh", ["release", "view", tag, "--json", "isDraft,assets"], {
    encoding: "utf8",
    env,
  });
  if (result.status === 0) {
    let view;
    try {
      view = JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`gh release view ${tag} did not return JSON`, { cause: error });
    }
    // Anything but an explicit false counts as a draft, which can only refuse.
    return {
      isDraft: view?.isDraft !== false,
      assetCount: Array.isArray(view?.assets) ? view.assets.length : 0,
    };
  }
  if (`${result.stderr}`.includes("release not found")) return null;
  throw new Error(
    `Could not tell whether release ${tag} exists: ${(result.stderr || String(result.error)).trim()}`,
  );
}

/**
 * Whether a release's assets are exactly the verified ones, checked by the same script that checks
 * the downloaded artifact.
 * @param {string} tag
 * @param {unknown} sums
 * @param {Record<string, string | undefined>} env
 */
function releaseCarries(tag, sums, env) {
  const dir = mkdtempSync(join(tmpdir(), "citegeist-release-assets-"));
  try {
    const download = spawnSync("gh", ["release", "download", tag, "--dir", dir], {
      encoding: "utf8",
      env,
    });
    if (download.status !== 0) {
      throw new Error(
        `Could not download release ${tag}'s assets to check them: ` +
          (download.stderr || String(download.error)).trim(),
      );
    }
    const check = spawnSync("bash", [VERIFY_ASSETS, dir], {
      encoding: "utf8",
      env: { ...env, SUMS: String(sums) },
    });
    return check.status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The final versions of every published (not draft) release.
 * @param {string} repository
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
function publishedFinalVersions(repository, env) {
  const result = spawnSync(
    "gh",
    ["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`],
    { encoding: "utf8", env, maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(
      `Could not list ${repository}'s releases: ${(result.stderr || String(result.error)).trim()}`,
    );
  }
  let pages;
  try {
    pages = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`gh api did not return JSON for ${repository}'s releases`, { cause: error });
  }
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    throw new Error(`gh api did not return pages of releases for ${repository}`);
  }
  return pages
    .flat()
    .filter((release) => release?.draft === false && isReleaseTag(release?.tag_name))
    .map((release) => release.tag_name.slice(1));
}
