---
type: standard
title: Citegeist — Documentation & knowledge standard (OKF)
description: Citegeist's docs/ tree conforms to the Open Knowledge Format (OKF v0.1); how we apply it and track the upstream spec.
timestamp: 2026-06-15
tags: [citegeist, standard, okf, documentation, future-proofing]
---

# Documentation standard — Open Knowledge Format (OKF)

Citegeist's [`docs/`](index.md) tree is an **OKF bundle**: a directory of markdown
files with YAML frontmatter — human- and agent-readable, diffable, portable. This
file is the explicit, pinned conformance statement for the plugin.

## Pin (future-proofing starts with a known baseline)

> **Canonical org standard:** [`~/developer/docs/standards/okf-adoption.md`](../../../docs/standards/okf-adoption.md).
> This file is Citegeist's per-product instance + bundle conformance; the pin below
> **mirrors** the canonical `okf_pin` — re-pin there first, then here.

- **Spec:** Open Knowledge Format — `GoogleCloudPlatform/knowledge-catalog` → `okf/SPEC.md`
- **Version:** `0.1` (Draft)
- **Pinned commit:** `ee67a5ca27044ebe7c38385f5b6cffc2305a9c1a` (2026-06-12)
- **Retrieved:** 2026-06-15
- OKF is a **draft, actively-changing** spec. We pin a commit and re-check upstream
  on a schedule — never silently track `main`. Chasing an unstable draft is the
  opposite of future-proofing.

## Scope — what OKF does and does NOT cover

- ✅ **Documentation / knowledge** — the `docs/` bundle (design rationale, migration
  notes, status, issues, backlog, plans, brainstorms, solutions, audits).
- ❌ **Code syntax** — OKF is a knowledge format, not a linter. Citegeist's code
  conventions stay where they already live: TypeScript strict (`tsc --noEmit`),
  ESLint 9 flat config, Prettier, and the "every magic number in `src/constants.ts`"
  rule (see [`CLAUDE.md`](../CLAUDE.md)). "OKF for our coding" means our code
  _knowledge_ — the architecture decisions in [`DESIGN.md`](DESIGN.md), the
  principles in `CLAUDE.md` — is captured as OKF-conformant docs. It does **not**
  mean OKF governs `.ts` syntax; that stays with the toolchain.
- **Repo-root operational docs** (`README.md`, `CLAUDE.md`, `CHANGELOG.md`,
  `CONTRIBUTING.md`, `CITATION.cff`) live outside `docs/` and are **not** part of
  the bundle — kept in their own established formats (Keep-a-Changelog, CFF, …).
- **`docs/paper/`** is **exempt**: the JOSS `paper.md` carries its own required
  frontmatter contract (title/tags/authors/affiliations/bibliography). `okf-check.sh`
  skips it.

## How we conform

- Every non-reserved, non-exempt `docs/**/*.md` carries YAML frontmatter with a
  non-empty **`type`** (required) plus recommended `title`, `description`,
  `timestamp` (ISO 8601), and `tags`.
- Existing extension keys are preserved (`date`, `topic`, `category`, `module`,
  `status`, `origin`, …) — OKF consumers tolerate unknown keys.
- Reserved files: **`index.md`** (catalog; declares `okf_version`) and, if added,
  **`log.md`** (date-grouped history, newest first).
- **Permissive consumers** — never reject a doc for a missing optional field, an
  unknown `type`, an extra key, or a broken link.

## Citegeist `type` vocabulary

`standard` · `architecture` · `status` · `issues` · `backlog` · `migration` ·
`plan` · `feat` · `brainstorm` · `ideation` · `solution` · `audit` · `checklist`.
Not centrally registered — add types freely; consumers tolerate unknowns.

## Tracking upstream (it changes "all the time")

1. The **pinned commit** above is the baseline; we conform to exactly that.
2. **Drift check** — `npm run okf:drift` (`bash tools/okf-drift-check.sh`) compares
   upstream HEAD of `okf/SPEC.md` to the pin (exit `3` = drift). On the monthly
   review (alongside the dependency audit), run it; on drift: read the diff →
   update conforming docs → re-pin (canonical `okf-adoption.md` first, then here)
   → log it. **Never auto-follow `main`.**
3. **Conformance** — `npm run okf:check` (`bash tools/okf-check.sh`) asserts every
   bundle doc has a non-empty `type` and the catalog declares `okf_version`.
4. Treat OKF as a **dependency**: re-pin deliberately, exactly like a package bump.

## Citations

1. OKF specification — https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
