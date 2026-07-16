/**
 * Types + column metadata for the author identity tables.
 *
 * Mirrors the pattern in `../types.ts`: snake_case row types matching the
 * SQLite schema verbatim, a frozen `COLUMNS` tuple driving parameter binding,
 * and two compile-time gates (exhaustiveness + bind-shape). The gates are
 * hardcoded per row type in `../types.ts` — they do NOT auto-extend to new
 * tables, so each table below replicates them.
 *
 * Two tables:
 *   • authors      — one row per OpenAlex author (globally-unique `A…` id).
 *   • item_authors — join: which OpenAlex authors a library item's creators
 *                    resolve to. Composite PK `(library_id, item_key, author_id)`
 *                    because Zotero item keys are unique only *within* a library.
 */

import type { DbBool, SqliteBindValue } from "../types";

// ── authors ────────────────────────────────────────────────────────────────

/** Row mirroring the `authors` schema. Metrics are null until a profile fetch. */
export interface AuthorRow {
  author_id: string;
  display_name: string | null;
  orcid: string | null;
  works_count: number | null;
  cited_by_count: number | null;
  h_index: number | null;
  i10_index: number | null;
  last_fetched: string | null;
}

export const AUTHOR_COLUMNS = Object.freeze([
  "author_id",
  "display_name",
  "orcid",
  "works_count",
  "cited_by_count",
  "h_index",
  "i10_index",
  "last_fetched",
] as const);

// Compile-time exhaustiveness: adding a field to AuthorRow without adding it
// to AUTHOR_COLUMNS makes this resolve to `never` and fails the assignment.
type _AuthorColumnsCovered =
  Exclude<keyof AuthorRow, (typeof AUTHOR_COLUMNS)[number]> extends never ? true : never;
const _authorColumnsExhaustive: _AuthorColumnsCovered = true;
void _authorColumnsExhaustive;

// Compile-time bind-shape: every AuthorRow value must bind to SQLite.
type _AuthorRowIsBindShape = AuthorRow[keyof AuthorRow] extends SqliteBindValue ? true : never;
const _authorRowIsBindShape: _AuthorRowIsBindShape = true;
void _authorRowIsBindShape;

export function authorRowToParams(row: AuthorRow): SqliteBindValue[] {
  return AUTHOR_COLUMNS.map((c) => row[c]);
}

// ── item_authors ─────────────────────────────────────────────────────────

/** Row mirroring the `item_authors` schema (the item↔author join). */
export interface ItemAuthorRow {
  library_id: number;
  item_key: string;
  author_id: string;
  /** 0-based position of the creator on the work, for ordered display. */
  author_position: number | null;
  /** 1 when the user confirmed/overrode this identity (wins over refresh). */
  is_curated: DbBool;
}

export const ITEM_AUTHOR_COLUMNS = Object.freeze([
  "library_id",
  "item_key",
  "author_id",
  "author_position",
  "is_curated",
] as const);

type _ItemAuthorColumnsCovered =
  Exclude<keyof ItemAuthorRow, (typeof ITEM_AUTHOR_COLUMNS)[number]> extends never ? true : never;
const _itemAuthorColumnsExhaustive: _ItemAuthorColumnsCovered = true;
void _itemAuthorColumnsExhaustive;

type _ItemAuthorRowIsBindShape = ItemAuthorRow[keyof ItemAuthorRow] extends SqliteBindValue
  ? true
  : never;
const _itemAuthorRowIsBindShape: _ItemAuthorRowIsBindShape = true;
void _itemAuthorRowIsBindShape;

export function itemAuthorRowToParams(row: ItemAuthorRow): SqliteBindValue[] {
  return ITEM_AUTHOR_COLUMNS.map((c) => row[c]);
}

// ── Validation ─────────────────────────────────────────────────────────────

/**
 * OpenAlex author ID: literal `A` followed by 1–20 digits. Length-bounded so
 * a compromised/MITM'd response can't push an arbitrarily long value into a
 * SQLite key and a synced Zotero relation URI. Real OpenAlex ids are ~10 digits.
 */
const OPEN_ALEX_AUTHOR_ID_RE = /^A\d{1,20}$/;
const OPEN_ALEX_URL_PREFIX = "https://openalex.org/";

/**
 * Strip the OpenAlex URL prefix and validate the resulting author ID.
 * Returns null for anything that doesn't match `/^A\d{1,20}$/` — callers must
 * treat null as "reject this authorship" since a malformed id would otherwise
 * become a primary key and a synced relation URI.
 */
export function parseAuthorId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const id = raw.replace(OPEN_ALEX_URL_PREFIX, "");
  return OPEN_ALEX_AUTHOR_ID_RE.test(id) ? id : null;
}
