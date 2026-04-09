# /wiring — Citegeist
**Scope:** 19 files changed this session (v1.1.0 release): src/modules/openalex.ts, src/modules/citationService.ts, src/modules/citationPane.ts, src/modules/citationColumn.ts, src/data/journalRankings.ts, typings/zotero.d.ts, test/openalex.test.ts, test/citationService.test.ts, test/journalRankings.test.ts, DESIGN.md
**Date:** 2026-04-09

---

## Verdict
**Ship with fixes**
🔴 0  ·  🟠 2  ·  🟡 3  ·  ⚪ 2

## The one-line truth
> The `extractIdentifier` single-source-of-truth pattern is solid and the FetchResult type is well-shaped, but `isBookType` is silently duplicated between two modules and will drift the moment book types change.

---

## 🔴 Blockers

None.

---

## 🟠 Should fix

**1. `isBookType` is duplicated across two modules — `citationPane.ts:321` and `citationColumn.ts:18`**

Both files contain an identical inline implementation:
```typescript
// citationColumn.ts:18
function isBookType(item: _ZoteroTypes.Item): boolean {
  return item.itemType === "book" || item.itemType === "bookSection";
}

// citationPane.ts:321 (inlined, no name)
const isBook = item.itemType === "book" || item.itemType === "bookSection";
```

This is exactly the kind of divergence bug that hurts: when `bookChapter` or `encyclopediaArticle` gets added to the suppression list, whoever makes the change will find one callsite and miss the other. Extract to `src/modules/utils.ts` (already the shared utilities home) as `export function isBookType(item: _ZoteroTypes.Item): boolean`. Both modules already import from utils. This is a one-minute fix that eliminates a maintenance hazard.

**2. `citationPane.ts:209` — the "no identifier" message is frozen in v1.0 vocabulary but the identifier set now includes ISBN**

```typescript
container.innerHTML = `<div class="cg-no-doi">No DOI, PubMed ID, or arXiv ID found for this item.</div>`;
```

ISBN was added this session but the user-facing copy wasn't updated. A researcher with a book that has only an ISBN will see this message incorrectly — `extractIdentifier` will find the ISBN and proceed, but if the item has *no* identifier including no ISBN, this stale copy misleads them about why. Update to: `"No DOI, PubMed ID, arXiv ID, or ISBN found for this item."` The CSS class `cg-no-doi` is also misnamed for this broader context (harmless but confusing to the second developer). Consider renaming to `cg-no-identifier` in a future pass.

---

## 🟡 Consider

- **`FetchResult` interface uses optional `error?: FetchError` rather than a discriminated union.** The current shape is `{ success: boolean; work: OpenAlexWork | null; error?: FetchError }`. This means TypeScript cannot narrow `work` to non-null by checking `success === true` — callers still need a null check even on the happy path (visible in `citationPane.ts:235`: `result.success && result.work`). The planned v1.2.0 `"suggestion"` branch will make this worse because `success: "suggestion"` is a third value that breaks every `if (result.success)` check in the codebase. Before implementing v1.2.0, convert to a proper tagged union:
  ```typescript
  type FetchResult =
    | { status: "ok"; work: OpenAlexWork }
    | { status: "cached" }
    | { status: "error"; reason: FetchError }
  ```
  The v1.2.0 suggestion branch then adds cleanly as `| { status: "suggestion"; candidate: OpenAlexWork; tier: "high" | "medium"; confidence: number }` without touching `true/false` semantics anywhere.

- **`ISSN_ALIASES` direction is correct but the comment is slightly misleading.** The comment says "Maps e-ISSNs to their primary (print) ISSN" but a small fraction of the mappings are ISSN-L → variant rather than e-ISSN → print ISSN. The direction (alias → primary key in RANKINGS) is the right data structure — a flat de-aliasing map is simpler than storing multiple ISSNs per entry, and the module-level `issnMap` merge at build time is clean. No structural change needed; the comment should say "Maps secondary ISSNs to their ISSN-L (primary key in RANKINGS)" to be accurate.

- **`typings/zotero.d.ts` addition of `itemType: string` is correct but exposes a latent risk.** The field is declared as `string` with no union constraint. Every consumer of `item.itemType` now does raw string comparison (`=== "book"`) without any IDE nudge if a string is mistyped. This is the right tradeoff for a Zotero plugin (Zotero's type system is not ours to control), but it reinforces why the `isBookType` helper must live in one place — a typo in one of six scattered comparisons would be silent.

---

## ⚪ Delights missed

- The `extractIdentifier` function as written is a genuine win: single canonical function, tested at priority order, used identically by both the pane and column. Adding ISBN as step 6 slots in cleanly without disturbing anything above it. This is what "centralize the touchpoints" looks like in practice.

- The `ISSN_ALIASES` + flat `issnMap` merge approach in `journalRankings.ts` is the right call at this scale. Building the Map at module load time (not per-lookup) means zero per-lookup cost at runtime. The alternative — storing `string[]` ISSNs per entry — would make `lookupRanking` more complex with no measurable benefit given the static data.

---

## If you fix one thing
**Extract `isBookType` to `utils.ts`** — it costs five minutes, eliminates a guaranteed future drift bug, and keeps the suppression logic in one authoritative place when the item-type list inevitably grows.
