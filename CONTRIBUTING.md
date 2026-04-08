# Contributing to Citegeist

Thank you for your interest in contributing! Citegeist is free and open-source, and contributions of all kinds are welcome.

## Ways to Contribute

- **Report bugs** — File an issue using the bug report template
- **Suggest features** — File an issue using the feature request template
- **Submit a pull request** — Bug fixes, documentation improvements, and new features are all welcome
- **Spread the word** — Star the repo, share it with colleagues, cite it in your papers

## Development Setup

```bash
git clone https://github.com/phdemotions/zotero-citegeist.git
cd zotero-citegeist
npm install
npm run build:dev
```

### Dev installation in Zotero

Create a proxy file in your Zotero profile's `extensions/` folder named `citegeist@opusvita.org` whose contents are the absolute path to `build/addon` in this repo.

| OS      | Profile path                                                     |
| ------- | ---------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/Zotero/Profiles/<ID>/extensions/` |
| Windows | `%APPDATA%\Zotero\Zotero\Profiles\<ID>\extensions\`              |
| Linux   | `~/.zotero/zotero/<ID>/extensions/`                              |

Restart Zotero after creating the proxy file, then re-run `npm run build:dev` whenever you change source and restart Zotero to pick up the changes.

## Developer Commands

```bash
npm test              # Run the full test suite once
npm run test:watch    # Re-run tests on file changes
npm run typecheck     # Strict TypeScript check (no emit)
npm run lint          # ESLint check
npm run lint:fix      # Auto-fix lint errors
npm run format        # Prettier write
npm run format:check  # Prettier check (no write)
npm run build         # Production build → build/*.xpi
npm run build:dev     # Dev build (no minification)
```

### Before submitting a PR

Please run these locally before pushing:

```bash
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build
```

If a test fails, look for unhandled promise rejections and missing mock setup — see the existing files in `test/` for examples.

## Pull Request Guidelines

1. Fork the repo and create your branch from `main`
2. Keep PRs focused — one feature or fix per PR
3. Add tests when you add or change logic (target: meaningful coverage, not a percentage)
4. Update `CHANGELOG.md` under the **Unreleased** section
5. Describe what your PR does and why, and link any related issues
6. Fill out the PR template checklist

## Reporting Bugs

Use the **Bug report** issue template. At minimum we need:

- Citegeist version (Tools → Add-ons → Citegeist)
- Zotero version (Help → About Zotero)
- Operating system
- Minimal steps to reproduce
- Expected vs. actual behavior
- Debug output from **Help → Debug Output Logging** for the relevant session (lines prefixed with `[Citegeist]`)

## Code Style

- TypeScript with strict mode enabled
- Prettier for formatting, ESLint for correctness — run both before pushing
- Prefer pure functions and small modules
- Keep user-facing strings consistent with existing copy; err toward plain language
- Put magic numbers in `src/constants.ts`
- Catch `unknown` and pass through `normalizeError()` / `logError()` from `src/modules/utils.ts` so logs stay useful
- Never log raw errors with `"" + e` — it destroys stack traces

## Architecture Overview

See [`DESIGN.md`](DESIGN.md) for the design rationale and trade-offs. Key modules:

- `src/modules/openalex.ts` — OpenAlex client with polite-pool rate limiting and retry
- `src/modules/cache.ts` — Read/write Citegeist fields in Zotero's Extra field
- `src/modules/citationService.ts` — Orchestrates fetch + cache
- `src/modules/citationColumn.ts` — Item-tree columns
- `src/modules/citationPane.ts` — Item-detail pane section
- `src/modules/citationNetwork/` — Citation browser dialog
- `src/constants.ts` — All tunable constants

## License

By contributing, you agree that your contributions will be licensed under the [GPL-3.0-or-later](LICENSE) license.

## Code of Conduct

All contributors are expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Support the Project

Citegeist is and always will be **completely free**. If you find it useful and want to support continued development, you can [sponsor the project on GitHub](https://github.com/sponsors/phdemotions). Contributions are appreciated but never expected.

---

Questions? Open an issue or reach out to joshgonzalesphd@gmail.com.
