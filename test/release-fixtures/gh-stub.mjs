/**
 * A stand-in for the GitHub CLI in the release script tests. It keeps releases, tags and pull
 * requests in the JSON file GH_STUB_STATE names, and appends every call's arguments to GH_STUB_LOG.
 *
 * It holds the scripts to what the real gh and GitHub do:
 *
 * - With GH_TOKEN unset or empty it prints gh's own message and exits 4, as gh does
 *   (`gh help exit-codes`: "If a command requires authentication, the exit code will be 4").
 * - Every `gh api` call must send `-H "X-GitHub-Api-Version: 2022-11-28"`.
 * - `gh api --include` prints the HTTP status line and headers before the body, and an HTTP error
 *   exits 1 with "gh: <message> (HTTP <status>)" on stderr, as gh does.
 * - GET releases/tags/<tag> answers only a published release; a draft is a 404, as on GitHub.
 * - `gh release create --verify-tag` fails unless the tag exists.
 *
 * It knows only the calls the release scripts make, and exits 99 on any other, so a script that
 * starts making a new call fails its tests until the stub learns it.
 *
 * State: { releases: { <tag>: { isDraft, assets: { <name>: <content> }, downloads? } },
 *          tags: [<tag>], pulls: { <commit sha>: [<pull request>] },
 *          extraReleases: [<API release>], failRelease: <message>, failApi: <message>,
 *          apiStatus: { <path>: <HTTP status> }, failDownload: { <tag>: <message> } }
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const API_VERSION_HEADER = "X-GitHub-Api-Version: 2022-11-28";
const RELEASE_LISTING_JQ = ".[] | [.tag_name, .draft, (.assets | length)] | @tsv";

const args = process.argv.slice(2);
appendFileSync(process.env.GH_STUB_LOG, `${JSON.stringify(args)}\n`);
const state = JSON.parse(readFileSync(process.env.GH_STUB_STATE, "utf8"));
state.releases ??= {};

function exit(code, message) {
  if (message) process.stderr.write(`${message}\n`);
  process.exit(code);
}

function unsupported(why = "unsupported call") {
  exit(99, `gh stub: ${why}: gh ${args.join(" ")}`);
}

function save() {
  writeFileSync(process.env.GH_STUB_STATE, JSON.stringify(state, null, 2));
}

function valueOf(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

/** The arguments after `gh release <command> <tag>`, up to the first flag. */
function filesAfterTag() {
  const files = [];
  for (const arg of args.slice(3)) {
    if (arg.startsWith("-")) break;
    files.push(arg);
  }
  return files;
}

/** A list split the way the API pages it, 100 to a page. */
function pages(items) {
  const result = [];
  for (let i = 0; i < items.length; i += 100) result.push(items.slice(i, i + 100));
  return result.length > 0 ? result : [[]];
}

/** Every release as the REST API returns it, drafts included. */
function apiReleases() {
  const releases = Object.entries(state.releases).map(([tag, entry]) => ({
    tag_name: tag,
    draft: entry.isDraft,
    assets: Object.keys(entry.assets).map((name) => ({
      name,
      download_count: entry.downloads?.[name] ?? 0,
    })),
  }));
  return [...releases, ...(state.extraReleases ?? [])];
}

/** Prints a response the way `gh api --include` does, and exits as gh does for its status. */
function respond(status, reason, body) {
  process.stdout.write(
    `HTTP/2.0 ${status} ${reason}\nContent-Type: application/json; charset=utf-8\n` +
      `X-Github-Api-Version-Selected: 2022-11-28\n\n${JSON.stringify(body)}`,
  );
  if (status >= 400) exit(1, `gh: ${reason} (HTTP ${status})`);
  process.exit(0);
}

