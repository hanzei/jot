---
name: update-github-actions
description: Update GitHub Actions workflows — re-pin every external action to a current commit SHA, bump action majors, and keep runner labels, permissions, and path filters correct. Use this whenever the user asks to update, upgrade, refresh, or re-pin GitHub Actions, workflow files, `.github/workflows/**`, action versions, `uses:` refs, or CI runner images. Prefer this over editing a `uses:` line by hand — this repo pins every action to a full SHA with a `# vN` comment, the same action appears across eight workflows and must land on one SHA everywhere, and several actions are coupled in pairs that break silently when only one moves.
---

# Update GitHub Actions

Eight workflows live in `.github/workflows/`: `server-ci`, `webapp-ci`, `shared-ci`,
`mobile-ci`, `mobile-apk`, `docker`, `docker-cleanup`, and `release`. There is no
Dependabot, so re-pinning is manual and deliberate.

The pinning policy (root `CLAUDE.md`) is absolute: every external `uses:` is a **full
40-character commit SHA** with an inline `# vN` comment naming the intended major. No
`@v6`, `@main`, or `@latest`.

## Before you start

Feature branch, never `master`:

```bash
git status --short
git checkout -b chore/update-github-actions   # or the branch you were told to use
```

## 1. Inventory

```bash
grep -rhoE 'uses: [^ ]+@[0-9a-f]{40} # \S+' .github/workflows | sort -u
```

That lists what is pinned, but by construction it can only show refs that are *already*
compliant — an `actions/cache@v4` slipped in by hand is invisible to it. So start from
the complement: every external `uses:` that is **not** a SHA-plus-comment pin.

```bash
grep -rnE '^\s*(- )?uses:' .github/workflows \
  | grep -v 'uses: \./' \
  | grep -vE 'uses: [^ ]+@[0-9a-f]{40} +# \S+'
```

Empty output means every external ref satisfies the policy. Anything printed is a
violation — fix those before bumping anything, since the next check assumes compliance.
The `./` exclusion is for local composite actions and reusable workflows, which are
versioned by the commit you are on and take no pin.

Only then check for divergence — the same action pinned to two different SHAs in two
workflows, the failure mode this repo is most prone to because `actions/checkout`
appears in seven files:

```bash
grep -rhoE '[A-Za-z0-9._/-]+@[0-9a-f]{40}' .github/workflows \
  | sort -u | cut -d@ -f1 | uniq -d
```

Empty output means every action is on exactly one SHA. Any name printed is a
divergence to fix before you start bumping.

## 2. Resolve tags to commit SHAs

Major tags float — `v6` today is not the `v6` you pinned last month, and picking up
those patch moves is most of the value of this sweep.

```bash
git ls-remote https://github.com/actions/checkout 'refs/tags/v6' 'refs/tags/v6^{}'
# which majors exist — one deterministic row per major tag, newest last
git ls-remote --tags --refs https://github.com/actions/checkout 'refs/tags/v*' \
  | grep -E 'refs/tags/v[0-9]+$'
```

**Use the `^{}` line when it appears.** An annotated tag's plain ref is the tag *object*,
not the commit; pinning it looks entirely valid and fails at run time with `Unable to
resolve action`. When no `^{}` line is printed the tag is lightweight and the plain ref
is already the commit.

With `gh` available, this sidesteps the distinction entirely:

```bash
gh api repos/actions/checkout/commits/v6 --jq .sha
```

Read the release notes for anything crossing a major before you pin it.

## 3. Apply

Batch same-major re-pins; give each **major** its own commit. Move every workflow
together — a scripted replace is more reliable than seven manual edits:

```bash
grep -rl 'actions/upload-artifact@OLDSHA' .github/workflows \
  | xargs sed -i 's|actions/upload-artifact@OLDSHA # v<old>|actions/upload-artifact@NEWSHA # v<new>|g'
```

Update the `# vN` comment whenever the major changes. It is the only human-readable
version signal in the file, and a stale comment is worse than none — the next sweep
trusts it and re-resolves the wrong tag. Re-run the divergence check from §1 after each
batch.

## 4. Coupled actions and known breakage

- **`actions/upload-artifact` + `actions/download-artifact`** — move as a pair. Since v4
  artifacts are immutable and same-name uploads collide, which is exactly why
  `docker.yml` and `release.yml` upload `digests-amd64` / `digests-arm64` from the matrix
  legs and reassemble with `pattern: digests-*` + `merge-multiple: true`. A major on
  either side means re-reading that handoff, not just swapping a SHA.
