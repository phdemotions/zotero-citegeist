/**
 * A stand-in for the GitHub CLI in the release script tests. It keeps releases and pull requests in
 * the JSON file GH_STUB_STATE names, and appends every call's arguments to GH_STUB_LOG. It knows only
 * the calls the release scripts make, and exits 99 on any other, so a script that starts making a
 * new call fails its tests until the stub learns it.
 *
 * State: { releases: { <tag>: { isDraft, assets: { <name>: <content> }, downloads? } },
 *          pulls: { <commit sha>: [<pull request>] }, extraReleases: [<API release>],
 *          failRelease: <message>, failApi: <message> }
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
appendFileSync(process.env.GH_STUB_LOG, `${JSON.stringify(args)}\n`);
const state = JSON.parse(readFileSync(process.env.GH_STUB_STATE, "utf8"));
state.releases ??= {};

function exit(code, message) {
  if (message) process.stderr.write(`${message}\n`);
  process.exit(code);
}

function unsupported() {
  exit(99, `gh stub: unsupported call: gh ${args.join(" ")}`);
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

function view(tag, release) {
  const data = {};
  for (const field of (valueOf("--json") ?? "").split(",")) {
    if (field === "isDraft") data.isDraft = release.isDraft;
    else if (field === "tagName") data.tagName = tag;
    else if (field === "assets")
      data.assets = Object.keys(release.assets).map((name) => ({ name }));
    else unsupported();
  }
  const jq = valueOf("--jq");
  if (jq === undefined) {
    process.stdout.write(`${JSON.stringify(data)}\n`);
  } else if (jq === "[.isDraft, (.assets | length)] | @tsv") {
    process.stdout.write(`${data.isDraft}\t${data.assets.length}\n`);
  } else {
    unsupported();
  }
}

function release() {
  const [, command, tag] = args;
  if (state.failRelease) exit(1, state.failRelease);
  const existing = state.releases[tag];
  if (command !== "create" && !existing) exit(1, "release not found");

  if (command === "view") {
    view(tag, existing);
  } else if (command === "download") {
    const dir = valueOf("--dir");
    if (!dir) unsupported();
    const names = Object.keys(existing.assets);
    if (names.length === 0) exit(1, "no assets to download");
    mkdirSync(dir, { recursive: true });
    for (const name of names) {
      const target = join(dir, name);
      if (existsSync(target)) exit(1, `${target} already exists`);
      writeFileSync(target, existing.assets[name]);
    }
  } else if (command === "create") {
    if (existing) exit(1, `a release with the same tag name already exists: ${tag}`);
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
  if (!args.includes("--paginate") || !args.includes("--slurp")) unsupported();
  if (state.failApi) exit(1, state.failApi);
  const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
  const pulls = /^repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]{40})\/pulls\?per_page=100$/.exec(path);
  if (pulls) {
    process.stdout.write(JSON.stringify(pages(state.pulls?.[pulls[1]] ?? [])));
  } else if (/^repos\/[^/]+\/[^/]+\/releases\?per_page=100$/.test(path)) {
    const releases = Object.entries(state.releases).map(([tag, entry]) => ({
      tag_name: tag,
      draft: entry.isDraft,
      assets: Object.keys(entry.assets).map((name) => ({
        name,
        download_count: entry.downloads?.[name] ?? 0,
      })),
    }));
    process.stdout.write(JSON.stringify(pages([...releases, ...(state.extraReleases ?? [])])));
  } else {
    unsupported();
  }
}

if (args[0] === "release") release();
else if (args[0] === "api") api();
else unsupported();
