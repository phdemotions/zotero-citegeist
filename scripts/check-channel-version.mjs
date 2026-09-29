/**
 * Publish's check of the live update channel, before it creates a tag or a release or moves the
 * channel. Every installed copy reads releases/download/release/update.json, so the channel must
 * never move backwards, and a re-run of a publish must be safe.
 *
 * It reports one state, which Publish's later steps act on:
 *
 *   advance  The channel's newest version is older than this one. Publish.
 *   current  The channel's newest version is this one, and its update.json is byte for byte the
 *            one this run verified: an earlier attempt finished. Nothing to upload.
 *   first    No channel Release exists, and no release but this version's own was ever published.
 *            This is the first release.
 *   repair   The channel Release exists but its update.json is gone, as an interrupted
 *            `gh release upload --clobber` leaves it, and this run may restore it: this version's
 *            release is published with the verified assets, and no published release is newer.
 *
 * It refuses an older version, this version with other bytes, a channel that is not JSON, a
 * missing update.json this run may not restore, and a missing channel Release once other releases
 * have shipped. Whether a release exists is read from GitHub's HTTP status, a 404 and nothing
 * else (release-github.mjs). check-channel-version-cli.mjs runs it.
 *
 * Publish runs the runner image's own Node and installs nothing, so this file uses no dependency.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { bash, failureText, getOrNull, gh, listAll } from "./release-github.mjs";
import {
  assertReleaseVersion,
  compareVersions,
  newestVersion,
  releaseTag,
  releaseTagVersion,
} from "./version.mjs";

const RUNBOOK = "docs/RELEASE-RUNBOOK.md";
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SUM_LINE = /^([0-9a-f]{64}) {2}([A-Za-z0-9._-]+)$/;
const VERIFY_ASSETS = fileURLToPath(new URL("./verify-release-assets.sh", import.meta.url));

/** How the channel is fetched. Tests shorten the waits. */
export const FETCH_DEFAULTS = Object.freeze({
  /** Tries per fetch; a 5xx, a 429 or a network error is retried until they run out. */
  attempts: 3,
  /** The deadline for each try. */
  timeoutMs: 60_000,
  /** The wait before retrying a 5xx or a network error, and a 429 without a usable Retry-After. */
  retryDelayMs: 5_000,
  /** The longest a 429's Retry-After is honoured. */
  maxRetryAfterMs: 60_000,
  /** The wait before the one re-read of a 404 while this version's release exists. */
  clobberRetryDelayMs: 10_000,
});

/** @typedef {"advance" | "current" | "first" | "repair"} ChannelState */
/** @typedef {typeof FETCH_DEFAULTS} FetchOptions */

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
 * @param {{
 *   version: string,
 *   manifest: any,
 *   liveSha256: string,
 *   verifiedSha256: string,
 *   publishedSha256?: () => string | null,
 * }} options `publishedSha256` gives the SHA-256 of the update.json this version's published
 *   release carries, or null when there is none; it is asked only when the channel serves this
 *   version from bytes other than the verified ones.
 * @returns {{ state: ChannelState, message: string }}
 */
export function assessLiveChannel({
  version,
  manifest,
  liveSha256,
  verifiedSha256,
  publishedSha256 = () => null,
}) {
  assertReleaseVersion(version, "The release version");
  const listed = listedVersions(manifest).map((entry) =>
    assertReleaseVersion(entry, "The live update.json lists version"),
  );
  const newest = newestVersion(listed);
  const order = compareVersions(version, newest);
  if (order > 0) {
    return {
      state: "advance",
      message: `${version} is newer than every version on the live channel: ${listed.join(", ")}`,
    };
  }
  if (order < 0) {
    throw new Error(
      `${version} is older than ${newest}, which the live update channel already serves. ` +
        `Publishing it would move installed copies backwards (${RUNBOOK}, "Channel refusals").`,
    );
  }
  if (liveSha256 === verifiedSha256) {
    return {
      state: "current",
      message: `The live update channel already serves this run's verified update.json for ${version}`,
    };
  }
  const tag = releaseTag(version);
  const published = publishedSha256();
  if (published === liveSha256) {
    throw new Error(
      `Release ${tag} is already complete: the live update channel serves its published ` +
        `update.json byte for byte (sha256 ${liveSha256}). This attempt built other bytes ` +
        `(sha256 ${verifiedSha256}), as a change to the runner image between attempts can. ` +
        `Nothing is left to publish and no version is spent, so leave this run as it is ` +
        `(${RUNBOOK}, "Re-run recovery").`,
    );
  }
  throw new Error(
    `The live update channel already serves ${version} from an update.json (sha256 ` +
      `${liveSha256}) that is neither the one this run verified (sha256 ${verifiedSha256}) nor ` +
      (published === null
        ? `one release ${tag} carries, since it carries none. `
        : `release ${tag}'s own (sha256 ${published}). `) +
      `A version publishes once: find out what changed the channel before anything else, and ` +
      `ship any change as the next patch version (${RUNBOOK}, "The channel serves other bytes").`,
  );
}

