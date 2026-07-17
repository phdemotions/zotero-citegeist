/**
 * Author profile data + view-model layer (U7 of the author-identity layer).
 *
 * Placement-agnostic on purpose: this module holds only the PURE logic —
 * fetch orchestration, works-derived metric formatting (the ≥ lower-bound
 * labels from U6/KTD2), the fetch→state mapping, and row/header view-models.
 * The surfaces that consume it are built where they live:
 *   • the dedicated "Authors" pane section (U7a) uses {@link buildAuthorRowViewModels};
 *   • the citation-network dialog's "author works" mode (U7b) uses
 *     {@link loadAuthorProfile} + {@link buildProfileViewModel} for its hero header
 *     and the shared results list for the works.
 *
 * Keeping this layer pure means it is unit-testable without a DOM (the pane/
 * dialog rendering is verified visually in Zotero, per the design gate) and it
 * survives placement changes — the surface can move without touching the logic.
 *
 * 301 merges (KTD3): a loaded profile can carry `redirectedFrom` when the
 * requested author id merged into a survivor. The cross-item reconciliation
 * (rewrite `item_authors`, GC the orphan, re-assert the relation) lands with the
 * curation writes in U8; here we surface the canonical profile and log it.
 */

import {
  fetchAuthorProfile,
  fetchAuthorWorks,
  type OpenAlexAuthorProfile,
} from "./openalexAuthors";
import type { OpenAlexWork } from "./openalex";
import {
  updateAuthorMetrics,
  reconcileAuthorMerge,
  type AuthorRow,
  type ItemAuthorRow,
} from "./cache/authors";
import { OpenAlexBudgetError, OpenAlexAuthError, logError } from "./utils";

// ────────────────────────────────────────────────────────
// Metric formatting
// ────────────────────────────────────────────────────────

/**
 * Format a metric for display. A null/undefined value renders as an em dash; a
 * lower-bound value (derived + page-capped, per U6/KTD2) is prefixed with "≥".
 */
export function formatMetric(value: number | null | undefined, lowerBound: boolean): string {
  if (value === null || value === undefined) return "—";
  const s = value.toLocaleString("en-US");
  return lowerBound ? `≥ ${s}` : s;
}

// ────────────────────────────────────────────────────────
// Profile header view-model (drives the dialog's author-mode hero)
// ────────────────────────────────────────────────────────

export interface ProfileViewModel {
  name: string;
  /** Bare ORCID id (prefix stripped), or null. */
  orcid: string | null;
  orcidUrl: string | null;
  openAlexUrl: string;
  hIndex: string;
  i10Index: string;
  worksCount: string;
  citedByCount: string;
  /** True when hIndex/i10 are lower bounds — drives the ≥ footnote. */
  lowerBound: boolean;
}

