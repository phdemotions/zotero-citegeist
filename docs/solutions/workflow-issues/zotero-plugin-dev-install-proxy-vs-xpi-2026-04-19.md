---
type: solution
title: "Zotero plugin dev install: proxy file vs XPI"
date: 2026-04-19
category: docs/solutions/workflow-issues
module: citegeist
problem_type: workflow_issue
component: development_workflow
severity: medium
root_cause: missing_workflow_step
resolution_type: workflow_improvement
applies_when:
  - Installing the plugin for ad-hoc testing or first-time verification
  - Setting up an ongoing dev loop with frequent rebuilds
  - Running or debugging the real-Zotero CI suite (npm run test:zotero)
tags:
  - zotero
  - plugin-install
  - proxy-file
  - xpi
  - dev-workflow
  - real-zotero-tests
  - zotero-plugin-scaffold
---

# Zotero plugin dev install: proxy file vs XPI

## Context

When testing a Citegeist build in Zotero, there are two installation approaches: a proxy file (live-reload pointer) and a built XPI package. The proxy file method caused confusion during a test install — the user saw no visible artifact and Zotero appeared unaffected after setup. The root cause was a combination of the invisible nature of the proxy file and a missed full-quit restart. The XPI build approach resolved the issue immediately.

**Decision rule: if someone says "install in Zotero," use the XPI approach. No exceptions.**

## Guidance

### Approach 1: XPI install — for ad-hoc testing

Produces a real file the user can see and installs through Zotero's native UI.

```bash
npm run build
# → build/citegeist-x.y.z.xpi
```

In Zotero: **Tools → Add-ons → gear icon → "Install Add-on From File…"** → select the `.xpi` → restart when prompted.

---

### Approach 2: Proxy file — for ongoing dev iteration

Creates a pointer file in Zotero's extensions directory that points to the live `build/addon/` directory. Zotero reads from that directory directly, so rebuilding source is reflected after a restart without reinstalling anything.

**Step 1 — Find the profile directory (macOS):**

```bash
ls ~/Library/Application\ Support/Zotero/Profiles/
# → e.g., abc123.default/
```

Or check which profile is active:

```bash
cat ~/Library/Application\ Support/Zotero/profiles.ini
```

**Step 2 — Verify the addon ID:**

```bash
node -e "const p = require('./package.json'); console.log(p.config.addonID)"
# → citegeist@opusvita.org
```

Or read from `addon/manifest.json` → `applications.zotero.id`. The proxy filename must exactly match this ID.

**Step 3 — Build and create the proxy file:**

```bash
npm run build:dev
# → populates build/addon/

echo -n "/absolute/path/to/citegeist/build/addon" > \
  ~/Library/Application\ Support/Zotero/Profiles/<profile-id>/extensions/citegeist@opusvita.org
```

**Step 4 — Full quit and reopen Zotero:**

Cmd+Q (not just closing the window). Wait for the process to exit fully. Reopen. This step is not optional — window close leaves the process running and the new extension pointer is ignored.

**Subsequent source changes:**

```bash
npm run build:dev
# then restart Zotero (Cmd+Q → reopen)
```

## Why This Matters

The proxy file leaves no visible artifact. There is nothing the user can point to and say "yes, this is installed." If anything goes wrong — wrong profile, wrong addon ID, Zotero not fully quit — the extension simply does not appear, with no error and no feedback.

The XPI approach fails loudly. If the build failed, there is no file. If Zotero rejects the install, it says so. The artifact exists on disk and can be independently verified. It uses the same mechanism as end-user installs, so any environment-specific failure surfaces immediately.

## When to Apply

| Situation | Use |
|---|---|
| First-time test install for any user | XPI |
| Ad-hoc "does this work on my machine" check | XPI |
| Active development with frequent rebuilds | Proxy file |
| Debugging a build pipeline or manifest issue | XPI (cleaner signal) |
| CI or automated test harness | XPI |
| Daily dev workflow where you control the environment | Proxy file |

## Examples

**Before (friction with proxy file):**