function release() {
  const [, command, tag] = args;
  if (state.failRelease) exit(1, state.failRelease);
  const existing = state.releases[tag];
  if (command !== "create" && !existing) exit(1, "release not found");

  if (command === "download") {
    const dir = valueOf("--dir");
    if (!dir) unsupported();
    if (state.failDownload?.[tag]) exit(1, state.failDownload[tag]);
    const pattern = valueOf("--pattern");
    const names = Object.keys(existing.assets).filter(
      (name) => pattern === undefined || name === pattern,
    );
    if (names.length === 0) exit(1, "no assets to download");
    mkdirSync(dir, { recursive: true });
    for (const name of names) {
      const target = join(dir, name);
      if (existsSync(target)) exit(1, `${target} already exists`);
      writeFileSync(target, existing.assets[name]);
    }
  } else if (command === "create") {
    if (existing) exit(1, `a release with the same tag name already exists: ${tag}`);
    if (args.includes("--verify-tag") && !(state.tags ?? []).includes(tag)) {
      exit(1, `tag ${tag} doesn't exist in the repo, aborting due to --verify-tag flag`);
    }
    const files = filesAfterTag();
    state.releases[tag] = {
      isDraft: args.includes("--draft"),
      assets: Object.fromEntries(files.map((file) => [basename(file), readFileSync(file, "utf8")])),
      flags: args.slice(3 + files.length),
    };
    save();
  } else if (command === "edit") {
    if (args.length !== 4 || args[3] !== "--draft=false") unsupported();
    existing.isDraft = false;
    save();
  } else if (command === "delete") {
    if (args.length !== 4 || args[3] !== "--yes") unsupported();
    delete state.releases[tag];
    save();
  } else if (command === "upload") {
    for (const file of filesAfterTag()) {
      const name = basename(file);
      if (name in existing.assets && !args.includes("--clobber")) {
        exit(1, `asset under the same name already exists: [${name}]`);
      }
      existing.assets[name] = readFileSync(file, "utf8");
    }
    save();
  } else {
    unsupported();
  }
}

function api() {
  const header = args.indexOf("-H");
  if (header === -1 || args[header + 1] !== API_VERSION_HEADER) {
    unsupported(`api call without -H "${API_VERSION_HEADER}"`);
  }
  if (state.failApi) exit(1, state.failApi);
  const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
  const status = state.apiStatus?.[path];
  if (args.includes("--include")) {
    if (args.includes("--paginate")) unsupported();
    const tag = /^repos\/[^/]+\/[^/]+\/releases\/tags\/([^/?]+)$/.exec(path)?.[1];
    if (tag === undefined) unsupported();
    if (status !== undefined) respond(status, "Bad Gateway", { message: "Bad Gateway" });
    const entry = state.releases[tag];
    if (!entry || entry.isDraft) {
      respond(404, "Not Found", {
        message: "Not Found",
        documentation_url:
          "https://docs.github.com/rest/releases/releases#get-a-release-by-tag-name",
        status: "404",
      });
    }
    respond(
      200,
      "OK",
      apiReleases().find((listed) => listed.tag_name === tag),
    );
  }
  if (!args.includes("--paginate")) unsupported();
  if (status !== undefined) exit(1, `gh: Bad Gateway (HTTP ${status})`);
  const pulls = /^repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]{40})\/pulls\?per_page=100$/.exec(path);
  const releases = /^repos\/[^/]+\/[^/]+\/releases\?per_page=100$/.test(path);
  const jq = valueOf("--jq");
  if (args.includes("--slurp")) {
    if (jq !== undefined) unsupported();
    if (pulls) {
      process.stdout.write(JSON.stringify(pages(state.pulls?.[pulls[1]] ?? [])));
    } else if (releases) {
      process.stdout.write(JSON.stringify(pages(apiReleases())));
    } else {
      unsupported();
    }
  } else if (releases && jq === RELEASE_LISTING_JQ) {
    for (const entry of apiReleases()) {
      process.stdout.write(`${entry.tag_name}\t${entry.draft}\t${entry.assets.length}\n`);
    }
  } else {
    unsupported();
  }
}

if (!process.env.GH_TOKEN) {
  exit(
    4,
    "To get started with GitHub CLI, please run:  gh auth login\n" +
      "Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.",
  );
}
if (args[0] === "release") release();
else if (args[0] === "api") api();
else unsupported();
