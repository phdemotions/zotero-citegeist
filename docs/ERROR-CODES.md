---
type: reference
title: Citegeist — Diagnostic error codes
description: Every error code Citegeist can show a user, what it means, and what to do about it. Append-only public contract.
timestamp: 2026-07-20
tags: [citegeist, diagnostics, errors, support, reference]
---

# Diagnostic error codes

When Citegeist can't do something, it shows a short code — `CG-DB01`, `CG-API42`.
Quote that code in a GitHub issue and we know what happened without a round of
questions.

**Where to find yours:** the code appears under "Details" in the Citegeist panel
and in the citation-network browser whenever a load fails. For anything else — a
blank column, a menu that did nothing — open **Settings → Citegeist →
Troubleshooting** and click **Copy diagnostic report**. That report carries your Citegeist build, your Zotero
version, and every problem recorded since Zotero started. It carries no titles,
DOIs, or other content from your library, no API key, and no personal details
such as your username.

## Codes

| Code | What happened | What to do |
| ---- | ------------- | ---------- |
| `CG-NET01` | Couldn't reach OpenAlex. | Check your connection and try again in a few minutes. If it persists, [OpenAlex may be down](https://status.openalex.org). |
| `CG-API01` | OpenAlex rejected your API key. | Check the key in Citegeist settings, or clear it — Citegeist works fine anonymously on the free quota. |
| `CG-API42` | Today's OpenAlex request budget is used up. | It resets within 24 hours. A free [OpenAlex API key](https://openalex.org) raises the limit — paste it into **Settings → Citegeist → OpenAlex API key**. |
| `CG-API50` | OpenAlex returned an unexpected response. | Try again in a few minutes. If it repeats, file an issue with the report. |
| `CG-DB01` | Couldn't save to Citegeist's local database. | Most often a cloud-sync client holding the file. If your Zotero data folder is inside Dropbox, iCloud Drive, OneDrive or Box, pause sync and retry. |
| `CG-DB02` | Citegeist's local database couldn't be opened. | Restart Zotero. If it persists, quit Zotero and check that `citegeist.sqlite` in your data folder isn't quarantined by antivirus. |
| `CG-MATCH01` | The work isn't in OpenAlex. | Not an error — OpenAlex has no record of it. Nothing to fix. |
| `CG-MATCH02` | Not found by identifier, and no confident title match. | Add a DOI to the item; it's by far the most reliable identifier. |
| `CG-ID01` | The item has no recognized identifier. | Add a DOI, PMID, arXiv ID, or ISBN. |
| `CG-UI01` | Something went wrong drawing a panel. | Switch items and back, or restart Zotero. Worth reporting. |
| `CG-BUG01` | An unexpected problem — Citegeist couldn't classify it. | Always worth reporting. Copy the diagnostic report into a [new issue](https://github.com/phdemotions/zotero-citegeist/issues/new). |

## The contract (for contributors)

Codes are **append-only**. A code is a permanent public identifier: someone
quotes `CG-DB01` in an issue two years from now and it must still mean what it
meant when they hit it. Never renumber, never reuse, never repurpose. To retire
one, leave the entry in place with a note.

One code per **distinguishable user situation**, not per throw site. Two call
sites that leave the user in the same position with the same next step share a
code.

The registry lives in [`src/modules/diagnostics/codes.ts`](../src/modules/diagnostics/codes.ts)
and is the canonical source; this file is the human-facing mirror. Both the
append-only rule and the "every host callback is guarded" rule are enforced by
`test/diagnostics-guard-invariants.test.ts`, which runs in `npm test` and CI. If
that test fails, fix the code — never weaken the test.
