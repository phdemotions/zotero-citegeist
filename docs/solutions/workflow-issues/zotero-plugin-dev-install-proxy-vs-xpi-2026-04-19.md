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
tags:
  - zotero
  - plugin-install
  - proxy-file
  - xpi
  - dev-workflow
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

## Related

- [CONTRIBUTING.md](../../CONTRIBUTING.md) — documents the proxy file approach for ongoing dev work
- `docs/solutions/ui-bugs/misleading-citation-pane-metric-hierarchy-2026-04-19.md` — separate issue from same session (CSS visual hierarchy fix, not install)