/**
 * The state when the live update.json is missing (HTTP 404).
 * @param {{
 *   version: string,
 *   channelReleaseExists: boolean,
 *   release?: { isDraft: boolean, assetsVerified: boolean } | null,
 *   publishedTags?: string[],
 * }} options `release` is this version's release, null when it does not exist. `publishedTags`
 *   lists the tag of every published release.
 * @returns {{ state: ChannelState, message: string }}
 */
export function assessMissingChannel({
  version,
  channelReleaseExists,
  release = null,
  publishedTags = [],
}) {
  const tag = releaseTag(version);
  if (!channelReleaseExists) {
    const others = publishedTags.filter((published) => published !== tag);
    if (others.length > 0) {
      throw new Error(
        `No channel Release exists, but other releases have been published (` +
          `${others.slice(0, 5).join(", ")}${others.length > 5 ? ", …" : ""}), so the channel ` +
          `was deleted after a release shipped and installed copies find no update. This run ` +
          `does not start a new channel; restore it by hand (${RUNBOOK}, "The channel Release ` +
          `is gone").`,
      );
    }
    return {
      state: "first",
      message: `No update channel exists yet, so ${version} will be its first version`,
    };
  }
  const newer = publishedTags
    .map(releaseTagVersion)
    .filter((listed) => listed !== null && compareVersions(listed, version) > 0);
  const reason = !release
    ? `release ${tag} does not exist yet`
    : release.isDraft
      ? `release ${tag} is still a draft`
      : !release.assetsVerified
        ? `release ${tag} carries assets other than the ones this run verified`
        : newer.length > 0
          ? `${newestVersion(/** @type {string[]} */ (newer))} is a newer published release`
          : null;
  if (reason !== null) {
    throw new Error(
      `The channel Release has no update.json, so installed copies find no update, and this run ` +
        `may not restore it: ${reason}. Restore the channel from the newest published release's ` +
        `update.json with gh release upload release <update.json> --clobber (${RUNBOOK}, ` +
        `"The channel's update.json is missing").`,
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
 * @param {{
 *   version: string,
 *   url: string,
 *   sums: unknown,
 *   repository: string,
 *   env?: Record<string, string | undefined>,
 *   fetchOptions?: Partial<FetchOptions>,
 * }} options
 * @returns {Promise<{ state: ChannelState, message: string }>}
 */
export async function checkChannel({
  version,
  url,
  sums,
  repository,
  env = process.env,
  fetchOptions,
}) {
  const tag = releaseTag(version);
  const verifiedSha256 = parseSums(sums).get("update.json");
  if (!verifiedSha256) throw new Error("SUMS has no digest for update.json");
  if (!REPOSITORY.test(repository)) {
    throw new Error(`The repository must be owner/name, got ${JSON.stringify(repository)}`);
  }
  const options = { ...FETCH_DEFAULTS, ...fetchOptions };
  const run = { env };

  let response = await fetchChannel(url, options);
  if (response.status === 404) {
    const channel = getOrNull(
      `repos/${repository}/releases/tags/release`,
      "the channel Release",
      run,
    );
    if (channel === null) {
      return assessMissingChannel({
        version,
        channelReleaseExists: false,
        publishedTags: publishedTags(repository, env),
      });
    }
    // Only a published release answers here; a draft does not.
    const own = getOrNull(`repos/${repository}/releases/tags/${tag}`, `release ${tag}`, run);
    if (own !== null) {
      // A `gh release upload --clobber` deletes the old update.json before it uploads the new one,
      // so an upload in flight elsewhere, or one GitHub has not served yet, reads as missing.
      // Read once more before treating the channel as broken.
      await drain(response);
      await sleep(options.clobberRetryDelayMs);
      response = await fetchChannel(url, options);
    }
    if (response.status === 404) {
      const releases = listAll(
        `repos/${repository}/releases?per_page=100`,
        `${repository}'s releases`,
        run,
      );
      const draft = releases.some((entry) => entry?.tag_name === tag && entry?.draft !== false);
      return assessMissingChannel({
        version,
        channelReleaseExists: true,
        release:
          own !== null
            ? {
                isDraft: own.draft !== false,
                assetsVerified:
                  own.draft === false &&
                  Array.isArray(own.assets) &&
                  own.assets.length > 0 &&
                  releaseCarries(tag, sums, env),
              }
            : draft
              ? { isDraft: true, assetsVerified: false }
              : null,
        publishedTags: publishedTagsOf(releases),
      });
    }
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
  return assessLiveChannel({
    version,
    manifest,
    liveSha256,
    verifiedSha256,
    publishedSha256: () => publishedUpdateSha256(repository, tag, env),
  });
}

/**
 * GETs the channel, retrying a 5xx, a 429 (after its Retry-After) and a network error. fetch
 * follows the redirect GitHub answers with to the asset's storage host.
 * @param {string} url
 * @param {FetchOptions} options
 * @returns {Promise<Response>}
 */
async function fetchChannel(url, options) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs) });
    } catch (error) {
      if (attempt >= options.attempts) {
        throw new Error(`fetching ${url} failed ${attempt} times`, { cause: error });
      }
      await sleep(options.retryDelayMs);
      continue;
    }
    const lastTry = attempt >= options.attempts;
    if (response.status === 429 && !lastTry) {
      await drain(response);
      await sleep(retryAfterMs(response.headers.get("retry-after"), options));
      continue;
    }
    if (response.status >= 500 && !lastTry) {
      await drain(response);
      await sleep(options.retryDelayMs);
      continue;
    }
    return response;
  }
}

