# Citegeist badge data (machine-generated — do not edit)

This branch hosts the JSON consumed by the README's shields.io **endpoint** badges
(release version + downloads). It is regenerated and force-pushed by the
`Build & Release` workflow on every `v*` tag. shields fetches these files over
`raw.githubusercontent.com` (no GitHub API auth), so the shared-token-pool rate
limit that used to freeze the `github/*` badges cannot affect them.

- `badge-release.json` — latest release version
- `badge-downloads.json` — total `.xpi` downloads (real installs; excludes update.json polling)

Source of truth: `.github/workflows/release.yml` on `main`.
