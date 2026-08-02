---
name: cut-release
description: Cut a new Jot release (push the version tag and let GoReleaser own the GitHub release) and then rewrite its changelog from a bare "What's Changed" PR list into a curated one with breaking changes and migration steps called out. Use whenever the user asks to release, cut a release, tag a release, ship vX.Y.Z, publish a new version, or clean up/rewrite/improve a release's changelog or release notes. Never create the release from the GitHub Releases UI and never push a tag without checking the immutable-release guard first — this repo's release.yml/.goreleaser.yml (see PR #809) exist specifically because doing either bricks the tag: GitHub's immutable releases reject every asset upload once a release is published out of order, and a bricked tag can never be deleted, moved, or reused.
---

# Cut a Jot release

Two jobs, always in this order:

1. **Cut the release** — push a tag, let the `Release` workflow (GoReleaser + Docker)
   build and publish it.
2. **Rewrite the changelog** — replace the bare, auto-generated "What's Changed" PR-title
   list with a curated one: highlights, breaking changes grouped together with migration
   steps, improvements, bug fixes.

Don't start on job 2 until job 1 has actually finished — there is nothing to rewrite until
GoReleaser has created and published the release.

## Why the order is fixed — immutable releases

Immutable releases are enabled on this repository. Once a release is **published**, GitHub
freezes its assets — no further uploads, ever. GoReleaser already handles this correctly on
its own: it creates the release as a **draft**, uploads the `jot`/`jotctl` archives and
`checksums.txt`, then undrafts (publishes) it. That order only works if GoReleaser is the
one *creating* the release.

If a release for the tag already exists and is published — e.g. someone created it from the
GitHub UI, which publishes immediately — GoReleaser reuses that release as-is and every
asset upload comes back `422 Cannot upload assets to an immutable release`. This is exactly
what happened to [v0.8.7](https://github.com/hanzei/jot/releases/tag/v0.8.7): it shipped
with **zero assets**, and because the Docker jobs `needs: goreleaser`, no `hanzei/jot:0.8.7`
image was pushed either. Worse: an immutable release's tag cannot be deleted, moved, or
reused, so there was no way to re-cut it — the fix had to ship as the next patch version.
See [PR #809](https://github.com/hanzei/jot/pull/809) for the full writeup and the fix
(`.goreleaser.yml`'s `changelog.use: github-native`, and a pre-flight guard step in
`release.yml` that fails fast if the tag already has a published release).

**The one rule that follows from all of this: releases are cut by pushing a tag, never by
clicking "Draft a new release" on GitHub.**

## 0. Preconditions — do not skip this even if it feels obvious

Confirm the guard from #809 actually landed before you tag anything. Without it, pushing a
tag reproduces the v0.8.7 failure exactly, and there is no way to undo it once the release
publishes:

```bash
grep -q "Check the tag has no published release yet" .github/workflows/release.yml \
  && grep -q "use: github-native" .goreleaser.yml \
  && echo "guard present" || echo "MISSING — do not tag, see below"
```

If either check fails, stop. Either #809 (or its equivalent) hasn't merged yet — get it
merged first — or someone reverted the guard, which is worth flagging to the user before
doing anything else.

Also confirm:

```bash
git status --short          # clean working tree
git branch --show-current   # should be master
git fetch origin master && git log HEAD..origin/master --oneline   # nothing to pull
```

## 1. Decide the version

```bash
git tag --sort=-v:refname | head -5
```

Jot is pre-1.0 and doesn't tie the version bump to whether the release contains breaking
changes — v0.8.7 shipped several API-breaking changes (see root `CLAUDE.md`'s Development
Status Notice: breaking changes are expected and acceptable pre-v1) and was still a plain
patch bump from v0.8.6. There is no documented rule for when the minor version moves. In
practice: default to the next patch (`v0.8.6` → `v0.8.7`), and only propose a minor bump if
the user asks for one or the release is clearly a deliberate milestone. Either way, **state
the version you're about to tag and get explicit confirmation before pushing it** — an
immutable release's tag is permanent; a wrong version number cannot be taken back the way a
bad commit can.

## 2. Cut it

```bash
git checkout master && git pull
git tag vX.Y.Z
git push origin vX.Y.Z
```

`git push` here is the point of no return: it starts the `Release` workflow, and once
GoReleaser publishes, the tag and its release are permanent. Do not run the push until the
user has confirmed the version number from step 1.

## 3. Watch the workflow

The `goreleaser` job runs the guard step from #809 first — if it fails, the tag already had
a published release (shouldn't happen if step 0 passed, but check) and no assets went out;
the `docker` and `docker-merge` jobs are skipped (`needs: goreleaser`) and never run either.

Poll the run rather than guessing when it's done:

```
actions_list(method: list_workflow_runs, owner: hanzei, repo: jot,
             resource_id: release.yml, workflow_runs_filter: { branch: vX.Y.Z })
```

then `actions_get(method: get_workflow_run, resource_id: <run id>)` until `status:
completed`. A full run (build + archives + Docker for both platforms) takes a few minutes.
If `gh` is available in the environment, `gh run watch <run-id>` is equivalent and cheaper
than polling.

If the `goreleaser` job fails at the guard step, do **not** retry the same tag — re-running
just fails the same way, per the #809 writeup. Ship the next patch version instead and say
so plainly to the user.

## 4. Verify the release actually landed

```
get_release_by_tag(owner: hanzei, repo: jot, tag: vX.Y.Z)
```

Expect **5 assets**: `jot_vX.Y.Z_linux_amd64.tar.gz`, `jot_vX.Y.Z_linux_arm64.tar.gz`,
`jotctl_vX.Y.Z_linux_amd64.tar.gz`, `jotctl_vX.Y.Z_linux_arm64.tar.gz`, `checksums.txt`,
and `"draft": false`. Also confirm the `docker-merge` job succeeded — that's what pushes the
multi-arch `hanzei/jot:X.Y.Z` / `:X.Y` / `:X` / `:latest` / `:stable` manifest, not the two
per-platform `docker` jobs.

If assets are missing or the release is still a draft, something in the pipeline broke after
the guard step passed — read the job logs (`actions_get(method: get_workflow_job, ...)`
or `get_job_logs`) before touching the release by hand.

## 5. Rewrite the changelog

`changelog.use: github-native` gives every release the same bare list GitHub's own
"Generate release notes" button produces — one bullet per merged PR, title and author, no
grouping, no migration guidance. That's a fine starting point and a poor final product: root
`CLAUDE.md` requires every PR with an API-breaking change to spell out **client impact and
upgrade guidance in its own description**, which the flat PR-title list throws away. This
step recovers it.

1. **Read the generated body.** `get_release_by_tag` again (or reuse step 4's result) —
   the `body` field is the "What's Changed" list. Pull the PR number out of each bullet's
   URL; that list is the authoritative "what's actually in this release," sourced the same
   way GoReleaser built it (commits between the previous tag and this one).

2. **Pull each PR's full description.**
   `pull_request_read(method: get, owner: hanzei, repo: jot, pullNumber: N)` for every PR in
   the list. Skip fetching the diff/files — the description is what has the impact writeup.

3. **Classify each one.** Look for the sections root `CLAUDE.md` mandates:
   - A `## API-breaking change` / `## Breaking changes` heading (spelling varies slightly
     PR to PR) → this is a breaking change. Pull the **client impact** and **upgrade
     guidance** text out verbatim or lightly edited — that text already exists and is
     usually better than anything written from scratch, since the PR author wrote it with
     the actual diff in front of them. Watch for tables (env var renames, endpoint status
     code changes) and preserve them; they're the most scannable format for this kind of
     content.
   - Everything else is a normal improvement, bug fix, or purely internal change
     (dependency bump, refactor, CI/test change, new lint rule). Group by what a
     self-hoster or API consumer would care about, not by how the change was implemented.
   - A pure `chore:`/dependency-bump PR with no user-visible effect can be condensed into a
     single grouped bullet with the PR links rather than given its own line — see the
     "Internal / maintenance" section of a past release for the pattern (e.g.
     [v0.8.7's rewritten notes](https://github.com/hanzei/jot/releases/tag/v0.8.7) once
     rewritten).

4. **Assemble the sections, in this order:**
   - **Highlights** — 3-5 bullets, the changes an actual user or self-hoster would notice.
   - **⚠️ Breaking changes** — every item from the classification pass above, **each with
     its own migration/upgrade steps**, not just a description of what changed. If a PR's
     breaking-change section includes a SQL check, a before→after table, or exact
     commands, keep them — that's the part that actually helps someone upgrading a running
     instance.
   - **Improvements**
   - **Bug fixes**
   - **Internal / maintenance** — condensed, links only, no migration content (there isn't
     any).
   - Keep the closing `**Full Changelog**: https://github.com/hanzei/jot/compare/vPREV...vX.Y.Z`
     line GitHub's generator already included.

5. **Apply it.** If `gh` is available: `gh release edit vX.Y.Z --notes-file <file>` (this
   preserves the release title and tag; only the body changes). If the environment only has
   the GitHub MCP tools with no release-update tool exposed — check first, don't assume;
   confirm no such tool exists in the current session before falling back — there is
   currently no way to push the rewrite programmatically. In that case, write the drafted
   body to a file, hand it to the user, and say plainly that it needs to be pasted in via
   GitHub's "Edit release" UI. Don't claim the changelog was updated if it wasn't actually
   applied.

## 6. Verify

`get_release_by_tag` once more; confirm the body actually changed and the breaking-changes
section reads correctly rendered (tables need a blank line before/after them in release
Markdown, same as anywhere else on GitHub).

## Related

- `update-github-actions` and `update-docker-deps` own the workflow/Dockerfile plumbing this
  skill depends on (`release.yml`, `docker.yml`, the base images) — if the release pipeline
  itself needs changing, that's those skills' job, not this one.
- Root `CLAUDE.md`'s Development Status Notice is what requires every breaking-change PR to
  carry impact/upgrade text in the first place — this skill only harvests it, it doesn't
  invent it. If a merged PR is missing that section, note it in the release rewrite as best
  you can from the diff, and flag to the user that the PR description should have had it.