- **The `docker/*` family** — `setup-buildx-action`, `login-action`, `metadata-action`,
  `build-push-action`. `build-push-action`'s `outputs: type=image,push-by-digest=true`
  and the `$DOCKER_METADATA_OUTPUT_JSON` consumed by the `imagetools create` steps are
  contract surfaces between two of these actions. Bump the family together and re-read
  the digest/manifest steps.
- **`actions/setup-go` / `actions/setup-node`** — cache behaviour and the
  `cache-dependency-path` input have changed across majors. Both are used with explicit
  dependency paths (`server/go.sum`, `*/package-lock.json`); confirm they still apply.
- **`goreleaser/goreleaser-action`** — the action SHA and the GoReleaser CLI version
  (`version: "~> v2"`) are two independent pins. Bumping the action does not move the
  CLI, and a GoReleaser major means re-reading `.goreleaser.yml`.
- **`gradle/actions/setup-gradle`** — a subpath action in a monorepo; the SHA is the
  repo-root commit, so resolve tags against `gradle/actions`, not a `setup-gradle` repo.
- **`go-task/setup-task`** with `version: 3.x` — the Task version floats on purpose;
  only the action itself is pinned.

## 5. What not to touch here

These appear in workflows but are owned elsewhere. Do not bump them as part of an
action sweep — but do check they still match their source, since drift shows up here
first:

| In workflows | Source of truth | Skill |
|---|---|---|
| `go-version: "1.26"` | `server/go.mod` | `update-server-deps` |
| `node-version: "24"` | `.nvmrc`, `Dockerfile` | `update-webapp-deps` |
| `java-version: "17"`, NDK/CMake pins | Expo SDK requirements | `update-mobile-deps` |
| `postgres:16-alpine@sha256:...` | — | `update-docker-deps` |

## 6. Runner labels, permissions, and fork guards

- Most jobs use `ubuntu-latest`; the Docker and release image jobs pin `ubuntu-24.04`
  with `ubuntu-24.04-arm` for the arm64 leg. There is no `ubuntu-latest-arm` — if you
  pin one leg of a matrix, pin both to the same Ubuntu release so the two platforms
  build on the same base.
- Every workflow declares a top-level least-privilege `permissions:` block
  (`contents: read`, plus `packages: write` for the ghcr pushes and `contents: write`
  for the release). Never widen one during a version sweep; if a new action version
  genuinely needs another scope, that is a separate, called-out change.
- Steps gated on `github.event.pull_request.head.repo.full_name == github.repository`
  are fork guards — secrets are unavailable to fork PRs, so those steps must stay
  conditional. Preserve the condition when you edit or reorder a step; dropping it turns
  fork PRs from "skips the push" into "fails the job".

## 7. Path filters decide what your PR actually proves

The CI workflows include `.github/workflows/**` in their `paths:` filter, so editing any
workflow re-runs server, webapp, shared, and mobile CI — that coverage is free.
`docker.yml` filters on source directories plus its own file only, so an edit to a
different workflow does **not** rebuild images, and `release.yml` and
`docker-cleanup.yml` never run on a PR at all. If your change touches those, re-read the
diff carefully and say in the PR that they are unverified until a tag or a PR close
exercises them.

## 8. Verify

There is no local runner, so verification is mostly static:

```bash
actionlint            # if installed: syntax, expression, and shellcheck on run: blocks

# both §1 checks again — every external ref pinned, and each action on one SHA
grep -rnE '^\s*(- )?uses:' .github/workflows | grep -v 'uses: \./' \
  | grep -vE 'uses: [^ ]+@[0-9a-f]{40} +# \S+'
grep -rhoE '[A-Za-z0-9._/-]+@[0-9a-f]{40}' .github/workflows | sort -u | cut -d@ -f1 | uniq -d
```

Both must print nothing. Re-running the first one here is the point: a hand-edited
`uses:` line is exactly what a sweep introduces, and it is the one mistake the
divergence check cannot see.

Then push and read the run list: confirm every workflow that should have triggered did,
and that no job failed at startup with `Unable to resolve action` — that error means a
bad SHA (usually a tag object, see §2), not a broken workflow.

## 9. Commit and describe

One commit per major, batched commits for same-major re-pins:

```text
chore(ci): re-pin actions to current v6/v7 releases
chore(ci): update actions/download-artifact to v8
```

In the PR description, list each action with old → new SHA and old → new major, call out
behavioural changes for majors (artifact semantics, cache defaults, docker build
outputs), and name the workflows a PR run cannot exercise (`release.yml`,
`docker-cleanup.yml`) so the reviewer knows what is still untested. Note anything held
back and why — "stayed on `setup-node` v6, v7 drops Node 20 runner support" saves the
next sweep the same investigation.

## Related

`update-docker-deps` covers the Dockerfile and the container images these workflows
build and run.
