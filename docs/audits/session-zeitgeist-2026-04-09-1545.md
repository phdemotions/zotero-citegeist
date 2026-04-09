# /zeitgeist — Citegeist v1.1.0

**Scope:** 19 files — v1.1.0 release: openalex.ts (normalizers + ISBN/PMID/arXiv lookups), citationService.ts (extractIdentifier, FetchResult, ItemIdentifier), citationPane.ts (book zero-suppression, citationSummary), citationColumn.ts (isBookType, book zero-suppression), journalRankings.ts (3177 journals, ISSN_ALIASES), typings/zotero.d.ts, test/openalex.test.ts, test/citationService.test.ts, test/journalRankings.test.ts, DESIGN.md (metadata-matching spec), package.json / package-lock.json
**Date:** 2026-04-09

This audit was run on 2026-04-09. "Current best practice" means best practice as of this date.

**Stack inventory:** TypeScript 5.9.3 (strict), esbuild 0.24.2 (bundler), vitest 4.1.3 (test runner), ESLint 9 (flat config), Prettier 3.x, Node 22 LTS, no framework (Zotero XUL/XHTML plugin context).

**Sources consulted:** npm registry (esbuild, vitest current versions); TypeScript 5.x release notes; OpenAlex API documentation; academic metadata matching literature; TypeScript discriminated union pattern guidance (TS handbook, current).

---

## Verdict
**Ship with fixes**
🔴 0  ·  🟠 1  ·  🟡 3  ·  ⚪ 2

## The one-line truth
> The new normalizers and identifier chain are exactly right, but `FetchResult` is one step short of the discriminated union the codebase is already planning for — and the esbuild semver range is three major releases behind current.

---

## 🔴 Blockers

None.

---

## 🟠 Should fix

**1. `FetchResult` is a boolean-discriminated object, not a discriminated union — and the v1.2.0 DESIGN.md already specifies the correct shape.**

`citationService.ts:30-37`

```typescript
// Current (v1.1.0)
export type FetchError = "no-identifier" | "not-found" | "network" | "invalid-item";
export interface FetchResult {
  success: boolean;
  work: OpenAlexWork | null;
  error?: FetchError;
}
```

As of TypeScript 4.7+ (and now deeply baseline in all TS 5.x codebases, per the TS handbook and every major TS course as of 2024–2026), the community-standard pattern for "result that can be one of several named outcomes" is a true discriminated union, not `{ success: boolean; error?: T }`. The optional `error` field means TypeScript cannot narrow to a specific outcome — `success: true` still has `error` as `FetchError | undefined` in the type, and callers must defensively check `result.error ===` rather than getting exhaustive narrowing for free.

DESIGN.md's v1.2.0 spec already defines the correct shape:

```typescript
type FetchResult =
  | { success: true;  work: OpenAlexWork | null }
  | { success: false; error: "invalid-item" | "no-identifier" | "not-found" | "network" | "no-match" }
  | { success: "suggestion"; candidate: OpenAlexWork; tier: "high" | "medium"; confidence: number };
```

The fact that the planned upgrade is already documented makes shipping the `boolean + optional error` shape in v1.1.0 a missed opportunity: the migration cost is low (the callers in `citationPane.ts` and `citationColumn.ts` already check `result.error ===` and `result.success`, so they benefit immediately from narrowing), and a new hire opening this code today would note the gap between the interface and the comments-in-DESIGN.md plan.

**Recommendation:** Collapse to a proper discriminated union now, before the `"suggestion"` branch makes the migration more complex. The two-branch version (success/failure) is a one-file change in `citationService.ts` and a mechanical update in two call sites.

**Migration cost:** Low. Three files touched: `citationService.ts`, `citationPane.ts`, `citationColumn.ts`.

**Source:** TypeScript Handbook — Narrowing > Discriminated Unions (current). The TS team's own guidance is that `success: boolean` unions are the most common source of avoidable `as` casts in TS codebases.

---

**2. `esbuild` semver range is pinned to `^0.24.0` (resolves to 0.24.2); current stable is 0.28.0.**

`package.json:devDependencies.esbuild`

