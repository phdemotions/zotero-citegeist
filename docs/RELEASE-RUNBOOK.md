---
type: runbook
title: Citegeist — release runbook
description: How a release runs, what each refusal means and how to recover, one-time repository setup, the review loop, the fork proofs, provenance checks, the break-glass release and the one-off v2.0.6.
timestamp: 2026-09-28
tags: [citegeist, release, runbook, ci, recovery, provenance]
---

# Citegeist — Release Runbook

The steps of a release are in [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md). This
file holds the rest: what the release workflow does, what each refusal means
and how to recover from it, the repository settings the workflow depends on,
the review loop, the proofs to run on a fork, and the procedures for when
Actions is down or a 2.x fix has to ship.

---

## How a release runs

A release starts from **Actions → Publish release → Run workflow** on `main`,
with the version and, optionally, the commit
([`.github/workflows/publish-release.yml`](../.github/workflows/publish-release.yml)).
Nothing runs on a tag push. GitHub runs "the version of the workflow that is
present in the associated commit SHA or Git ref of the event"
([Workflows, "Workflow triggers"](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflows#workflow-triggers)),
so a tag pushed on an old commit would run that commit's old workflow, and 23
commits in the history carry the unguarded `release.yml` with version 3.0.0. A
dispatch from `main` always runs `main`'s copy, and Publish creates the tag.

| Job | Holds | Runs | Tested by |
|---|---|---|---|
| `Build` | `contents: read`, `pull-requests: read` | the dispatch-ref check, `scripts/release-guard-cli.mjs` from `main`'s copy, then `node scripts/build.mjs` on the release commit; records the SHA-256 of the XPI and `update.json` | `test/release-guard.test.ts`, `test/workflow-invariants.test.ts` |
| `Verify` | `contents: read` | the gates `npm run verify` runs before its build, on the release commit | `test/workflow-invariants.test.ts` |
| `Real Zotero` | `contents: read` | `real-zotero.yml` on Build's XPI, after checking its SHA-256, with the release commit's specs | `test/workflow-invariants.test.ts` |
| `Publish` | `contents: write`, `id-token: write`, `attestations: write` | `scripts/verify-release-assets.sh`, the tag check, `scripts/check-channel-version-cli.mjs`, `actions/attest`, the tag push, `scripts/publish-versioned-release.sh`, the channel move and `scripts/publish-update-channel.sh` | `test/release-scripts.test.ts`, `test/workflow-invariants.test.ts` |
| `README badges` | `contents: write` | `scripts/readme-badges-cli.mjs` and a push of the `badges` branch | `test/release-scripts.test.ts`, `test/workflow-invariants.test.ts` |

The permissions each job holds are exactly the `PERMISSIONS` table in
`test/workflow-invariants.test.ts`; every job with a write scope there may run
only the commands that file allowlists. Publish runs one at a time across every
run (the `release-channel` concurrency group, `queue: max`), so a second
dispatch waits its turn instead of being cancelled
([Control the concurrency of workflows and jobs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency),
"Example: Queueing multiple pending runs").

The tag Publish pushes, and the `release` tag it moves, are pushed with the
job's `GITHUB_TOKEN`. "Events triggered by the `GITHUB_TOKEN` will not create a
new workflow run", `workflow_dispatch` and `repository_dispatch` aside
([Triggering a workflow](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow#triggering-a-workflow-from-a-workflow)),
so those pushes start nothing.

---

## Guard refusals

Build refuses before installing anything, so a refusal has written nothing.
Fix the cause and start a new run, unless the entry says to re-run.

- **"Publish release runs only from main".** The run was started on another
  branch, whose copy of the workflow and its checks may differ. Start it again
  on `main`.
- **"is not MAJOR.MINOR.PATCH".** Type the version as `3.0.0`: no `v`, no
  prerelease suffix, each part at most nine digits.
- **"must be a full 40-character SHA" / "is not a commit".** Leave the commit
  empty, or paste the release pull request's merge commit in full.
- **"package.json at … has version …, not …".** The version or the commit is
  wrong: release the version the release pull request set, from its merge
  commit.
- **"is not on main" / "a merge commit brought it in".** That is the release
  branch's own commit. Release the merge commit the pull request put on `main`.
- **"GitHub lists no pull request for … yet".** GitHub links a merge commit to
  its pull request shortly after the merge. Wait a minute, then **Re-run failed
  jobs**. If it still lists none, the commit reached `main` without a pull
  request and cannot be released.
- **"came to main in pull request #N, whose merge commit is …".** A rebase merge
  of several commits: release the last one, which the message names.
- **"is the merge commit of pull request #N into …, not into main"** or **"no
  merged pull request into main has it as its merge commit".** Release only
  through a pull request into `main`.
- **"is the merge commit of more than one pull request".** GitHub's records are
  ambiguous; look at both pull requests before doing anything else.
- **"has no merge_commit_sha".** GitHub stopped serving REST API version
  2022-11-28; see [Upkeep](#upkeep).
- **"package.json on main had X just before pull request #N, but releasing V
  requires V-alpha.0 there".** The release pull request did not start from the
  version's development version. If `main` already carried `V`, that version has
  been set before and has most likely shipped: release the next one. If `main`
  was developing another version, `V` is probably a typo. If `main` skipped its
  `-alpha.0`, merge a pull request that sets `V-alpha.0`, then a new release
  pull request, and release that.

## Publish refusals

- **"… already exists on another commit".** The version's tag is taken, and
  tags are never moved. Release the next patch version.
- **Confirm the assets are the bytes build made** fails. The artifact is not the
  one Build hashed. Choose **Re-run all jobs**, which builds and hashes again.
- **"Release … is published with assets other than the ones this run
  verified".** A published release is never changed, because installed copies
  may have taken it. If the channel serves that release, it is complete; if not,
  see [The channel's update.json is missing](#the-channels-updatejson-is-missing).
- **"GitHub lists N releases for …".** Several drafts share the tag. Delete the
  ones that should not publish, then **Re-run failed jobs**.
- **"Could not download published release …'s assets".** GitHub did not serve
  them; **Re-run failed jobs** later.

## Channel refusals

- **"… is older than …, which the live update channel already serves".**
  Publishing it would move installed copies backwards. Release a newer version.
- **"Release vX.Y.Z is already complete".** The channel serves that version's
  published `update.json`, and this attempt rebuilt other bytes. Nothing is left
  to do and no version is spent. See the residual under
  [Re-run recovery](#re-run-recovery).
- **"… neither the one this run verified nor …".** See
  [The channel serves other bytes](#the-channel-serves-other-bytes).
- **"The channel Release has no update.json … may not restore it".** See
  [The channel's update.json is missing](#the-channels-updatejson-is-missing).
- **"No channel Release exists, but other releases have been published".** See
  [The channel Release is gone](#the-channel-release-is-gone).

---

## Re-run recovery

A re-run uses "the same `GITHUB_SHA` (commit SHA) and `GITHUB_REF` (git ref) of
the original event", so it runs the same workflow file, for up to 30 days after
the run started
([Re-running workflows and jobs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)).
**Re-run failed jobs** comes first. Once Build has passed, it keeps Build's
outputs, and every job it re-runs downloads the artifact Build uploaded on the
attempt it passed (`release-assets-1` when that was the first) and checks it
against Build's digest, so the bytes cannot change.

| What failed | What to do | Why it is safe |
|---|---|---|
| Build: "no pull request yet" | Wait a minute, **Re-run failed jobs** | Nothing was built or written |
| Build: any other refusal | Fix the cause ([Guard refusals](#guard-refusals)), start a new run | Nothing was built or written |
| Build: the install or the network | **Re-run failed jobs** | Nothing was written |
| `Verify` or a real-Zotero cell, for no real reason | **Re-run failed jobs** | Build is not re-run; the cells test its first attempt's XPI |
| `Publish`, before the tag was created | **Re-run failed jobs** | At most an attestation was written, and a second one of the same bytes is harmless |
| `Publish`, after the tag was created | **Re-run failed jobs** | The tag check finds the tag on this commit and keeps it |
| `Publish`, after the release was created | **Re-run failed jobs** | The release is left as it is, since its assets are the verified ones |
| `Publish`, during the channel upload | **Re-run failed jobs** | The channel check reports `repair` and restores `update.json` |
| `Publish`, after the channel moved | **Re-run failed jobs** | The channel check reports `current`; nothing is written |
| `README badges` | Re-run that job | It only reads releases and pushes the `badges` branch |
| The run is more than 30 days old, or its artifact expired | Start a new run for the same version and commit | See the residual below |

**Re-run all jobs**, and a new run, build again. A production build takes its
build id and every file time from the commit (`scripts/build-package.mjs`), so
the same commit on the same `ubuntu-24.04` image gives the same bytes, and
every Publish step finds its work done.

**The residual.** GitHub updates the `ubuntu-24.04` image between runs. If the
image's `zip`, or the library it compresses with, changed between attempts, a
rebuild can give other bytes, and Publish refuses them. If the release was
already complete, the refusal says so and nothing needs doing. If it was half
done with the first bytes and **Re-run failed jobs** is no longer possible, the
version cannot be finished with the new bytes: restore the channel by hand if it
is missing ([below](#the-channels-updatejson-is-missing)) and release the next
patch version.

## A version that cannot ship

A gate that fails for a real reason writes nothing, because Publish creates the
tag only after every check. A version is spent once its tag exists. Until then
the same version can still ship: merge a pull request with the fix that also
sets `main` back to `X.Y.Z-alpha.0`, then a new release pull request, and
release that. Once the tag exists, fix forward: release the next patch version,
folding the unreleased `X.Y.Z` CHANGELOG entry into it.

## The channel's update.json is missing

The `release` Release exists but
`releases/download/release/update.json` returns 404, as an upload that failed
part way leaves it; every installed copy finds no update until it is back. A
re-run restores it when the newest release is this run's and is published with
the verified assets. Otherwise restore the newest published release's
`update.json` by hand:

```bash
gh release download vX.Y.Z --repo phdemotions/zotero-citegeist --pattern update.json --dir /tmp/channel-restore
gh release upload release /tmp/channel-restore/update.json --repo phdemotions/zotero-citegeist --clobber
```

## The channel Release is gone

The `release` Release was deleted after releases had shipped. Publish refuses to
start a new channel then, because it could not tell which release should head
it. Recreate it from the newest published release:

```bash
gh release download vX.Y.Z --repo phdemotions/zotero-citegeist --pattern update.json --dir /tmp/channel-restore
gh release create release /tmp/channel-restore/update.json --repo phdemotions/zotero-citegeist \
  --title "Auto-update channel" --latest=false \
  --notes "Serves update.json for Zotero's built-in auto-updater. Do not download from here manually — install Citegeist from the latest versioned release."
```

## The channel serves other bytes

The channel serves this version from an `update.json` that is neither this run's
nor the versioned release's own: a cap raise republished for the version (plan
U15), or a hand upload. Compare the two before anything else:

```bash
curl -sL https://github.com/phdemotions/zotero-citegeist/releases/download/release/update.json
gh release download vX.Y.Z --repo phdemotions/zotero-citegeist --pattern update.json --output -
```

A deliberate cap raise needs nothing from this run. Any change to what the
version ships goes out as the next patch version.

---

## Verifying a release

Publish attests the XPI and `update.json` with `actions/attest` before it
publishes anything, so every published asset has a signed SLSA build provenance
attestation. Anyone can check one:

```bash
gh attestation verify citegeist-X.Y.Z.xpi --repo phdemotions/zotero-citegeist
```

The stricter form also pins the workflow, the branch it ran from and GitHub's
own runners:

```bash
gh attestation verify citegeist-X.Y.Z.xpi --repo phdemotions/zotero-citegeist \
  --signer-workflow phdemotions/zotero-citegeist/.github/workflows/publish-release.yml \
  --source-ref refs/heads/main --deny-self-hosted-runners
```

The attestation names the commit the workflow ran from, `main` as the dispatch
found it. When the run was given a `commit`, that commit is an ancestor of the
one named. Leaving the commit empty right after the release pull request merges
makes the two the same.

---

## One-time repository setup

Josh's settings, each done once.

1. **Branch protection on `main`** (Settings → Branches, a rule or a ruleset):
   require a pull request; require status checks, with branches up to date;
   require the single check **`CI gate`**, which passes only when `test (22)`,
   the workflow audit and every real-Zotero cell succeeded, so a new cell needs
   no settings change (never require the cells one by one: a renamed cell would
   leave a required check that never reports); do not allow bypassing. GitHub
   lets a rule require a check only once it has reported in the past seven days,
   so turn this on after `CI gate` has passed on a pull request.
2. **Require review from Code Owners.** `.github/CODEOWNERS` assigns the
   workflows, scripts, build inputs and release tests to `@phdemotions`, and
   GitHub enforces it only while this is on. GitHub does not let an author
   approve their own pull request, so confirm a sole maintainer can still merge
   before turning it on.
3. **The `v*` tag ruleset, with GitHub Actions as its only bypass.** Ruleset
   24140405 refuses the creation, update and deletion of any `v*` tag, with no
   bypass. Once this change is on `main`, add the GitHub Actions app as its only
   bypass actor, so Publish can create the version's tag:
   Settings → Rules → Rulesets → "Release tags (v*) — no hand-pushed tags" →
   Bypass list → Add bypass → **GitHub Actions** → Always allow → Save. Or:

   ```bash
   gh api -X PUT repos/phdemotions/zotero-citegeist/rulesets/24140405 \
     -H "X-GitHub-Api-Version: 2022-11-28" --input - <<'JSON'
   {
     "name": "Release tags (v*) — no hand-pushed tags",
     "target": "tag",
     "enforcement": "active",
     "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
     "rules": [{ "type": "creation" }, { "type": "update" }, { "type": "deletion" }],
     "bypass_actors": [{ "actor_id": 15368, "actor_type": "Integration", "bypass_mode": "always" }]
   }
   JSON
   gh api repos/phdemotions/zotero-citegeist/rulesets/24140405 --jq .bypass_actors
   ```

   Why this is the right actor: "When you enable GitHub Actions, GitHub installs
   a GitHub App on your repository. The `GITHUB_TOKEN` secret is a GitHub App
   installation access token"
   ([GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)),
   and a ruleset's bypass list accepts GitHub Apps
   ([Creating rulesets for a repository, "Granting bypass permissions for your branch or tag ruleset"](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository#granting-bypass-permissions-for-your-branch-or-tag-ruleset)).
   That app is `github-actions`, id 15368 (`gh api /apps/github-actions --jq .id`).
   The fork proof "A dispatched release publishes" confirms it: without the
   bypass, Publish's tag push fails on the ruleset. The bypass lets any workflow
   in the repository create a `v*` tag with its token; only Publish does, the
   invariants test holds every write scope to its table, and such a push starts
   no workflow run.
4. **Disable the legacy `release.yml` workflow**, "Build & Release" (workflow id
   256332410), as soon as no 2.x release needs it
   ([The one-off v2.0.6](#the-one-off-v206)). Do it before this change merges
   when v2.0.6 is settled by then, while `release.yml` is still on `main` and
   the workflow is plainly active; otherwise right after v2.0.6. The commands
   name the workflow by its id rather than by a file on `main`:

   ```bash
   gh workflow disable 256332410 --repo phdemotions/zotero-citegeist
   gh api repos/phdemotions/zotero-citegeist/actions/workflows/256332410 --jq .state
   ```

   The second command prints `disabled_manually`. "Disabling a workflow allows
   you to stop a workflow from being triggered without having to delete the file
   from the repo"
   ([Disabling and enabling a workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)),
   and GitHub keys a workflow by its file: the REST API takes the file name in
   place of the id
   ([REST API endpoints for workflows, "Disable a workflow"](https://docs.github.com/en/rest/actions/workflows#disable-a-workflow)),
   and runs of `.github/workflows/release.yml` from every ref are listed under
   the one id. So the disabled state holds whichever commit's copy a tag would
   run, which the fork proof "A tag on an old commit starts no run" confirms.
   Before then the ruleset already stops anyone pushing a `v*` tag by hand, and
   Publish's own tag pushes start no run; disabling the workflow closes the one
   path left, a ruleset lifted by hand.

---

## Review loop

Every code change passes this before it merges. The maintainer runs it on every
pull request that changes code, and posts the
round log as a comment on the pull request. Outside contributors are not asked
to run it. It is the bar #77 cleared before merge.

**Lenses, one finder each:** correctness; adversarial (construct the input or
sequence that breaks the change); security (the API key, redaction, the update
channel, CI tokens); reliability (shutdown, timers, unawaited promises, retries,
cleanup); host compatibility (every Zotero or Firefox API the change touches,
checked against Zotero's own source, naming the file and the Zotero tag it was
read at, such as `chrome/content/zotero/xpcom/pluginAPI/menuManager.js` at
`10.0.2`); testing (missing scenarios, weak assertions, mocks hiding a host
contract); maintainability (duplication, dead code, names that hide intent).

**Each round:**

1. Every finder reviews the full diff and reports findings with a quoted line
   of evidence and a severity from P0 to P3.
2. Each finding goes to a separate verifier told to refute it. Only findings
   the verifier fails to refute count as confirmed.
3. Fix every confirmed P0, P1 and P2 finding before the next round starts.

**Exit rule:** the loop ends after **two consecutive full rounds with no
confirmed P2 or higher finding**. A confirmed P0 or P1 resets the count to zero.

**Round log** (one line per round in the pull request comment):

```text
Round 3 · 7 lenses · raised 9, confirmed 2 (P2 ×1, P3 ×1) · fixed in 1a2b3c4 · not clean
Round 4 · 7 lenses · raised 4, confirmed 0 · clean (1 of 2)
Round 5 · 7 lenses · raised 3, confirmed 1 (P3 ×1) · clean (2 of 2) · exit
```

---

## Proofs on a fork

Nothing in the release workflow has run on GitHub yet; local tests and mutation
proofs are the evidence so far. Run these on a throwaway fork with Actions
enabled, its own `main` protected as above, and the same tag ruleset with the
GitHub Actions bypass. Record each run's URL in `docs/STATUS.md`.

- [ ] **A lint error blocks a pull request.** `test (22)` and `CI gate` are red.
- [ ] **A real-Zotero failure blocks a pull request.** That cell and `CI gate`
      are red.
- [ ] **A clean pull request passes**, the workflow audit included.
- [ ] **A dispatched release publishes, end to end.** Release `X.Y.Z` by the
      checklist, section 5. Every job passes; Publish creates the `vX.Y.Z` tag on
      the release commit and the release with the XPI and `update.json`; the
      fork's `releases/download/release/update.json` lists `X.Y.Z`; the badges
      branch is pushed; `gh attestation verify` passes on the downloaded XPI.
- [ ] **Without the bypass, the tag push fails.** Remove the GitHub Actions
      bypass, dispatch the next version: Publish fails at "Create the version's
      tag" with a ruleset violation, and no release is created. Restore the
      bypass.
- [ ] **A dispatch from another branch is refused.** Run the workflow on a
      branch other than `main`: Build fails at "Started from main", and nothing
      else writes.
- [ ] **A commit that is not a release pull request's merge commit is
      refused**: the release branch's own commit, a rebase merge's earlier
      commit, a later merge commit. Build fails in the guard, naming the cause.
- [ ] **Re-run all jobs reports the release already published.** On the first
      release's run: Build uploads `release-assets-2`, the channel check
      reports `current`, the release step leaves it unchanged, and the channel
      step moves nothing.
- [ ] **Re-run failed jobs after a real-Zotero cell fails.** Dispatch the next
      version and cancel the run while the cells run; choose **Re-run failed
      jobs**. Build is not re-run, each cell downloads `release-assets-1` and
      passes its digest check, and Publish runs.
- [ ] **A partial re-run downloads attempt 1's artifact.** Cancel a run once
      Publish has started; choose **Re-run failed jobs**. Publish's download step
      names `release-assets-1` on attempt 2, its digest check passes, and it
      finishes what the first attempt left.
- [ ] **A failing spec blocks a release.** Release with one real-Zotero spec
      failing: that cell is red, Publish is skipped, and no tag or release
      exists.
- [ ] **An older version is refused.** Publish the newer of two releases, then
      dispatch the older: the channel check refuses it, and no tag is created.
- [ ] **A taken version is refused.** Dispatch a version whose tag already
      exists on another commit: the tag check refuses it.
- [ ] **A tag on an old commit starts no run.** In a fork that still has
      `release.yml` on `main`: push a tag `v0.0.1-probe-a` on v2.0.5's commit
      (`4151ef90c4ea`) and see the legacy "Build & Release" start (cancel it at
      once, long before its release step). Disable it with
      `gh workflow disable release.yml --repo <you>/<fork>`, confirm
      `gh api repos/<you>/<fork>/actions/workflows/release.yml --jq .state`
      prints `disabled_manually`, then merge this change into the fork's `main`
      so `release.yml` is gone from it, push `v0.0.2-probe-b` on the same old
      commit, and see no run start within five minutes. Delete the probe tags.
- [ ] **Build's token cannot push.** Add a temporary last step to Build that
      runs
      `git push "https://x-access-token:${{ github.token }}@github.com/${{ github.repository }}" HEAD:refs/tags/token-probe`:
      it fails with a 403, and no `token-probe` tag appears.

---

## Break-glass release

For when Actions cannot run at all (a billing lock, an outage) and users are
being harmed. **Josh approves each use**, in writing on the incident's issue.
Without Actions there is no real-Zotero run, so the checklist's host checks,
sections 1 to 3, are mandatory.

1. From an up-to-date `main`, run the guard exactly as Build does:
   `GITHUB_REPOSITORY=phdemotions/zotero-citegeist GH_TOKEN="$(gh auth token)" node scripts/release-guard-cli.mjs X.Y.Z <commit>`.
2. Build the release commit in a clean worktree, with the gates Verify runs:

   ```bash
   git worktree add --detach /tmp/cg-release <commit> && cd /tmp/cg-release
   npm install --no-audit --no-fund --ignore-scripts && git diff --exit-code package-lock.json
   npm run verify
   mkdir /tmp/cg-assets && cp build/citegeist-X.Y.Z.xpi build/update.json /tmp/cg-assets/
   cd /tmp/cg-assets && export SUMS="$(shasum -a 256 citegeist-X.Y.Z.xpi update.json)"
   ```

   Record `SUMS` on the issue.
3. Back in `main`'s checkout, run the checks Publish runs, against those files:

   ```bash
   bash scripts/verify-release-assets.sh /tmp/cg-assets
   GH_REPO=phdemotions/zotero-citegeist GH_TOKEN="$(gh auth token)" \
     node scripts/check-channel-version-cli.mjs X.Y.Z https://github.com/phdemotions/zotero-citegeist/releases/download/release/update.json
   ```

4. Josh sets ruleset 24140405's enforcement to **Disabled**, pushes the tag, and
   sets it back to **Active** at once:
   `git tag vX.Y.Z <commit> && git push origin refs/tags/vX.Y.Z`.
5. Publish, with the scripts Publish runs:

   ```bash
   GH_REPO=phdemotions/zotero-citegeist GH_TOKEN="$(gh auth token)" \
     bash scripts/publish-versioned-release.sh vX.Y.Z /tmp/cg-assets
   git tag -f release <commit> && git push --force origin refs/tags/release:refs/tags/release
   GH_REPO=phdemotions/zotero-citegeist GH_TOKEN="$(gh auth token)" \
     bash scripts/publish-update-channel.sh /tmp/cg-assets/update.json
   ```

6. **When Actions returns**, start Publish release for the same version and
   commit. Its build must reproduce the published bytes: the channel check then
   reports `current`, Publish attests those bytes, and it writes nothing else.
   If the rebuild differs, the channel check refuses; record on the issue that
   the break-glass bytes were not reproducible, and ship the next release
   through the workflow.

---

## The one-off v2.0.6

There is no maintenance line (plan, "Decisions", item 2). v2.0.6 is built on the
local branch `release/v2.0.6` from the v2.0.5 tag, released once, and never merged
to `main`. It reaches users only after Josh approves the release.

**Recommended: publish by hand from the tested bytes** (waiting on Josh). v2.0.5's
legacy workflow rebuilds the XPI with a plain `zip -r`, so users would get bytes
nobody tested, and it runs `npm install` with install scripts while holding
`contents: write`. The `release/v2.0.6` tree therefore has no `release.yml`, so
creating its tag runs nothing, and a local script:

1. Checks that the XPI's SHA-256 is the one the release smoke test passed; that
   the manifest and `update.json` carry version `2.0.6`, cap `10.0.*`, the
   release's download link and a matching `update_hash`; that the tree has no
   `release.yml`; that no v2.0.6 tag or release exists; that the live channel
   serves 2.0.5; and that ruleset 24140405 is active. `PREFLIGHT_ONLY=1` stops
   here and writes nothing.
2. Pushes the branch, sets the ruleset to **Disabled**, creates the v2.0.6
   release with the XPI and `update.json` (which creates the tag), and sets the
   ruleset back to **Active**, also when a step fails.
3. Moves the `release` tag and replaces the channel's `update.json`.
4. Downloads both files back and compares them with what was tested.

**Fallback: the legacy workflow**, as first planned. Lift the ruleset, push the
tag on a tree that still has `release.yml`, and restore the ruleset once the run
starts. It publishes rebuilt bytes, so repeat the smoke test on the published
XPI.

After either path, confirm the channel lists 2.0.6, then disable the legacy
workflow ([One-time repository setup](#one-time-repository-setup), step 4). The
release guard needs no branch option: every later release comes from `main`.

---

## Upkeep

- **REST API version.** Every `gh api` call the release scripts and workflows
  make sends `X-GitHub-Api-Version: 2022-11-28`
  (`scripts/release-github.mjs`, and the two shell scripts). Version 2026-03-10
  removes `merge_commit_sha` from every pull request payload, which the guard
  reads, and GitHub supports 2022-11-28 until **2028-03-10**
  ([API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions)).
  Before then the guard needs another source for a pull request's merge commit,
  such as GraphQL's `PullRequest.mergeCommit`.
- **Pinned actions.** Every action is pinned to a commit SHA with its
  `# vX.Y.Z` comment; update both together.
- **zizmor.** CI's workflow audit runs zizmor 1.30.1 through
  `zizmorcore/zizmor-action` v0.6.4, which pins zizmor's container image by
  digest; bump the two together. Record any ignore in `.github/zizmor.yml`
  with its reason. It is not part of `npm run verify`, because it is not an npm
  package and has to be installed or pulled first; to run it locally:
  `docker run --rm -v "$PWD:/workspace:ro" -w /workspace ghcr.io/zizmorcore/zizmor:1.30.1 --collect=workflows .`
- **actionlint.** `.github/actionlint.yaml` ignores one message,
  `queue` under `concurrency`, which GitHub documents and actionlint 1.7.12 does
  not know yet. Remove the ignore once actionlint learns the key.
