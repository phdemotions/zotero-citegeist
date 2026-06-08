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
