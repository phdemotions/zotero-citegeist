/**
 * Author profile data + view-model layer.
 *
 * Pure logic only — no DOM — so it is unit-tested directly (the pane/dialog
 * rendering is verified visually in Zotero, per the design gate): works-derived
 * metric formatting (the ≥ lower-bound labels), the profile + author-row
 * view-models ({@link buildProfileViewModel}, {@link buildAuthorRowViewModels}),
 * the pane's trend + creator helpers ({@link compactTrend},
 * {@link getAuthorCreators}), and the fetch-error to render-state mapping.
 *
 * The dialog's "author works" mode calls fetchAuthorProfile + buildProfileViewModel
 * directly for its hero; this module surfaces the pure pieces it composes.
 *
 * 301 merges (KTD3): a fetched profile can carry `redirectedFrom` when the
 * requested author id merged into a survivor; {@link maybeReconcileMerge}
 * rewrites the stored refs to the canonical survivor at the next fetch.
 */
import { type OpenAlexAuthorProfile } from "./openalexAuthors";
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

// Author link rows (drive the pane's Authors section)

export interface AuthorCreator {
  name: string;
  /** 0-based index among the item's author-type creators (the match key). */
  position: number;
}

export interface AuthorRowViewModel {
  /** 0-based author position (creator slot) — the match key. */
  position: number;
  /** Resolved author's name where known, else the Zotero creator's. */
  name: string;
  /** Resolved OpenAlex id, or null for a creator OpenAlex couldn't match. The
   *  pane filters on this: only rows with an id become clickable link rows. */
  authorId: string | null;
  /** e.g. "h 164", or null when uncached / no id. */
  hIndexLabel: string | null;
}

/**
 * Build the per-creator author rows: each author creator matched by position to
 * its resolved `item_authors` row. Positions with a resolved row but no creator
 * (OpenAlex listed more authors than the item's creators) are still included.
 * Position-matching is exact for Citegeist-added items and best-effort for
 * hand-entered ones. `authorId` is null when OpenAlex matched no author for the
 * slot; the pane drops those, keeping only clickable link rows.
 */
export function buildAuthorRowViewModels(
  authorCreators: ReadonlyArray<AuthorCreator>,
  itemAuthors: ReadonlyArray<ItemAuthorRow>,
  authorsById: ReadonlyMap<string, AuthorRow | null>,
): AuthorRowViewModel[] {
  const byPos = new Map<number, ItemAuthorRow>();
  for (const r of itemAuthors) if (r.author_position != null) byPos.set(r.author_position, r);
  const creatorByPos = new Map(authorCreators.map((c) => [c.position, c.name]));

  const positions = new Set<number>();
  for (const c of authorCreators) positions.add(c.position);
  for (const r of itemAuthors) if (r.author_position != null) positions.add(r.author_position);

  return [...positions]
    .sort((a, b) => a - b)
    .map((position): AuthorRowViewModel => {
      const resolved = byPos.get(position) ?? null;
      const creatorName = creatorByPos.get(position) ?? null;
      if (resolved) {
        const a = authorsById.get(resolved.author_id) ?? null;
        const h = a?.h_index ?? null;
        return {
          position,
          name: a?.display_name ?? creatorName ?? resolved.author_id,
          authorId: resolved.author_id,
          hIndexLabel: h !== null ? `h ${h.toLocaleString("en-US")}` : null,
        };
      }
      return {
        position,
        name: creatorName ?? "Unknown",
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
 * mode) so a merge heals at the next fetch.
 */
export function maybeReconcileMerge(p: OpenAlexAuthorProfile): void {
  if (!p.redirectedFrom) return;
  Zotero.debug(`[Citegeist] author ${p.redirectedFrom} merged → ${p.id}; reconciling`);
  reconcileAuthorMerge(p.redirectedFrom, p.id).catch((e) => logError("reconcileAuthorMerge", e));
}

// ────────────────────────────────────────────────────────
// Pane display helpers (pure; the pane imports these so they are unit-tested
// without the pane's DOM/import graph)
// ────────────────────────────────────────────────────────

/**
 * Compact trend token for the pane's supporting-metric line, e.g. "↗ +18% 2024".
 * Compares the most recent complete year to the one before it. Returns null when
 * there's no year data (the cached-only render path, where `work` is absent) or
 * nothing meaningful to say — the line omits the trend rather than pad it. The
 * `prior.cited_by_count > 0` guard is load-bearing: it prevents a divide-by-zero
 * that would render "Infinity%" to the user.
 */
export function compactTrend(work?: OpenAlexWork): string | null {
  if (!work?.counts_by_year || work.counts_by_year.length < 2) return null;
  const sorted = [...work.counts_by_year].sort((a, b) => b.year - a.year);
  const currentYear = new Date().getFullYear();
  const recent = sorted.find((y) => y.year === currentYear - 1) || sorted[0];
  const prior = sorted.find((y) => y.year === recent.year - 1);
  if (prior && prior.cited_by_count > 0) {
    const pct = Math.round(
      ((recent.cited_by_count - prior.cited_by_count) / prior.cited_by_count) * 100,
    );
    if (pct > 0) return `↗ +${pct}% ${recent.year}`;
    if (pct < 0) return `↘ ${pct}% ${recent.year}`;
    return `→ flat ${recent.year}`;
  }
  if (recent.cited_by_count > 0) return `${recent.cited_by_count} in ${recent.year}`;
  return null;
}

/**
 * The item's author-type creators, each carrying its 0-based index AMONG authors
 * (the position that aligns to OpenAlex `author_position` / the `item_authors`
 * write key). Non-author creators (editors, translators) are skipped WITHOUT
 * advancing the index, so an interleaved editor never shifts later authors onto
 * the wrong resolved row. When `Zotero.CreatorTypes.getID` is unavailable, every
 * creator is treated as an author (best-effort).
 */
export function getAuthorCreators(item: _ZoteroTypes.Item): AuthorCreator[] {
  let authorTypeID: number | undefined;
  try {
    authorTypeID = (
      Zotero as { CreatorTypes?: { getID?: (n: string) => number } }
    ).CreatorTypes?.getID?.("author");
  } catch {
    authorTypeID = undefined;
  }
  const creators = (item.getCreators?.() ?? []) as Array<{
    creatorTypeID?: number;
    lastName?: string;
    firstName?: string;
    name?: string;
  }>;
  const out: AuthorCreator[] = [];
  let authorIdx = 0;
  for (const c of creators) {
    const isAuthor =
      authorTypeID == null || c.creatorTypeID == null || c.creatorTypeID === authorTypeID;
    if (!isAuthor) continue;
    out.push({ name: creatorName(c) || `Author ${authorIdx + 1}`, position: authorIdx });
    authorIdx++;
  }
  return out;
}

function creatorName(c: { lastName?: string; firstName?: string; name?: string }): string {
  const last = (c.lastName || "").trim();
  const first = (c.firstName || "").trim();
  if (last && first) return `${last}, ${first}`;
  return last || (c.name || "").trim() || first;
}