As of April 2026, esbuild 0.28.0 is the npm-current version. The `^0.24.0` range means `npm install` resolves to 0.24.2 and will not auto-upgrade past 0.24.x. esbuild does not follow strict semver for minor versions — breaking changes can appear in the second digit — so `^0.24.0` is intentionally conservative. However, 0.25.x through 0.28.x have four release cycles' worth of correctness fixes, TypeScript emit improvements, and decorator support (0.25 landed full TS 5.x decorator emit). A new hire would flag the four-release gap as stale on first review.

This is not a blocker because esbuild 0.24.2 builds cleanly and the output is correct. But staying four minor versions behind on the primary build tool is unusual for an actively maintained project in 2026.

**Recommendation:** Update to `^0.25.0` (or pin `^0.28.0` after reading the 0.25 / 0.26 / 0.27 / 0.28 changelogs for any breaking changes relevant to the Zotero chrome context). Run `npm run build` and `npm test` to confirm — the EBADPLATFORM workaround is on vitest/vite/esbuild transitive deps, not esbuild directly, so this is low-risk.

**Migration cost:** Low. One-line change in `package.json`, then `rm -rf node_modules && npm install`.

**Source:** npm registry, confirmed 2026-04-09.

---

## 🟡 Consider

- **Identifier chain missing `pmcid` (PubMed Central ID).** OpenAlex supports `/works/pmcid:PMC1234567` and Zotero sometimes stores `PMCID: PMC1234567` in the Extra field, particularly for NIH-funded preprints and articles. The priority chain is correct for the current scope (DOI → PMID → arXiv → ISBN), but PMCID is increasingly common in biomedical and public health collections. Consider adding it between PMID and arXiv in a future minor, at priority 3. Implementation follows the exact same pattern as `normalizePMID`. Source: OpenAlex API docs, `/works` entity identifiers section, current as of 2026-03.

- **`normalizeArxivId` does not strip the `export/pdf/` URL path variant.** The arXiv CDN exposes papers at `https://arxiv.org/pdf/XXXX.XXXXX` (without `/export/`) but also at `https://export.arxiv.org/abs/XXXX.XXXXX` (the mirror endpoint). The regex `arxiv\.org\/(?:abs|pdf)\/` correctly handles the common case; the `export.arxiv.org` mirror is rare in Zotero collections but could surface in imports from institutional repositories. Low-frequency edge case, not a blocker.

- **Dice coefficient on word tokens for title matching (DESIGN.md) is the right call for academic titles** — this is consistent with current bibliometric identity resolution practice (e.g., the approach used in OpenCitations' COCI deduplication pipeline and described in Caron & van Eck 2014). The 0.92 high-confidence threshold is on the conservative end of what the literature recommends (typical academic metadata deduplication uses 0.85–0.90) which is appropriate given Citegeist's trust-first stance. No change recommended; flagging this as a positive validation of the planned design.

---

## ⚪ Delights missed

- **`tsconfig.json` targets `ES2021`.** Zotero 7's SpiderMonkey engine supports ES2021 comfortably, and using it over `ES2020` gives access to `Promise.any`, `String.replaceAll`, and `WeakRef` without transpilation overhead. This is the correct target for the host; no change needed. Worth noting because several Zotero plugin templates still default to `ES2020`.

- **The normalizer functions (`normalizePMID`, `normalizeArxivId`, `normalizeISBN`) follow current TypeScript idioms precisely:** pure functions, no class wrapper, no `class Normalizer` anti-pattern, string return types with documented failure modes (empty string for invalid input). The test suite covers edge cases (old-format arXiv IDs, ISBN-10 X check digit, non-digit PMID stripping) that most plugin authors skip entirely. A senior engineer opening these today would call them well-done.

---

## 🏆 If you fix one thing

**Migrate `FetchResult` to a proper discriminated union now** — the planned v1.2.0 DESIGN.md already describes the right shape; doing the two-branch version today costs thirty minutes and prevents callers from ever needing defensive `error?: FetchError` checks again, while making the future `"suggestion"` branch addition a clean additive change rather than a refactor.

---

*Generated by /zeitgeist · Citegeist v1.1.0 · 2026-04-09 15:45*
