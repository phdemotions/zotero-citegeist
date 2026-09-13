export function readBuildMetadata(pkg) {
  const config = pkg.config ?? {};

  return {
    addonName: requiredString(config, "addonName", "package.json config.addonName"),
    addonID: requiredString(config, "addonID", "package.json config.addonID"),
    addonRef: requiredString(config, "addonRef", "package.json config.addonRef"),
    addonInstance: requiredString(config, "addonInstance", "package.json config.addonInstance"),
    prefsPrefix: requiredString(config, "prefsPrefix", "package.json config.prefsPrefix"),
    zoteroMinVersion: requiredString(
      config,
      "zoteroMinVersion",
      "package.json config.zoteroMinVersion",
    ),
    zoteroMaxVersion: requiredString(
      config,
      "zoteroMaxVersion",
      "package.json config.zoteroMaxVersion",
    ),
    version: requiredString(pkg, "version", "package.json version"),
  };
}

function requiredString(source, key, label) {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function placeholdersFor(meta) {
  return {
    __addonName__: meta.addonName,
    __addonID__: meta.addonID,
    __addonRef__: meta.addonRef,
    __addonInstance__: meta.addonInstance,
    __buildVersion__: meta.version,
    __prefsPrefix__: meta.prefsPrefix,
    __zoteroMinVersion__: meta.zoteroMinVersion,
    __zoteroMaxVersion__: meta.zoteroMaxVersion,
  };
}

export function updateManifestFor(meta, xpiName, hash) {
  return {
    addons: {
      [meta.addonID]: {
        updates: [
          {
            version: meta.version,
            update_link: `https://github.com/phdemotions/zotero-citegeist/releases/download/v${meta.version}/${xpiName}`,
            update_hash: `sha256:${hash}`,
            applications: {
              zotero: {
                strict_min_version: meta.zoteroMinVersion,
                strict_max_version: meta.zoteroMaxVersion,
              },
            },
          },
        ],
      },
    },
  };
}

// A placeholder is lowerCamelCase between double underscores, like every key in
// `placeholdersFor` (a test holds each key to this shape). Matching the shape
// rather than the known names means a misspelt placeholder still fails, while
// esbuild's `/* @__PURE__ */` annotations and the `__BUILD_ID__` define do not.
const PLACEHOLDER_TOKEN = /__[a-z][A-Za-z0-9]*__/g;

// Legacy ECMAScript accessors share that shape but are real JavaScript.
const JS_DUNDER_NAMES = new Set([
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/**
 * Throws if any shipped text file still holds a `__name__` placeholder, naming
 * each file and token.
 *
 * @param {Array<{ path: string, content: string }>} files
 */
export function assertNoUnreplacedPlaceholders(files) {
  const leftovers = [];
  for (const { path, content } of files) {
    const tokens = new Set(
      (content.match(PLACEHOLDER_TOKEN) ?? []).filter((token) => !JS_DUNDER_NAMES.has(token)),
    );
    if (tokens.size > 0) {
      leftovers.push(`  ${path}: ${[...tokens].join(", ")}`);
    }
  }
  if (leftovers.length > 0) {
    throw new Error(`Unreplaced build placeholders in shipped files:\n${leftovers.join("\n")}`);
  }
}

/**
 * Throws unless an `applications.zotero` block declares exactly the range in
 * package.json. `label` names where the block came from.
 */
export function assertZoteroRange(label, zotero, meta) {
  const min = zotero?.strict_min_version;
  const max = zotero?.strict_max_version;
  if (min !== meta.zoteroMinVersion || max !== meta.zoteroMaxVersion) {
    throw new Error(
      `${label} has strict_min_version ${JSON.stringify(min)} and strict_max_version ` +
        `${JSON.stringify(max)}, but package.json config has zoteroMinVersion ` +
        `${JSON.stringify(meta.zoteroMinVersion)} and zoteroMaxVersion ` +
        `${JSON.stringify(meta.zoteroMaxVersion)}`,
    );
  }
}

/**
 * Finds update.json's entry for the version being built and throws unless it
 * declares package.json's range. Returns the verified `applications.zotero` block.
 */
export function assertUpdateManifestRange(updateManifest, meta) {
  const updates = updateManifest?.addons?.[meta.addonID]?.updates;
  const entries = Array.isArray(updates)
    ? updates.filter((entry) => entry?.version === meta.version)
    : [];
  if (entries.length !== 1) {
    throw new Error(
      `update.json must have exactly one entry for ${meta.addonID} ${meta.version}, ` +
        `found ${entries.length}`,
    );
  }
  const zotero = entries[0].applications?.zotero;
  assertZoteroRange(`update.json entry for ${meta.version}`, zotero, meta);
  return zotero;
}
