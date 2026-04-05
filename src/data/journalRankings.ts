/**
 * Journal ranking lookup tables.
 *
 * Keyed by ISSN-L (linking ISSN). Each entry stores which lists
 * the journal appears on and its tier where applicable.
 *
 * Sources & versions:
 *   UTD24  — UT Dallas 24 (current as of 2024)
 *   FT50   — Financial Times 50 (2024 revision)
 *   ABDC   — Australian Business Deans Council Quality List (2022)
 *   AJG    — Chartered ABS Academic Journal Guide (2021)
 *
 * NOTE: Only journals relevant to business, management, economics,
 * finance, IS, marketing, operations, and accounting are included.
 * This covers the overwhelming majority of what researchers in these
 * fields encounter. Contributions welcome for other disciplines.
 */

export interface JournalRanking {
  /** true if on the UTD 24 list */
  utd24?: true;
  /** true if on the FT 50 list */
  ft50?: true;
  /** ABDC 2022 tier: A*, A, B, or C */
  abdc?: "A*" | "A" | "B" | "C";
  /** AJG 2021 tier */
  ajg?: "4*" | "4" | "3" | "2" | "1";
}

/**
 * Lookup by ISSN-L. Zotero stores ISSN on items; OpenAlex provides issn_l.
 * We try both when matching.
 */