Claude creates a proxy file. User opens Zotero. Nothing appears. Claude asks for a full Cmd+Q restart. User does it. Still nothing. User says "I just don't see the XPI file anywhere." Claude builds the XPI. User installs it. Works immediately.

The proxy file approach created ambiguity at every step: was the file created correctly? Was it the right profile? Did Zotero actually fully quit? None of these questions have obvious answers during a live session.

**After (clean XPI path):**

```bash
npm run build
# → build/citegeist-1.3.0.xpi
```

"Open Zotero → Tools → Add-ons → gear icon → Install Add-on From File → select `build/citegeist-1.3.0.xpi` → restart when prompted."

The user sees the file. Zotero confirms the install. The restart is prompted by Zotero itself. No ambiguity.

## Real-Zotero suite (CI)

The XPI rule above is also how CI tests Citegeist against the host. `npm run test:zotero` runs the Mocha specs in `test/real-zotero/` inside a real Zotero, and the `real-zotero` job in `.github/workflows/ci.yml` runs them on Zotero 8.0.4, 9.0.6 and 10.0.2 on `ubuntu-24.04`. [zotero-plugin-scaffold](https://github.com/zotero-plugin-dev/zotero-plugin-scaffold), pinned at 0.9.2, supplies only the test runner; `scripts/build.mjs` and vitest are unchanged.

**What gets tested is the release XPI, byte for byte.** `zotero-plugin test` always runs scaffold's own build first, and that build empties its output directory, so the XPI cannot be unzipped straight into the directory scaffold loads. CI unzips `build/citegeist-<version>.xpi` into `.scaffold/xpi`. scaffold copies that tree into `.scaffold/build/addon`, with manifest generation, Fluent prefixing and pref-key prefixing all off in `zotero-plugin.config.ts`. The config's `test:prebuild` hook then fails the run unless the two trees are identical. Zotero installs the result as a temporary add-on.

**No request reaches OpenAlex.** The config's `test:init` hook starts a stub server on 127.0.0.1 and writes its URL into the hidden pref `extensions.zotero.citegeist.openAlexBaseUrl`. Citegeist honours that pref only for `127.0.0.1`, `[::1]` or `localhost`, and never attaches the `api_key` while it is in effect; any other value falls back to `https://api.openalex.org`.

**Running it yourself** needs Linux with Xvfb (scaffold's only headless platform) and a Zotero *release* build:

```bash
npm run build
rm -rf .scaffold/xpi && mkdir -p .scaffold/xpi && unzip -q build/citegeist-*.xpi -d .scaffold/xpi
export ZOTERO_PLUGIN_ZOTERO_BIN_PATH=/path/to/Zotero_linux-x86_64/zotero   # unset → scaffold downloads the beta channel
export ZOTERO_SETUP_COMPLETE=1 CITEGEIST_REAL_ZOTERO_LOG_DIR="$PWD/.scaffold/logs"
xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" npm run test:zotero
```

Things that behave differently from a manual install:

- An XPI whose `strict_max_version` is below the running Zotero is refused at install ("is not compatible with application version") before any spec runs. The Zotero 10 cell proves this with a negative control that lowers the staged cap to `9.*`.
- Beta and dev builds ignore `strict_max_version`, so the matrix pins release builds and the activation spec fails on any other.
- scaffold discards Zotero's stdout during tests. Debug Output and Zotero's error list come from the suite's root after-hook, written to `.scaffold/logs/` and uploaded when a cell fails.
- scaffold pastes `waitForPlugin` into a double-quoted string, so that condition must contain no double quote.

**Dev loop.** `npm start` was removed: it called a `scripts/start.mjs` that never existed. scaffold's `serve` would rebuild through scaffold's pipeline rather than `scripts/build.mjs`, so it is not a faithful dev loop for this repo. Use Approach 2 above (`npm run build:dev` plus the proxy file).

## Related

- [CONTRIBUTING.md](../../CONTRIBUTING.md) — documents the proxy file approach for ongoing dev work
- `docs/solutions/ui-bugs/misleading-citation-pane-metric-hierarchy-2026-04-19.md` — separate issue from same session (CSS visual hierarchy fix, not install)
