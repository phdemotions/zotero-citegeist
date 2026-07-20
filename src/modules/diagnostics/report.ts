/**
 * The copy-paste diagnostic report.
 *
 * This is the artifact that makes a GitHub issue actionable. Everything a
 * maintainer would otherwise have to ask for over three round trips — which
 * build, which Zotero, which platform, what failed, and what failed just
 * before it — is in one block the user can paste without knowing what any of
 * it means.
 *
 * Format is plain text, not JSON: it has to survive being pasted into a GitHub
 * comment by someone who won't wrap it in a code fence.
 */

import { describeCode } from "./codes";
import { recentDiagnostics } from "./record";
import { normalizeError } from "../utils";

/**
 * Build-time stamp injected by scripts/build.mjs. The version is held steady
 * across many iterations, so it can't identify a build — this can, and a report
 * that can't name its build has already cost us one long debugging detour.
 */
declare const __BUILD_ID__: string;

export interface ReportContext {
  /** The code the user is looking at right now, if any. */
  code?: string;
  /** Call-site label for that code, e.g. "cacheWorkData". */
  context?: string;
}

/**
 * Plugin version, supplied once by `hooks.onStartup` from the manifest.
 *
 * Held here rather than threaded through every caller: a report can be
 * requested from the item pane, the settings pane, or a future surface, and
 * none of them should have to carry the version to ask for one.
 */
let pluginVersion = "unknown";

export function setPluginVersion(version: string): void {
  pluginVersion = version;
}

/** Local wall-clock `HH:MM:SS` — the user's own clock, for matching to events. */
function clockTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Host facts, each read defensively.
 *
 * A diagnostics layer that throws while describing a crash is worse than
 * useless, and every one of these properties is a host API that a future
 * Zotero could move.
 */
function hostFacts(): string[] {
  const lines: string[] = [];
  const read = (label: string, fn: () => unknown) => {
    try {
      const v = fn();
      if (v !== undefined && v !== null && v !== "") lines.push(`${label}: ${String(v)}`);
    } catch {
      lines.push(`${label}: unavailable`);
    }
  };
  read("Zotero", () => Zotero.version);
  read("Platform", () => Zotero.platform);
  read("Locale", () => Zotero.locale);
  read(
    "Data dir",
    // The path itself is a privacy leak (it contains the account name), but
    // whether it sits in a sync folder is the single most useful fact for the
    // most common cache failure — so report the classification, never the path.
    () => {
      const dir = String(Zotero.DataDirectory?.dir ?? "");
      if (!dir) return "unknown";
      return /Dropbox|iCloud|CloudStorage|OneDrive|Google ?Drive|Box/i.test(dir)
        ? "inside a cloud-sync folder"
        : "local";
    },
  );
  return lines;
}

/**
 * Render the report. Never throws — on an internal failure it returns a short
 * report saying so, because a user staring at a broken "Copy report" button has
 * no path forward at all.
 */
export function buildDiagnosticReport(ctx: ReportContext): string {
  try {
    const lines: string[] = ["Citegeist diagnostic report", ""];

    lines.push(`Citegeist: ${pluginVersion} (build ${__BUILD_ID__})`);
    lines.push(...hostFacts());

    if (ctx.code) {
      const entry = describeCode(ctx.code);
      lines.push("", `Current problem: ${entry.code}${ctx.context ? ` at ${ctx.context}` : ""}`);
      lines.push(entry.message);
    }

    const history = recentDiagnostics();
    lines.push("", `Recent problems (${history.length}):`);
    if (!history.length) {
      lines.push("  none recorded this session");
    } else {
      for (const e of history) {
        lines.push(`  ${clockTime(e.at)}  ${e.code}  ${e.context}: ${e.detail}`);
      }
    }

    return lines.join("\n");
  } catch (e) {
    return `Citegeist diagnostic report\n\nThe report itself failed to build: ${normalizeError(e)}`;
  }
}