/** Map an OpenAlex profile to display strings (≥ labels applied per KTD2). */
export function buildProfileViewModel(p: OpenAlexAuthorProfile): ProfileViewModel {
  const orcid = p.orcid ? p.orcid.replace(/^https?:\/\/orcid\.org\//i, "") : null;
  return {
    name: p.displayName ?? "Unknown author",
    orcid,
    orcidUrl: orcid ? `https://orcid.org/${orcid}` : null,
    openAlexUrl: `https://openalex.org/${p.id}`,
    // h-index / i10 carry the ≥ when derived-and-capped; works is always exact;
    // cited is null (→ em dash) when derived-and-capped (not summable), per U6.
    hIndex: formatMetric(p.hIndex, p.metricsAreLowerBound),
    i10Index: formatMetric(p.i10Index, p.metricsAreLowerBound),
    worksCount: formatMetric(p.worksCount, false),
    citedByCount: formatMetric(p.citedByCount, false),
    lowerBound: p.metricsAreLowerBound,
  };
}

// ────────────────────────────────────────────────────────
// Authors-section curation rows (drive the dedicated pane section, U8)
// ────────────────────────────────────────────────────────

/** Curation state of an author slot: user-confirmed, resolved-but-unconfirmed,
 *  or a creator OpenAlex couldn't match. */
export type CurationState = "verified" | "unverified" | "no-match";

export interface AuthorCreator {
  name: string;
  /** 0-based index among the item's author-type creators (the write key). */
  position: number;
}

export interface CurationRowViewModel {
  /** 0-based author position (creator slot) — the curation write key. */
  position: number;
  /** Resolved author's name where known, else the Zotero creator's. */
  name: string;
  state: CurationState;
  /** Resolved OpenAlex id, or null for a no-match creator. */
  authorId: string | null;
  /** e.g. "h 164", or null when uncached / no-match. */
  hIndexLabel: string | null;
}

/**
 * Build the per-creator curation rows: each author creator matched by position
 * to its resolved `item_authors` row, yielding a verified / unverified /
 * no-match state. Positions with a resolved row but no creator (OpenAlex listed
 * more authors than the item's creators) are still shown. Position-matching is
 * exact for Citegeist-added items and best-effort for hand-entered ones — the
 * user can always override.
 */
export function buildCurationRowViewModels(
  authorCreators: ReadonlyArray<AuthorCreator>,
  itemAuthors: ReadonlyArray<ItemAuthorRow>,
  authorsById: ReadonlyMap<string, AuthorRow | null>,
): CurationRowViewModel[] {
  const byPos = new Map<number, ItemAuthorRow>();
  for (const r of itemAuthors) if (r.author_position != null) byPos.set(r.author_position, r);
  const creatorByPos = new Map(authorCreators.map((c) => [c.position, c.name]));

  const positions = new Set<number>();
  for (const c of authorCreators) positions.add(c.position);
  for (const r of itemAuthors) if (r.author_position != null) positions.add(r.author_position);

  return [...positions]
    .sort((a, b) => a - b)
    .map((position): CurationRowViewModel => {
      const resolved = byPos.get(position) ?? null;
      const creatorName = creatorByPos.get(position) ?? null;
      if (resolved) {
        const a = authorsById.get(resolved.author_id) ?? null;
        const h = a?.h_index ?? null;
        return {
          position,
          name: a?.display_name ?? creatorName ?? resolved.author_id,
          state: resolved.is_curated === 1 ? "verified" : "unverified",
          authorId: resolved.author_id,
          hIndexLabel: h !== null ? `h ${h.toLocaleString("en-US")}` : null,
        };
      }
      return {
        position,
        name: creatorName ?? "Unknown",
        state: "no-match",
        authorId: null,
        hIndexLabel: null,
      };
    });
}

// ────────────────────────────────────────────────────────
// Fetch → render state
// ────────────────────────────────────────────────────────

/** The resolved state of an author-profile load — the render branches. */
export type ProfileState =
  | {
      kind: "ready";
      profile: OpenAlexAuthorProfile;
      works: OpenAlexWork[];
      nextCursor: string | null;
    }
  | { kind: "empty"; profile: OpenAlexAuthorProfile }
  | { kind: "budget" }
  | { kind: "auth" }
  | { kind: "network" }
  | { kind: "not-found" };

/** Map a thrown fetch error to its non-ready profile state. */
export function profileErrorState(
  e: unknown,
): Extract<ProfileState, { kind: "budget" | "auth" | "network" }> {
  if (e instanceof OpenAlexBudgetError) return { kind: "budget" };
  if (e instanceof OpenAlexAuthError) return { kind: "auth" };
  return { kind: "network" };
}

/**
 * Fetch an author's identity + first works page and resolve to a render state.
 * Persists exact metrics back to the cache (so the entry-row h-index hint fills
 * in) and logs a 301 redirect for later reconciliation (U8).
 */
export async function loadAuthorProfile(authorId: string): Promise<ProfileState> {
  try {
    const profile = await fetchAuthorProfile(authorId);
    if (!profile) return { kind: "not-found" };
    persistProfileMetrics(profile);
    maybeReconcileMerge(profile);
    const firstPage = await fetchAuthorWorks(profile.id);
    const works = firstPage.results ?? [];
    if (works.length === 0) return { kind: "empty", profile };
    return { kind: "ready", profile, works, nextCursor: firstPage.meta?.next_cursor ?? null };
  } catch (e) {
    logError(`loadAuthorProfile(${authorId})`, e);
    return profileErrorState(e);
  }
}

/**
 * Cache exact profile metrics so the Authors-section row hint shows them without
 * a re-fetch. Skips lower-bound (derived + capped) metrics so a ≥ value is never
 * later rendered as an exact number.
 */
export function persistProfileMetrics(p: OpenAlexAuthorProfile): void {
  if (p.metricsAreLowerBound) return;
  updateAuthorMetrics(p.id, {
    worksCount: p.worksCount,
    citedByCount: p.citedByCount,
    hIndex: p.hIndex,
    i10Index: p.i10Index,
    lastFetched: new Date().toISOString(),
  }).catch((e) => logError("persistProfileMetrics", e));
}

/**
 * On a 301 author-id merge (KTD3), reconcile stored `item_authors` refs to the
 * canonical survivor. No-ops unless `redirectedFrom` is set; fire-and-forget +
 * failure-isolated. Called wherever a profile is fetched (the dialog's author
 * mode, {@link loadAuthorProfile}) so a merge heals at the next fetch.
 */
export function maybeReconcileMerge(p: OpenAlexAuthorProfile): void {
  if (!p.redirectedFrom) return;
  Zotero.debug(`[Citegeist] author ${p.redirectedFrom} merged → ${p.id}; reconciling`);
  reconcileAuthorMerge(p.redirectedFrom, p.id).catch((e) => logError("reconcileAuthorMerge", e));
}
