---
type: brainstorm
title: "Author identity layer — requirements"
description: Requirements brainstorm for resolving, curating, and surfacing OpenAlex author identity in Citegeist, with a Scholar-style author profile in the pane and a synced identity handoff for downstream tools.
timestamp: 2026-07-16
tags: [citegeist, brainstorm, authors, openalex, disambiguation, cache, obsidian]
date: 2026-07-16
topic: author-identity-layer
---

# Author Identity Layer

## Summary

Give Citegeist a first-class author layer. It resolves each library item's authors to their OpenAlex identity in the background, lets the user confirm or correct that identity so attribution is trustworthy, and adds a Google-Scholar-style author profile in the item pane — an author's full body of work and metrics, with one-click add-to-library. The curated identity persists in the plugin-owned SQLite store and is exposed as a synced, standards-based assertion that downstream tools (the user's Zotero→Obsidian pipeline) can read.

## Problem Frame

A Zotero creator is a bare name string — `firstName` / `lastName` / `creatorType`, no identifier (`typings/zotero.d.ts:34-39`). Two "J. Wang" entries are indistinguishable, and one person cited as "Baumeister, R." and "Baumeister, R. F." fragments into two apparent authors. OpenAlex already solves this: it disambiguates authorships to stable author IDs (ORCID-anchored where available), and Citegeist already receives that data on every work it fetches for metrics (`src/modules/openalex.ts:47-60`). But the code discards it at display and creator-mapping time (`src/modules/citationNetwork/actions.ts:327-348`).

Two costs follow. First, when the user's notes flow into Obsidian, a claim can't be reliably attributed to a specific person — "who is saying what" rests on name strings that silently collide or split. Second, to see what an author has written the user leaves Zotero for Google Scholar, even though the same publication record sits behind OpenAlex.

## Key Decisions

- **Identity and profile are separate concerns.** *Identity* (which OpenAlex author each creator is) already rides the metrics fetch, so resolving it library-wide costs no extra API calls. *Profile* (h-index, full publication list) needs a new `/authors` + `/works` fetch and happens on demand when an author is viewed. This split maps directly onto the two goals: cheap, always-on attribution vs. rich, occasional browsing.

- **Curation is confirm/override, not merge/split.** OpenAlex proposes the identity; the user can confirm it or override to the correct author when it is wrong or ambiguous, and that curated choice becomes the stored truth that wins over OpenAlex on refresh. This extends the existing confirmed-match pattern (`src/modules/cache/write.ts:206-246`). Rebuilding OpenAlex's clustering (merging two IDs, splitting one) is deliberately out of v1.

- **Source of truth is the plugin-owned SQLite store, not `Extra`.** v1.3.x namespaced data into `Extra`, users objected to the clutter, and v2.0.0 migrated the cache to `citegeist.sqlite` for exactly this reason. Author identity extends that store as normalized `authors` + `item_authors` tables (an item has many authors; an author has many items), never a bolted-on column and never an `Extra` payload.

- **The external handoff is a native Zotero relation, not an `Extra` string.** The curated identity is asserted as a Zotero item relation pointing at the OpenAlex author URI (`https://openalex.org/A…`). Relations are native, Zotero syncs them across devices, they are a semantic-web standard any tool can read, and they keep `Extra` clean. The assertion is item-level ("this paper is by author A…"); exact author position stays in SQLite. Fallback if the relations API proves unworkable: the pipeline reads `citegeist.sqlite` directly.

- **Front-end design is gated.** No visual surface in this feature is implemented without an approved front-end mockup. Any requirement below that renders UI (the pane profile, the curation affordance) must produce a mockup for explicit approval before implementation — the mockup gate blocks the build, not just the review.

## Requirements

**Author identity (foundation)**

- R1. Resolve each library item's authorships to their OpenAlex author identity (`author.id`, `display_name`, `orcid`) from data already fetched during metrics resolution — no additional API call for identity.
- R2. Persist resolved identity in the plugin-owned SQLite store using normalized `authors` and `item_authors` tables. Do not write identity to `Extra` and do not overload a single `item_cache` column.
- R3. Resolve identity across the whole library in the background, so attribution is populated for every item, mirroring the coverage model of the citation column rather than resolving only on view.
- R4. Capture ORCID as the strongest identity anchor whenever OpenAlex supplies it.

**Curation (confirm / override)**

- R5. In the pane, show the OpenAlex-resolved author for each creator and let the user confirm it.
- R6. Let the user override to the correct OpenAlex author when the resolution is wrong or ambiguous; the curated choice becomes the stored truth and takes precedence over OpenAlex on subsequent refreshes.
- R7. When OpenAlex offers no author match for a creator, surface that state and allow the creator to remain unresolved without blocking the rest of the item.

**External handoff**

- R8. Assert the curated identity as a native Zotero item relation to the OpenAlex author URI, so a syncing, standards-based, tool-agnostic record of "who wrote this" exists outside the plugin's private store.
- R9. Keep the handoff passive: Citegeist writes the assertion into Zotero and the user's external pipeline consumes it. Citegeist does not write to Obsidian or own the bridge.

**Author profile (pane, Scholar-style)**

- R10. Opening an author surfaces a profile in the pane: their full body of work plus summary metrics (h-index, i10-index, cited-by count, works count) sourced from the OpenAlex `/authors` and `/works` endpoints.
- R11. Make the profile actionable — any listed work can be added to the library, reusing the citation-network result rendering and add-to-library path (`src/modules/citationNetwork/results.ts:299-375`, `actions.ts:20-83`).
- R12. Fetch the profile on demand (only when an author is viewed) and paginate it the way the citation network already does, so a prolific author does not stall the pane.
- R13. Treat every profile and curation surface as gated by the front-end design decision above: an approved mockup precedes implementation.

## Acceptance Examples

- AE1. **Covers R6.** The user overrides creator "J. Smith" from OpenAlex `A111` to `A222`. On the next metrics refresh, the item still reports `A222`; OpenAlex's `A111` does not overwrite the curated choice.
- AE2. **Covers R6.** OpenAlex over-splits one real person across `A111` (some papers) and `A333` (others). In v1 the user overrides the `A333` items to `A111` one at a time; the system does not auto-merge the two IDs, and no merge tool is offered.
- AE3. **Covers R7.** A creator has no OpenAlex author match. The pane shows the creator as unresolved, the rest of the item's authors resolve normally, and the item can be revisited and resolved later.

## Scope Boundaries

**Deferred for later**

- A "My Authors" deduplicated, library-wide author index (browse every author across the library with their profile and item count) — wanted as the explicit v2 follow-up.
- Full merge/split correction of OpenAlex author clusters.
- New-work / new-citation author alerts (the "follow this author" side of Google Scholar).

**Outside this feature's identity**

- Citegeist writing into Obsidian directly, or a companion Obsidian plugin — the external pipeline consumes the Zotero-side assertion; Citegeist stays a Zotero plugin.
- Re-implementing author disambiguation; OpenAlex remains the identity engine, with a curation layer on top.

## Dependencies / Assumptions

- **Zotero relations API is currently unused and untyped in Citegeist** — a grep of `src/` and `typings/` for relation methods returns nothing, and the hand-maintained `typings/zotero.d.ts` declares no relations surface on the item. R8 assumes native Zotero exposes syncing item relations; planning must verify this against the live API and extend the typings. If it does not hold, the documented fallback is direct `citegeist.sqlite` reads by the pipeline.
- **The OpenAlex `/authors` endpoint is net-new client surface.** The client today only ever calls `/works` (`src/modules/openalex.ts`). R10 adds `/authors/{id}` and `author.id`-filtered `/works` calls, both routed through the existing `rateLimitedFetch`.
- **New schema.** The `authors` / `item_authors` tables are additive to `citegeist.sqlite` (`src/modules/cache/db.ts:28-58`) and must honor the compile-time column-exhaustiveness gate in `src/modules/cache/types.ts:191-193`.
- **Identity resolution depends on `authorships` staying in the fetch selection** (`src/modules/openalex.ts:255`, `:262`) and in `normalizeWork` (`:464-468`); losing that field silently disables R1.

## Outstanding Questions

**Deferred to planning**

- Exact column shape of the `authors` / `item_authors` tables.
- The relation predicate to assert (e.g. `owl:sameAs` vs. a `dc:creator`-style term) and whether to also assert affiliation.
- How the confirm/override affordance attaches within the pane (subject to the mockup gate).
- Whether background resolution backfills already-cached items or only populates on the next per-item refresh.

## Sources / Research

- Authorships (with `author.id` / `orcid`) parsed and retained: `src/modules/openalex.ts:47-60`, `:464-468`; discarded downstream at `src/modules/citationNetwork/actions.ts:327-348` and `formatAuthors` (`src/modules/openalex.ts:610`).
- Curated-truth pattern to extend: `src/modules/cache/write.ts:206-246` (SQLite write) and `:292-333` (the `Extra` mirror it deliberately keeps minimal); recovery at `src/modules/cache/migration.ts:237-262`.
- Cache schema + exhaustiveness gate: `src/modules/cache/db.ts:28-58`, `src/modules/cache/types.ts:158-193`.
- Relations unused; creator carries no identifier: grep of `src/` + `typings/` (zero matches), `typings/zotero.d.ts:34-39`.
- Reusable surfaces: pane section `src/modules/citationPane.ts:200`, tree column `src/modules/citationColumn.ts:216`, menus `src/modules/menu.ts:75`; works-list render + add-to-library `src/modules/citationNetwork/results.ts:299-375`, `actions.ts:20-83`.
