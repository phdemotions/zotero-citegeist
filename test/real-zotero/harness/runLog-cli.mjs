/**
 * Runs the run-log check (runLog.mjs) on a real-Zotero runner log:
 *
 *   node test/real-zotero/harness/runLog-cli.mjs passed <log>
 *   node test/real-zotero/harness/runLog-cli.mjs refused <log>
 *
 * It exits 1 unless the log proves what the mode names, and on a missing argument. This file does
 * nothing but run the check: an "is this the main module" test can come out false through a
 * symlinked path, and the check would then silently pass.
 */
import { runLogCli } from "./runLog.mjs";

process.exitCode = runLogCli(process.argv.slice(2));
