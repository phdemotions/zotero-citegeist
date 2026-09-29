/**
 * The cache's tables and its schema stamp (plan KTD11).
 *
 * The database records the schema that wrote it in `PRAGMA user_version`
 * (major × 1000 + minor). Init reads the stamp before any DDL, creates the
 * tables and stamps an unstamped or older database in one transaction, leaves a
 * newer minor alone, and opens a newer major (CG-DB03) or a stamp no release
 * writes (CG-DB04) read-only.
 */

import {
  CACHE_SCHEMA_MAJOR,
  CACHE_SCHEMA_MINOR,
  CACHE_SCHEMA_STAMP_MULTIPLIER,
  CACHE_SCHEMA_UNRECOGNISED_MAJOR,
} from "../../constants";
import { logError } from "../utils";
import { createAuthorSchema } from "./authors/db";
import { runRead, runWrite, type WriteTransaction } from "./db";

const ITEM_CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS item_cache (
  library_id                INTEGER NOT NULL,
  item_key                  TEXT NOT NULL,
  open_alex_id              TEXT,
  cited_by_count            INTEGER,
  fwci                      REAL,
  percentile                REAL,
  is_top_1_percent          INTEGER,
  is_top_10_percent         INTEGER,
  is_retracted              INTEGER,
  last_fetched              TEXT,
  source_id                 TEXT,
  citedness_2yr             REAL,
  journal_h_index           INTEGER,
  source_issns              TEXT,
  issn_l                    TEXT,
  no_match                  INTEGER,
  no_match_timestamp        TEXT,
  match_method              TEXT,
  match_confidence          TEXT,
  confirmed_open_alex_id    TEXT,
  pending_open_alex_id      TEXT,
  pending_title             TEXT,
  pending_cited_by_count    INTEGER,
  pending_fwci              REAL,
  pending_year              INTEGER,
  pending_tier              TEXT,
  pending_confidence        REAL,
  pending_doi               TEXT,
  PRIMARY KEY (library_id, item_key)
);
`;

const MIGRATION_PROGRESS_SCHEMA = `
CREATE TABLE IF NOT EXISTS migration_progress (
  library_id  INTEGER NOT NULL,
  item_key    TEXT NOT NULL,
  migrated_at TEXT NOT NULL,
  PRIMARY KEY (library_id, item_key)
);
`;

/** The `PRAGMA user_version` this build writes. Schema 1.0 is 1000. */
export const CURRENT_SCHEMA_STAMP =
  CACHE_SCHEMA_MAJOR * CACHE_SCHEMA_STAMP_MULTIPLIER + CACHE_SCHEMA_MINOR;

/**
 * What init does with the schema stamp it finds:
 * - `stamp`: unstamped (0, which every v2.0.x database holds) or an older
 *   schema, which includes every stamp from 1 to 999. Ensure the schema, then
 *   write the current stamp.
 * - `compatible`: this schema, or a newer minor of the same major. Ensure the
 *   schema and leave the stamp alone, so a newer minor is never lowered.
 * - `newer-major`: written by a build whose changes this one can't know. Open
 *   read-only (CG-DB03).
 * - `unrecognised`: negative, unreadable, or a major no release could have
 *   reached. Open read-only (CG-DB04), because the file, not this build, is the
 *   likely problem.
 */
export type SchemaStampVerdict = "stamp" | "compatible" | "newer-major" | "unrecognised";

export function classifySchemaStamp(stored: number): SchemaStampVerdict {
  if (!Number.isSafeInteger(stored) || stored < 0) return "unrecognised";
  const major = Math.floor(stored / CACHE_SCHEMA_STAMP_MULTIPLIER);
  if (major >= CACHE_SCHEMA_UNRECOGNISED_MAJOR) return "unrecognised";
  if (major > CACHE_SCHEMA_MAJOR) return "newer-major";
  return stored < CURRENT_SCHEMA_STAMP ? "stamp" : "compatible";
}

/** Why a read-only session refuses writes, for its notice and the report. */
export interface ReadOnlyCause {
  readonly code: "CG-DB03" | "CG-DB04";
  /** What the stamp said, e.g. "schema major 2" or "schema stamp -5 not recognised". */
  readonly found: string;
}

/** The read-only cause a verdict carries, or null when the database may be written. */
export function readOnlyCauseFor(
  verdict: SchemaStampVerdict,
  stored: number,
): ReadOnlyCause | null {
  if (verdict === "newer-major") {
    return {
      code: "CG-DB03",
      found: `schema major ${Math.floor(stored / CACHE_SCHEMA_STAMP_MULTIPLIER)}`,
    };
  }
  if (verdict === "unrecognised") {
    const found = Number.isNaN(stored)
      ? "schema stamp unreadable"
      : `schema stamp ${stored} not recognised`;
    return { code: "CG-DB04", found };
  }
  return null;
}

/**
 * Read `PRAGMA user_version`. A query failure propagates, because a database
 * that can't answer it can't be opened; so does reading a column the row lacks,
 * which Zotero's row Proxy turns into a throw. The host returns a number today;
 * a bigint or a numeric string is read as the number it spells. Anything else
 * comes back as NaN, which classifySchemaStamp treats as unrecognised, so the
 * database opens read-only and nothing is stamped over a value this build
 * couldn't read.
 */
export async function readSchemaStamp(conn: _ZoteroTypes.DBConnection): Promise<number> {
  const rows = await runRead<{ user_version: unknown }>(conn, "PRAGMA user_version", undefined, [
    "user_version",
  ]);
  const raw = rows.length > 0 ? rows[0].user_version : undefined;
  const stamp = coerceSchemaStamp(raw);
  if (Number.isNaN(stamp)) {
    Zotero.debug(`[Citegeist] PRAGMA user_version returned an unreadable ${typeof raw}`);
  }
  return stamp;
}

function coerceSchemaStamp(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "string" && /^\s*-?\d+\s*$/.test(raw)) return Number(raw);
  return Number.NaN;
}

/**
 * Create every table this schema defines and, when `needsStamp`, write the
 * current stamp, all on the caller's transaction: the stamp never commits
 * without the tables it names. A failed stamp write is logged, not thrown. The
 * tables are this schema's either way, so the transaction still commits them,
 * and the next startup stamps.
 */
export async function createSchema(tx: WriteTransaction, needsStamp: boolean): Promise<void> {
  await runWrite(tx, ITEM_CACHE_SCHEMA);
  await runWrite(tx, MIGRATION_PROGRESS_SCHEMA);
  // Author identity tables (additive, idempotent — plan KTD4).
  await createAuthorSchema(tx);
  if (!needsStamp) return;
  try {
    // PRAGMA takes no bound parameters; the value is a build-time integer.
    await runWrite(tx, `PRAGMA user_version = ${CURRENT_SCHEMA_STAMP}`);
  } catch (e) {
    logError("cache schema stamp", e);
  }
}