/**
 * How long a 429 asks to wait: Retry-After in seconds or as an HTTP date, capped.
 * @param {string | null} value
 * @param {FetchOptions} options
 */
export function retryAfterMs(value, options) {
  const text = (value ?? "").trim();
  const wait = /^\d+$/.test(text)
    ? Number(text) * 1000
    : Number.isNaN(Date.parse(text))
      ? options.retryDelayMs
      : Date.parse(text) - Date.now();
  return Math.min(Math.max(wait, 0), options.maxRetryAfterMs);
}

/** @param {Response} response */
async function drain(response) {
  try {
    await response.arrayBuffer();
  } catch {
    // The body is not needed.
  }
}

/**
 * The tag of every published (not draft) release.
 * @param {string} repository
 * @param {Record<string, string | undefined>} env
 */
function publishedTags(repository, env) {
  return publishedTagsOf(
    listAll(`repos/${repository}/releases?per_page=100`, `${repository}'s releases`, { env }),
  );
}

/** @param {any[]} releases */
function publishedTagsOf(releases) {
  return releases
    .filter((release) => release?.draft === false && typeof release?.tag_name === "string")
    .map((release) => release.tag_name);
}

/**
 * The SHA-256 of the update.json a published release carries, or null when the release is not
 * published or carries none.
 * @param {string} repository
 * @param {string} tag
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
function publishedUpdateSha256(repository, tag, env) {
  const release = getOrNull(`repos/${repository}/releases/tags/${tag}`, `release ${tag}`, { env });
  if (release === null || !release.assets?.some?.((asset) => asset?.name === "update.json")) {
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "citegeist-published-update-"));
  try {
    const download = gh(["release", "download", tag, "--pattern", "update.json", "--dir", dir], {
      env,
    });
    if (download.status !== 0) {
      throw new Error(
        `Could not download release ${tag}'s update.json to compare it: ${failureText(download)}`,
      );
    }
    return createHash("sha256")
      .update(readFileSync(join(dir, "update.json")))
      .digest("hex");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    const download = gh(["release", "download", tag, "--dir", dir], { env });
    if (download.status !== 0) {
      throw new Error(
        `Could not download release ${tag}'s assets to check them: ${failureText(download)}`,
      );
    }
    const check = bash([VERIFY_ASSETS, dir], { env: { ...env, SUMS: String(sums) } });
    return check.status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
