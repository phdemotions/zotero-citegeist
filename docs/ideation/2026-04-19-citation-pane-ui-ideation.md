---
type: ideation
title: "Citation-pane UI — ideation"
description: Repo-grounded ideation toward an award-winning analytics-dashboard citation pane.
timestamp: 2026-04-19
tags: [citegeist, ideation, citation-pane, ui]
date: 2026-04-19
topic: citation-pane-ui
focus: redesign citation pane to award-winning analytics dashboard quality
mode: repo-grounded
---

# Ideation: Citation Pane UI Redesign

## Grounding Context

**Project:** Citegeist — Zotero 7-9 TypeScript plugin. Citation pane renders in a ~280px-wide Zotero sidebar section. CSS-in-JS inline in a JS template string; all colors hardcoded (no CSS var() — Zotero overrides them). Buttons must be real DOM elements. Available data: `citedByCount`, `fwci`, `percentile`, `isTop1Percent`, `isTop10Percent`, `isRetracted`, `counts_by_year`.

**Problem:** The current pane renders citation count at 24px font-weight 800 while FWCI and percentile are small inline subordinate text. Incoherent visual hierarchy. Doesn't read as an analytics dashboard.

**Constraint:** Hardcode all colors; use `#citegeist-pane-root` specificity prefix for hover states. No SVG charting libraries — inline SVG only.

## Ranked Ideas

### 1. Equal-Weight Metric Grid
**Description:** Replace the 24px hero citation count + subordinate inline FWCI/percentile with a 3-tile equal-weight grid. All three stats (Citations, FWCI, Percentile) rendered at identical visual weight: label on top (10px uppercase muted), value below (18-20px semibold tabular-nums). Badge appears under the percentile tile. The grid creates hierarchy through grouping, not type-size differential.
**Rationale:** Directly fixes the stated problem with one CSS + render change. Web research confirmed this pattern (uniform tile grid) is the standard for polished analytics sidebars (Linear, Raycast, GitHub). Low complexity, immediately implementable.
**Downsides:** Doesn't add new information or reframe what the pane is for. Least conceptually bold of the survivors.
**Confidence:** 90%
**Complexity:** Low
**Status:** Explored — being brainstormed

### 2. Retraction as Pane State
**Description:** When `isRetracted` is true, the entire pane background shifts to dark amber (#3D2E0A). Retraction notice fills top third with full visual weight. Metrics de-emphasized below with reduced opacity.
**Rationale:** Retraction is a stop-everything signal. A banner alongside normal metrics treats it as just another data point. Pane state change makes it unmissable.
**Downsides:** Rare case. Small impact surface.
**Confidence:** 85%
**Complexity:** Low
**Status:** Unexplored

### 3. Two-Zone Pane (Glance / Investigate)
**Description:** Top ~80px: single most important signal (priority: retraction → Top 1% → FWCI tier). Below: full metrics, buttons, trend. Makes cursory scan free without sacrificing the deep-read path.
**Rationale:** Most pane interactions are cursory. Zone 1 answers "is this paper notable?" without reading Zone 2.
**Downsides:** Priority rule design needed. What is Zone 1 for an average unremarkable paper?
**Confidence:** 80%
**Complexity:** Low
**Status:** Unexplored

### 4. Contextual Benchmarking
**Description:** "Top 8% of papers from 2019" as primary headline. Raw citation count demotes to parenthetical. No new API calls — percentile already computed.
**Rationale:** Answers the researcher's actual question ("is this influential relative to peers?") instead of showing an absolute count that requires field-specific calibration.
**Downsides:** Some researchers need headline raw count for tenure/grant docs. Soften by keeping count readable but smaller.
**Confidence:** 75%
**Complexity:** Low
**Status:** Unexplored

### 5. Verdict Card + Benchmark Row
**Description:** Auto-synthesized tier label ("Highly Cited", "Foundational Work", "Emerging Impact") from FWCI + percentile. Below: micro field-comparison bars per metric.
**Rationale:** Removes interpretive burden for non-bibliometricians (majority of Zotero users).
**Downsides:** Hides raw numbers. Tier labels need careful writing — academics are skeptical of tool-generated summary judgments.
**Confidence:** 70%
**Complexity:** Medium
**Status:** Unexplored

### 6. Citation Horizon (Micro Sparkline)
**Description:** 280px × 36px SVG area chart of citations-per-year (last 5-7 years). No axes. Peak year marked with a dot. Signal line below (Citations · FWCI · Percentile) + action buttons.
**Rationale:** Makes temporal trajectory primary. Uses data already in memory (`counts_by_year`). Turns the pane into a genuine mini-dashboard.
**Downsides:** Requires inline SVG. Needs graceful fallback for papers with <2 years of data.
**Confidence:** 70%
**Complexity:** Medium
**Status:** Unexplored

### 7. Briefing Card
**Description:** Single synthesized sentence: "Cited 342 times, performing 2.1× above similar work — top 8% of its cohort. Citations accelerating YoY." Two action buttons below. 3-branch conditional logic, no NLP.
**Rationale:** How a knowledgeable colleague would brief you. No interpretive burden for non-bibliometricians.
**Downsides:** Power users want raw numbers, not black-box summaries.
**Confidence:** 65%
**Complexity:** Low
**Status:** Unexplored

## Rejection Summary

| Idea | Reason Rejected |
|------|-----------------|
| Context Strip ("cited by 3 papers you have") | Requires new cross-library API surface — out of scope for UI redesign |
| Quiet Mode (suppress citation count) | Raw count needed by academics for tenure/grants |
| Threshold Suppression | Inconsistent UX, fragile for new papers |
| Action-Anchored Layout | Minor reorder, speculative research claim |
| Inline Semantic Labels | Copy principle, not a layout direction |
| Single-Action Pane | Removes active feature, too opinionated |
| Pane Lives in Column | Architectural change, not pane redesign |
| Impact Spine | Unclear visual grammar, too spatially complex at 280px |
| Citation Clock | High SVG cost, radial format unusual in sidebar tools |
| Momentum Score | Invents proprietary metric, academic trust risk |
| Flight Instrument Stack | High engineering cost, marginal analytical gain |
| Stellar Magnitude Arc | SVG complexity, not clearly better than simpler forms |
| Tide Table | Metaphor too niche, almanac aesthetic unfamiliar |
| Spectrophotometer | Chemistry domain, too obscure for general researcher base |
| The Vault | Adds friction to ambient data — defeats sidebar purpose |
| Full Canvas | Breaks other Zotero pane sections, invasive |
| Annotation Layer | Outside registerSection API surface, Zotero UI surgery |
| Dead-Silence State | State management tweak, not a design direction |
| Glance Shell + Seismograph combo | Components don't compound |
| Trend-First Layout | Fragile for new papers, duplicate of Citation Horizon |
| Horizon Bar | Too minimal, loses metric precision |
| Research Nudge (rotating insight) | Rotating content creates inconsistency and distrust |
| Progressive Disclosure Tiers | Nested interaction inside Zotero's own accordion = friction |
| Seismograph Reading | Duplicate of Citation Horizon |
| Marathon Split Card | Pace calibration harder to read than raw FWCI |
| Pure Ratio (FWCI only) | Too extreme — raw count still matters |
| Observatory (monochrome) | Style choice, not a layout direction |
| Briefing + Progressive Disclosure combo | Parts don't compound |
