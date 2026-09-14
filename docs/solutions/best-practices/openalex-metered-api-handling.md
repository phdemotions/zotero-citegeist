---
type: solution
title: "Handling OpenAlex's metered API (July 2026)"
date: 2026-07-16
category: docs/solutions/best-practices
module: openalex
problem_type: best_practice
component: tooling
severity: high
applies_when: Any code that calls the OpenAlex API from Citegeist's fetch layer, or adds a new OpenAlex endpoint
related_components: [cache, citation-service]
tags: [openalex, metered-api, api-key, rate-limiting, budget, key-redaction, external-api, disambiguation]
---

# Handling OpenAlex's metered API (July 2026)

## Context

OpenAlex changed its model in mid-2026 and Citegeist's fetch layer was built on the old assumptions:

- **It went metered/paid** and **dropped the `mailto` polite pool**. Citegeist was still sending `mailto` (now silently ignored) and had no key or budget awareness.
- **The Authors entity was returning degraded data** (observed 2026-07-16): `/authors/{id}` aggregates (`works_count`, `cited_by_count`, `summary_stats.h_index/i10`) came back **zero** while the Works index was healthy and `/authors?search=` returned nothing.
- **Author/entity IDs churn** — a stored `A…`/`W…` id can `301`-redirect to a merged survivor.

Docs moved from `docs.openalex.org` to `developers.openalex.org`. Full external facts: the `reference_openalex_metered_2026` memory.

## Guidance

Implemented in `src/modules/openalex.ts`, `utils.ts`, `constants.ts` (Phase A / U1 of the author-identity layer):

1. **Optional, opt-in API key — never a default.** `PREF_OPENALEX_API_KEY` rides the query string (`buildUrl`). Anonymous requests still work at the lower daily budget. Do not bake in any default key or `mailto` (see the no-default-mailto convention).
2. **Redact the key centrally, at the single funnel.** The key is in the URL, and Zotero HTTP errors can carry the URL. Redact inside `normalizeError` (`redactApiKey`) — the one funnel every `logError` and raw `Zotero.debug(normalizeError(e))` call already uses — not at individual call sites. A call site can bypass `logError`; it cannot bypass `normalizeError`.
3. **Discriminate three failure modes, not one.** A `429` with `X-RateLimit-Remaining: 0` is **budget exhaustion** → `OpenAlexBudgetError` (no retry, prompt for a key); a `429` without that signal is transient → retry. `401/403` → `OpenAlexAuthError` (bad key). Everything else unreachable → `OpenAlexNetworkError`. All three are distinct so the UI can respond correctly.
4. **Derive author metrics from the works list, not the author object.** `/authors/{id}` aggregates are unreliable; compute `works_count` from `meta.count` and h-index from the works. (A hybrid — use aggregates when non-zero, derive when zero — is robust to the degradation healing.) Same "derive it" instinct as journal citedness.
5. **Persist the canonical id on 301.** `resolveCanonicalId(body)` reads `body.id` (short form) — persist that, not the id you requested, so a merged entity resolves to its survivor.
6. **Cost model to design against.** OpenAlex's own cost page (https://help.openalex.org/access/example-costs/, updated 2026-08-09, checked 2026-09-13) says retrieving one entity by ID or DOI is **free and unlimited and does not count against the daily budget**. List+filter (`/works?filter=…`) costs $0.10 per 1,000 calls, and search and semantic search cost $1 per 1,000. The daily budget is $0.10 without a key and $1 with a free key. So a whole-library identity backfill via `getWorkById` costs nothing, and neither do the columns' background lookups, which retrieve a single work by DOI, PMID, arXiv ID, ISBN or confirmed OpenAlex ID and never search. Free is not the same as unfailing: a rejected key (401/403) fails every request, free ones included, so any pass over many items stops at the first `OpenAlexAuthError`.

## Why This Matters

Getting this wrong fails in three quiet ways: a leaked API key in a debug log the user pastes into a public bug report; a spent daily budget rendered as "OpenAlex unavailable" (user never learns to add a key) or as "no author found" (a genuine no-match miscount); and misleadingly-precise author metrics read off an aggregate that is currently zero. Centralizing redaction and distinguishing the error types is what prevents each.

## When to Apply

- Any new OpenAlex call — route it through `rateLimitedFetch`; never hit the API directly.
- Adding a new endpoint (e.g. the `/authors` client): prefer the **free singleton** form where possible; reserve List+Filter for when you genuinely need a filtered set.
- Any surface that shows author metrics: source them from works, not the author aggregates.

## Examples

Before (obsolete — free/mailto assumptions):

```ts
// buildUrl attached a dead mailto; a single OpenAlexNetworkError for every non-200
if (mailto) params.mailto = mailto;
if (response.status !== 200) throw new OpenAlexNetworkError(...);
```

After (metered-aware):

```ts
// buildUrl attaches an opt-in api_key (redacted centrally in normalizeError)
const apiKey = getApiKey();
if (apiKey) params.api_key = apiKey;

// three distinct failure modes
if (response.status === 401 || response.status === 403) throw new OpenAlexAuthError(...);
if (response.status === 429 &&
    response.getResponseHeader?.("X-RateLimit-Remaining")?.trim() === "0") {
  throw new OpenAlexBudgetError(...);   // no retry — prompt for a key
}
// transient 429 / 5xx still retry; else OpenAlexNetworkError
```