const RANKINGS: Record<string, JournalRanking> = {
  // ═══════════════════════════════════════════════════════════
  // MANAGEMENT & STRATEGY
  // ═══════════════════════════════════════════════════════════

  // Academy of Management Journal
  "0001-4273": { utd24: true, ft50: true, abdc: "A*", ajg: "4*" },
  // Academy of Management Review
  "0363-7425": { utd24: true, ft50: true, abdc: "A*", ajg: "4*" },
  // Administrative Science Quarterly
  "0001-8392": { ft50: true, abdc: "A*", ajg: "4*" },
  // Strategic Management Journal
  "0143-2095": { utd24: true, ft50: true, abdc: "A*", ajg: "4*" },
  // Organization Science
  "1047-7039": { utd24: true, ft50: true, abdc: "A*", ajg: "4*" },
  // Academy of Management Annals
  "1941-6520": { abdc: "A*", ajg: "4*" },
  // Academy of Management Perspectives
  "1558-9080": { abdc: "A", ajg: "3" },
  // Academy of Management Discoveries
  "2168-1007": { abdc: "A", ajg: "3" },
  // Journal of Management
  "0149-2063": { ft50: true, abdc: "A*", ajg: "4*" },
  // Journal of Management Studies
  "0022-2380": { ft50: true, abdc: "A*", ajg: "4" },
  // Organization Studies
  "0170-8406": { abdc: "A*", ajg: "4" },
  // Strategic Entrepreneurship Journal
  "1932-4391": { abdc: "A", ajg: "4" },
  // British Journal of Management
  "1045-3172": { abdc: "A", ajg: "4" },
  // Long Range Planning
  "0024-6301": { abdc: "A", ajg: "3" },
  // Strategic Organization
  "1476-1270": { abdc: "A", ajg: "3" },
  // Journal of Management Inquiry
  "1056-4926": { abdc: "A", ajg: "3" },
  // Management Science
  "0025-1909": { utd24: true, ft50: true, abdc: "A*", ajg: "4*" },
  // California Management Review
  "0008-1256": { abdc: "A", ajg: "3" },
  // MIT Sloan Management Review
  "1532-9194": { abdc: "A", ajg: "3" },

  // ═══════════════════════════════════════════════════════════
  // FINANCE
  // ═══════════════════════════════════════════════════════════

  // Journal of Finance
  "0022-1082": { utd24: true, ft50: true, abdc: "A*", ajg: "4*" },
  // Journal of Financial Economics
  "0304-405X": { utd24: true, ft50: true, abdc: "A*", ajg: "4*" },
  // Review of Financial Studies
  "0893-9454": { utd24: true, ft50: true, abdc: "A*", ajg: "4*" },
  // Journal of Financial and Quantitative Analysis
  "0022-1090": { abdc: "A*", ajg: "4" },
  // Review of Finance
  "1572-3097": { ft50: true, abdc: "A*", ajg: "4" },
  // Journal of Money, Credit and Banking
  "0022-2879": { abdc: "A*", ajg: "3" },
  // Journal of Financial Intermediation
  "1042-9573": { abdc: "A*", ajg: "3" },
  // Journal of Corporate Finance
  "0929-1199": { abdc: "A", ajg: "3" },
  // Journal of Banking and Finance
  "0378-4266": { abdc: "A*", ajg: "3" },
  // Financial Management
  "0046-3892": { abdc: "A", ajg: "3" },
  // Journal of Financial Markets
  "1386-4181": { abdc: "A", ajg: "3" },
  // Journal of Empirical Finance
  "0927-5398": { abdc: "A", ajg: "3" },
  // Financial Analysts Journal
  "0015-198X": { abdc: "A", ajg: "3" },
  // Journal of Portfolio Management
  "0095-4918": { abdc: "A", ajg: "3" },
  // Journal of Financial Research
  "0270-2592": { abdc: "A", ajg: "3" },

  // ═══════════════════════════════════════════════════════════
  // ACCOUNTING
  // ═══════════════════════════════════════════════════════════

  // The Accounting Review
  "0001-4826": { utd24: true, ft50: true, abdc: "A*", ajg: "4*" },
  // Journal of Accounting and Economics
  "0165-4101": { utd24: true, ft50: true, abdc: "A*", ajg: "4*" },
  // Journal of Accounting Research
  "0021-8456": { utd24: true, ft50: true, abdc: "A*", ajg: "4*" },
  // Review of Accounting Studies
  "1380-6653": { abdc: "A*", ajg: "4" },
  // Contemporary Accounting Research
  "0823-9150": { ft50: true, abdc: "A*", ajg: "4" },
  // Accounting, Organizations and Society
  "0361-3682": { ft50: true, abdc: "A*", ajg: "4" },
  // Auditing: A Journal of Practice & Theory
  "0278-0380": { abdc: "A*", ajg: "3" },
  // Journal of the American Taxation Association
  "0198-9073": { abdc: "A", ajg: "3" },
  // European Accounting Review
  "0963-8180": { abdc: "A*", ajg: "3" },
  // Accounting Horizons
  "0888-7993": { abdc: "A", ajg: "3" },
  // Behavioral Research in Accounting
  "1050-4753": { abdc: "A", ajg: "2" },
  // Management Accounting Research
  "1044-5005": { abdc: "A", ajg: "3" },
  // Journal of Accounting and Public Policy
  "0278-4254": { abdc: "A", ajg: "3" },
  // Abacus
  "0001-3072": { abdc: "A*", ajg: "3" },

  // ═══════════════════════════════════════════════════════════
  // MARKETING
  // ═══════════════════════════════════════════════════════════

  // Journal of Marketing
  "0022-2429": { utd24: true, ft50: true, abdc: "A*", ajg: "4*" },
  // Journal of Marketing Research
  "0022-2437": { utd24: true, ft50: true, abdc: "A*", ajg: "4*" },
  // Journal of Consumer Research
  "0093-5301": { utd24: true, ft50: true, abdc: "A*", ajg: "4*" },
  // Marketing Science
  "0732-2399": { utd24: true, ft50: true, abdc: "A*", ajg: "4*" },
  // Journal of the Academy of Marketing Science
  "0092-0703": { ft50: true, abdc: "A*", ajg: "4" },
  // Journal of Consumer Psychology
  "1057-7408": { ft50: true, abdc: "A*", ajg: "4" },
  // Journal of Retailing
  "0022-4359": { abdc: "A*", ajg: "4" },
  // International Journal of Research in Marketing
  "0167-8116": { abdc: "A*", ajg: "4" },
  // Journal of Service Research
  "1094-6705": { abdc: "A*", ajg: "4" },
  // Marketing Letters
  "0923-0645": { abdc: "A", ajg: "3" },
  // Journal of Advertising
  "0091-3367": { abdc: "A*", ajg: "3" },
  // Journal of Interactive Marketing
  "1094-9968": { abdc: "A", ajg: "3" },
  // Journal of Public Policy & Marketing
  "0743-9156": { abdc: "A", ajg: "3" },
  // European Journal of Marketing
  "0309-0566": { abdc: "A", ajg: "3" },
  // Industrial Marketing Management
  "0019-8501": { abdc: "A", ajg: "3" },
  // Journal of Business Research
  "0148-2963": { abdc: "A", ajg: "3" },
  // Journal of Advertising Research
  "0021-8499": { abdc: "A", ajg: "3" },
  // Psychology & Marketing
  "0742-6046": { abdc: "A", ajg: "3" },
  // Quantitative Marketing and Economics
  "1570-7156": { abdc: "A*", ajg: "4" },
  // Journal of Marketing Management
  "0267-257X": { abdc: "A", ajg: "2" },
  // Journal of Consumer Behaviour
  "1472-0817": { abdc: "A", ajg: "2" },
  // Journal of Consumer Affairs
  "0022-0078": { abdc: "A", ajg: "2" },

  // ═══════════════════════════════════════════════════════════
  // OPERATIONS / SUPPLY CHAIN / DECISION SCIENCES
  // ═══════════════════════════════════════════════════════════

  // Journal of Operations Management
  "0272-6963": { utd24: true, ft50: true, abdc: "A*", ajg: "4*" },
  // Operations Research
  "0030-364X": { utd24: true, ft50: true, abdc: "A*", ajg: "4*" },
  // Manufacturing & Service Operations Management
  "1523-4614": { utd24: true, ft50: true, abdc: "A*", ajg: "4*" },
  // Production and Operations Management
  "1059-1478": { utd24: true, ft50: true, abdc: "A*", ajg: "4" },
  // Decision Sciences
  "0011-7315": { utd24: true, abdc: "A*", ajg: "3" },
  // Journal of Supply Chain Management
  "1523-2409": { abdc: "A*", ajg: "4" },
  // International Journal of Operations & Production Management
  "0144-3577": { abdc: "A*", ajg: "4" },
  // Journal of Scheduling
  "1094-6136": { abdc: "A", ajg: "2" },
  // International Journal of Production Economics
  "0925-5273": { abdc: "A", ajg: "3" },
  // International Journal of Production Research
  "0020-7543": { abdc: "A", ajg: "3" },
  // European Journal of Operational Research
  "0377-2217": { abdc: "A*", ajg: "4" },
  // Omega
  "0305-0483": { abdc: "A", ajg: "3" },
  // Transportation Research Part B
  "0191-2615": { abdc: "A*", ajg: "4" },
  // Transportation Research Part E
  "1366-5545": { abdc: "A", ajg: "3" },
  // Transportation Science
  "0041-1655": { abdc: "A*", ajg: "4" },
  // Naval Research Logistics
  "0894-069X": { abdc: "A", ajg: "3" },
  // Annals of Operations Research
  "0254-5330": { abdc: "A", ajg: "3" },

  // ═══════════════════════════════════════════════════════════
  // INFORMATION SYSTEMS / TECHNOLOGY
  // ═══════════════════════════════════════════════════════════

  // MIS Quarterly
  "0276-7783": { utd24: true, ft50: true, abdc: "A*", ajg: "4*" },
  // Information Systems Research
  "1047-7047": { utd24: true, ft50: true, abdc: "A*", ajg: "4*" },
  // Journal of MIS (Journal of Management Information Systems)
  "0742-1222": { abdc: "A*", ajg: "4" },
  // Journal of the AIS (JAIS)
  "1536-9323": { abdc: "A*", ajg: "4" },
  // Information Systems Journal
  "1350-1917": { abdc: "A*", ajg: "4" },
  // European Journal of Information Systems
  "0960-085X": { abdc: "A*", ajg: "4" },
  // Journal of Strategic Information Systems
  "0963-8687": { abdc: "A*", ajg: "4" },
  // Journal of Information Technology
  "0268-3962": { abdc: "A*", ajg: "4" },
  // Decision Support Systems
  "0167-9236": { abdc: "A", ajg: "3" },
  // Information & Management
  "0378-7206": { abdc: "A*", ajg: "3" },
  // International Journal of Electronic Commerce
  "1086-4415": { abdc: "A", ajg: "3" },
  // Internet Research
  "1066-2243": { abdc: "A", ajg: "3" },
  // Information & Organization
  "1471-7727": { abdc: "A", ajg: "3" },
  // IT & People
  "0959-3845": { abdc: "A", ajg: "2" },

  // ═══════════════════════════════════════════════════════════
  // ECONOMICS
  // ═══════════════════════════════════════════════════════════

  // American Economic Review
  "0002-8282": { ft50: true, abdc: "A*", ajg: "4*" },
  // Econometrica
  "0012-9682": { ft50: true, abdc: "A*", ajg: "4*" },
  // Quarterly Journal of Economics
  "0033-5533": { ft50: true, abdc: "A*", ajg: "4*" },
  // Journal of Political Economy
  "0022-3808": { ft50: true, abdc: "A*", ajg: "4*" },
  // Review of Economic Studies
  "0034-6527": { ft50: true, abdc: "A*", ajg: "4*" },
  // Journal of Economic Theory
  "0022-0531": { abdc: "A*", ajg: "4" },
  // Review of Economics and Statistics
  "0034-6535": { abdc: "A*", ajg: "4" },
  // Journal of Econometrics
  "0304-4076": { abdc: "A*", ajg: "4" },
  // Economic Journal
  "0013-0133": { abdc: "A*", ajg: "4" },
  // Journal of Monetary Economics
  "0304-3932": { abdc: "A*", ajg: "4" },
  // Journal of International Economics
  "0022-1996": { abdc: "A*", ajg: "4" },
  // Journal of Labor Economics
  "0734-306X": { abdc: "A*", ajg: "4" },
  // Journal of Public Economics
  "0047-2727": { abdc: "A*", ajg: "4" },
  // Journal of Economic Literature
  "0022-0515": { abdc: "A*", ajg: "4*" },
  // Journal of Economic Perspectives
  "0895-3309": { abdc: "A*", ajg: "4" },
  // American Economic Journal: Applied Economics
  "1945-7782": { abdc: "A*", ajg: "4" },
  // American Economic Journal: Macroeconomics
  "1945-7707": { abdc: "A*", ajg: "4" },
  // American Economic Journal: Microeconomics
  "1945-7669": { abdc: "A*", ajg: "4" },
  // American Economic Journal: Economic Policy
  "1945-7731": { abdc: "A*", ajg: "4" },
  // International Economic Review
  "0020-6598": { abdc: "A*", ajg: "4" },
  // Journal of the European Economic Association
  "1542-4766": { abdc: "A*", ajg: "4" },
  // RAND Journal of Economics
  "0741-6261": { abdc: "A*", ajg: "4" },
  // Journal of Development Economics
  "0304-3878": { abdc: "A*", ajg: "3" },
  // Journal of Health Economics
  "0167-6296": { abdc: "A*", ajg: "4" },
  // Journal of Urban Economics
  "0094-1190": { abdc: "A*", ajg: "3" },
  // Journal of Environmental Economics and Management
  "0095-0696": { abdc: "A*", ajg: "4" },
  // World Development
  "0305-750X": { abdc: "A*", ajg: "3" },

  // ═══════════════════════════════════════════════════════════
  // ENTREPRENEURSHIP & INNOVATION
  // ═══════════════════════════════════════════════════════════

  // Entrepreneurship Theory and Practice
  "1042-2587": { ft50: true, abdc: "A*", ajg: "4" },
  // Journal of Business Venturing
  "0883-9026": { ft50: true, abdc: "A*", ajg: "4" },
  // Research Policy
  "0048-7333": { abdc: "A*", ajg: "4" },
  // Small Business Economics
  "0921-898X": { abdc: "A", ajg: "3" },
  // Journal of Product Innovation Management
  "0737-6782": { abdc: "A*", ajg: "4" },
  // Technovation
  "0166-4972": { abdc: "A", ajg: "3" },
  // R&D Management
  "0033-6807": { abdc: "A", ajg: "3" },
  // Technological Forecasting and Social Change
  "0040-1625": { abdc: "A", ajg: "3" },

  // ═══════════════════════════════════════════════════════════
  // ORGANIZATIONAL BEHAVIOR / HUMAN RESOURCES
  // ═══════════════════════════════════════════════════════════

  // Organizational Behavior and Human Decision Processes
  "0749-5978": { ft50: true, abdc: "A*", ajg: "4" },
  // Journal of Applied Psychology
  "0021-9010": { ft50: true, abdc: "A*", ajg: "4*" },
  // Personnel Psychology
  "0031-5826": { abdc: "A*", ajg: "4" },
  // Human Resource Management
  "0090-4848": { abdc: "A*", ajg: "4" },
  // Journal of Organizational Behavior
  "0894-3796": { abdc: "A*", ajg: "4" },
  // Human Relations
  "0018-7267": { ft50: true, abdc: "A*", ajg: "4" },
  // Leadership Quarterly
  "1048-9843": { abdc: "A*", ajg: "4" },
  // Organizational Research Methods
  "1094-4281": { abdc: "A*", ajg: "4" },
  // Journal of Vocational Behavior
  "0001-8791": { abdc: "A*", ajg: "4" },
  // Journal of Occupational and Organizational Psychology
  "0963-1798": { abdc: "A", ajg: "4" },
  // Human Resource Management Journal
  "0954-5395": { abdc: "A", ajg: "4" },
  // International Journal of Human Resource Management
  "0958-5192": { abdc: "A", ajg: "3" },
  // Journal of Business Ethics
  "0167-4544": { ft50: true, abdc: "A", ajg: "3" },

  // ═══════════════════════════════════════════════════════════
  // INTERNATIONAL BUSINESS
  // ═══════════════════════════════════════════════════════════

  // Journal of International Business Studies
  "0047-2506": { utd24: true, ft50: true, abdc: "A*", ajg: "4*" },
  // Journal of World Business
  "1090-9516": { abdc: "A*", ajg: "4" },
  // Global Strategy Journal
  "2042-5791": { abdc: "A", ajg: "4" },
  // Journal of International Management
  "1075-4253": { abdc: "A", ajg: "3" },
  // International Business Review
  "0969-5931": { abdc: "A", ajg: "3" },
  // Management International Review
  "0938-8249": { abdc: "A", ajg: "3" },

  // ═══════════════════════════════════════════════════════════
  // PSYCHOLOGY (APPLIED / SOCIAL — common in business research)
  // ═══════════════════════════════════════════════════════════

  // Psychological Science
  "0956-7976": { abdc: "A*", ajg: "4*" },
  // Journal of Personality and Social Psychology
  "0022-3514": { abdc: "A*", ajg: "4*" },
  // Journal of Experimental Psychology: General
  "0096-3445": { abdc: "A*", ajg: "4*" },
  // Psychological Bulletin
  "0033-2909": { abdc: "A*", ajg: "4*" },
  // Annual Review of Psychology
  "0066-4308": { abdc: "A*", ajg: "4*" },
  // Psychological Review
  "0033-295X": { abdc: "A*", ajg: "4*" },
  // Organizational Psychology Review
  "2041-3866": { abdc: "A", ajg: "3" },
  // Journal of Experimental Social Psychology
  "0022-1031": { abdc: "A*", ajg: "4" },

  // ═══════════════════════════════════════════════════════════
  // GENERAL / MULTIDISCIPLINARY
  // ═══════════════════════════════════════════════════════════

  // Nature
  "0028-0836": { abdc: "A*" },
  // Science
  "0036-8075": { abdc: "A*" },
  // Proceedings of the National Academy of Sciences
  "0027-8424": { abdc: "A*" },
  // Nature Human Behaviour
  "2397-3374": { abdc: "A*" },
  // Harvard Business Review
  "0017-8012": { ft50: true, abdc: "A", ajg: "3" },

  // ═══════════════════════════════════════════════════════════
  // ADDITIONAL FT50 JOURNALS (not yet listed above)
  // ═══════════════════════════════════════════════════════════

  // Journal of Consumer Psychology (already above as 1057-7408)
  // Sloan Management Review (already above as 1532-9194)

  // ═══════════════════════════════════════════════════════════
  // CONSUMER BEHAVIOR / PSYCHOLOGY (Josh's field)
  // ═══════════════════════════════════════════════════════════

  // Journal of Consumer Culture
  "1469-5405": { abdc: "B", ajg: "2" },
  // Consumption Markets & Culture
  "1025-3866": { abdc: "A", ajg: "2" },
  // Journal of Marketing Theory and Practice
  "1069-6679": { abdc: "B", ajg: "2" },
  // Journal of Macromarketing
  "0276-1467": { abdc: "A", ajg: "2" },
  // Journal of Consumer Marketing
  "0736-3761": { abdc: "A", ajg: "1" },
  // Journal of Research in Interactive Marketing
  "2040-7122": { abdc: "A", ajg: "2" },
  // International Journal of Consumer Studies
  "1470-6423": { abdc: "A", ajg: "2" },
  // Journal of Services Marketing
  "0887-6045": { abdc: "A", ajg: "2" },
  // European Journal of Marketing
  // (already above as 0309-0566)
  // Journal of Brand Management
  "1350-231X": { abdc: "A", ajg: "2" },
  // Marketing Theory
  "1470-5931": { abdc: "A", ajg: "2" },
};

export const RANKING_VERSIONS = {
  utd24: "2024",
  ft50: "2024",
  abdc: "2022",
  ajg: "2021",
} as const;

const issnMap = new Map<string, JournalRanking>();
for (const [issn, ranking] of Object.entries(RANKINGS)) {
  issnMap.set(issn.toUpperCase(), ranking);
}

/**
 * Look up journal rankings by ISSN. Tries all provided ISSNs.
 */
export function lookupRanking(issns: string[]): JournalRanking | null {
  for (const issn of issns) {
    const r = issnMap.get(issn.toUpperCase().trim());
    if (r) return r;
  }
  return null;
}
