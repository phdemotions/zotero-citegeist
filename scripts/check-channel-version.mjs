#!/usr/bin/env node
/**
 * Refuse a release whose version is not newer than every version on the live
 * update channel. release.yml's Publish job runs this before it creates the
 * versioned release or moves the channel.
 *
 * Without it, two tag runs finishing out of order, or an older tag's run re-run
 * after a newer release shipped, would put the older update.json back on the
 * channel: copies that had not updated yet would install the older build, and a
 * cap the newer entry raised would be lost.
 *
 * Usage: node scripts/check-channel-version.mjs <MAJOR.MINOR.PATCH> <update.json URL>
 *
 * Publish runs the runner image's own Node and installs nothing, so this file
 * uses Node built-ins only.
 */
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const FINAL_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FETCH_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 5_000;

/**
 * @param {unknown} version
 * @param {string} what
 * @returns {number[]}
 */
function parseFinal(version, what) {
  const match = typeof version === "string" ? FINAL_VERSION.exec(version) : null;
  if (!match) {
    throw new Error(`${what} ${JSON.stringify(version)} is not MAJOR.MINOR.PATCH`);
  }
  return match.slice(1).map(Number);
}

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
 * Throw unless `version` is newer than every version `manifest` lists.
 * @param {string} version
 * @param {any} manifest
 */
export function assertNewerThanChannel(version, manifest) {
  const candidate = parseFinal(version, "The release version");
  for (const listed of listedVersions(manifest)) {
    const current = parseFinal(listed, "The live update.json lists version");
    const order =
      candidate[0] - current[0] || candidate[1] - current[1] || candidate[2] - current[2];
    if (order <= 0) {
      throw new Error(
        `${version} is not newer than ${listed}, which the live update channel already serves. ` +
          "Re-run only the newest tag's run (docs/RELEASE-CHECKLIST.md, section 5).",
      );
    }
  }
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

/** @param {string[]} args */
async function main([version, url]) {
  if (!version || !url) {
    throw new Error(
      "usage: node scripts/check-channel-version.mjs <MAJOR.MINOR.PATCH> <update.json URL>",
    );
  }
  parseFinal(version, "The release version");

  const response = await fetchChannel(url);
  if (response.status === 404) {
    // Tolerated only while the channel Release does not exist at all: the first release.
    const view = spawnSync("gh", ["release", "view", "release", "--json", "tagName"], {
      encoding: "utf8",
    });
    if (view.status === 0) {
      throw new Error(
        `the release Release exists but ${url} is missing; restore its update.json before publishing`,
      );
    }
    if (!`${view.stderr}`.includes("release not found")) {
      throw new Error(
        `could not tell whether the release Release exists: ${view.stderr || view.error}`,
      );
    }
    console.log(`No update channel at ${url} yet, so ${version} will be its first version`);
    return;
  }
  if (!response.ok) {
    throw new Error(`fetching ${url} returned HTTP ${response.status}`);
  }

  const body = await response.text();
  let manifest;
  try {
    manifest = JSON.parse(body);
  } catch (error) {
    throw new Error(`${url} is not JSON: ${error instanceof Error ? error.message : error}`);
  }
  assertNewerThanChannel(version, manifest);
  console.log(
    `${version} is newer than every version on the live channel: ${listedVersions(manifest).join(", ")}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    // GitHub reads workflow commands from stdout.
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
