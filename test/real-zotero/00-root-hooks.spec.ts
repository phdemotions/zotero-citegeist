/**
 * Root hooks for the real-Zotero suite (runs first: scaffold loads spec files in
 * name order). After every spec has run, whatever the outcome, Debug Output and
 * Zotero's error list are written to CITEGEIST_REAL_ZOTERO_LOG_DIR so CI can
 * upload them. scaffold itself discards Zotero's stdout during tests.
 */
after(async function () {
  const dir = Services.env.get("CITEGEIST_REAL_ZOTERO_LOG_DIR");
  if (!dir) return;
  await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
  const prefix = PathUtils.join(dir, `zotero-${Zotero.version}`);
  await IOUtils.writeUTF8(
    `${prefix}-debug-output.txt`,
    Zotero.Debug.getConsoleViewerOutput().join("\n"),
  );
  await IOUtils.writeUTF8(`${prefix}-errors.txt`, Zotero.getErrors(true).join("\n\n"));
});
