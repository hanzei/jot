---
name: update-docker-deps
description: Update the Docker build tooling — base images in the Dockerfile (node, golang, alpine), the BuildKit syntax directive, container images used by CI services, docker-compose.yml, and .dockerignore. Use this whenever the user asks to update, upgrade, or refresh the Docker build, the Dockerfile, base images, the Alpine or Node or Go builder stage, the Postgres service image, or docker-compose. Prefer this over editing a `FROM` line directly — the Node and Go base images are mirrored in `.nvmrc`, `server/go.mod`, CI workflows, and the README, and a lone bump produces a failure that only appears during the image build.
---

# Update Docker build tooling

The image is a three-stage build (`Dockerfile`) published to Docker Hub as
`hanzei/jot` from `master` and to `ghcr.io/hanzei/jot` for PRs. Two of its three base
images are not independent choices: they mirror versions declared elsewhere in the
repo, and the mirror is only checked at image-build time.

In scope: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, the `# syntax`
directive, and container images referenced from workflows (the Postgres service in
`server-ci.yml`). Out of scope: the Go modules and npm packages *inside* those stages —
those belong to `update-server-deps`, `update-webapp-deps`, and `update-shared-deps`.

## Before you start

Feature branch, never `master` (root `CLAUDE.md`):

```bash
git status --short
git checkout -b chore/update-docker-deps   # or the branch you were told to use
```

Check whether you can actually build:

```bash
docker info >/dev/null 2>&1 && echo "daemon available" || echo "no daemon"
```

A sandbox often has the `docker` CLI but no daemon. That is workable — CI builds both
platforms on every PR that touches the Dockerfile — but then say plainly in the PR that
the build was not verified locally rather than implying it was.

## 1. Inventory

```bash
grep -nE '^(# syntax|FROM )' Dockerfile
grep -rnE '^\s+image:|image: ' docker-compose.yml .github/workflows/
```

Today that is `node:24-alpine`, `golang:1.26-alpine`, and `alpine:3.22` — each with a
digest (see §3a) — plus `postgres:16-alpine@sha256:...` in `server-ci.yml` and
`hanzei/jot:latest` in the compose file. That last one is Jot's own published image and
is deliberately left floating; everything else is pinned.

## 2. The two mirrored base images

**`node:24-alpine`** (frontend-builder) must equal `.nvmrc`, every workflow's
`node-version:`, and the README prerequisites. A Node major is a repo-wide decision —
`webapp/` and `mobile/` both build on it, and an `engines` bump in a dependency is the
usual reason it comes up. Coordinate with `update-webapp-deps`; do not raise it here on
its own.

**`golang:1.26-alpine`** (backend-builder) must equal the `go` directive in
`server/go.mod` and `go-version:` in `server-ci.yml`, `webapp-ci.yml`, and
`release.yml`. When `go.mod` is ahead of the builder image the error is a confusing
`go.mod requires go >= 1.27` that appears only in the image build, long after CI is
green. The toolchain bump itself belongs to `update-server-deps` — this skill's job is
to notice the drift and close it in the same commit.

## 3. The runtime base — `alpine:3.22`

The one image that moves on its own schedule. Read the release notes for the new minor
before bumping; three things in this repo depend on what Alpine ships:

- **`ca-certificates`** is the only package installed (`apk --no-cache add`). A rename
  or split upstream breaks the build immediately, which is the good case.
- **musl** — harmless today because the binary is `CGO_ENABLED=0` (see §6), but that is
  what makes it harmless, so re-check if that ever changes.
- **busybox `wget`** — `docker-compose.yml`'s healthcheck shells out to
  `wget --spider http://localhost:8080/readyz`. Moving the runtime to a distroless or
  scratch base removes `wget` and the healthcheck starts failing while the app is
  perfectly healthy. Change the healthcheck in the same commit if you change the base.

## 3a. Re-resolving digests

Every base image is pinned as tag **plus digest** (`FROM alpine:3.22@sha256:...`), per the
base-image pinning policy in root `CLAUDE.md`. The tag is the readable label; the digest
is the constraint. Bumping a base image therefore means resolving the new tag to a digest,
not just editing the tag.

**Pin the digest of the manifest index, never a single-platform manifest.** Images build
for `linux/amd64` and `linux/arm64`; a platform-specific digest resolves on one leg of the
matrix and fails on the other, so the mistake shows up as an arm64-only CI failure. With a
daemon:

```bash
docker buildx imagetools inspect alpine:3.23 --format '{{.Manifest.Digest}}'
```

Without one — the common case in a sandbox — go straight to the registry:

```bash
repo=library/alpine tag=3.23
tok=$(curl -sS "https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull" | jq -r .token)
curl -sSI -H "Authorization: Bearer $tok" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' \
  "https://registry-1.docker.io/v2/${repo}/manifests/${tag}" \
  | tr -d '\r' | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2}'
```

Then confirm what you got is actually an index covering both architectures — this is the
check that catches the single-platform mistake before CI does:

```bash
curl -sS -H "Authorization: Bearer $tok" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  "https://registry-1.docker.io/v2/${repo}/manifests/<digest>" \
  | jq -r '.mediaType, ([.manifests[]? | select(.platform.os=="linux") | .platform.architecture] | join(", "))'
```

Expect an index media type and both `amd64` and `arm64` in the architecture list.

Digests do not update themselves. This skill is the only thing that pulls base-image
security patches into the build, so re-resolve all three whenever you run it, even if no
tag changed — a tag that still reads `3.22` may point at a newer patch image than the
pinned digest.

## 4. The `# syntax` directive

`# syntax=docker/dockerfile:1` floats on the 1.x line deliberately: BuildKit resolves
it per build, and it is what keeps `--mount=type=cache` available. Leave it floating.
If a new frontend release ever breaks the build, pin to the last good patch **and write
the reason in a comment** — an unexplained pin here reads as an accident and gets
reverted.

## 5. Container images in CI

`server-ci.yml` runs Postgres as a service image, digest-pinned with the tag preserved
in a trailing comment:

```yaml
image: postgres:16-alpine@sha256:e013e867... # 16-alpine
```

Re-resolve it the same way as the base images (§3a) — `repo=library/postgres tag=16-alpine`
for the daemon-free route — and keep the trailing comment matching the tag. Unlike a
`FROM` line, YAML has nowhere to put the tag inline, which is why the comment carries it.

A Postgres **major** bump is not a routine version bump: the store and migration tests
run the whole migration tree against this server, so it is a genuine compatibility test
of `migrations/postgres/`. Do it as its own commit and call it out in the PR — users
running Postgres are affected by what the schema is verified against.

## 6. Build args, cache mounts, and the CGO divergence

- `COMMIT_SHA`, `VERSION`, `BUILD_DATE` are injected via `-ldflags` into
  `internal/server` and surface on the version endpoint. They are supplied by
  `docker.yml` **and** `release.yml`; adding or renaming one means editing both.
- The `--mount=type=cache` ids are suffixed with `${TARGETARCH}` so the amd64 and arm64
  matrix legs do not evict each other's caches. Keep that suffix on any cache mount you
  add.
- The image builds the server with `CGO_ENABLED=0` (pure-Go SQLite driver), while
  `.goreleaser.yml` builds the release binaries with `CGO_ENABLED=1` and an aarch64
  cross-compiler. That divergence is deliberate — do not harmonise them. It is also why
  the builder stage needs no `gcc`/`musl-dev`; a dependency that requires cgo would
  change that and is worth flagging loudly.

## 7. `.dockerignore`

The build context is the repo root, and the Dockerfile copies whole directories
(`COPY shared/ ../shared/`, `COPY webapp/ ./`, `COPY server/ server/`). Anything not
ignored is shipped into the build. When a new top-level directory or a large generated
tree appears, add it — the current file excludes `node_modules`, `*.md`, coverage and
IDE dirs. Check the context size if builds get slow:

```bash
docker build --no-cache --progress=plain . 2>&1 | grep -m1 'transferring context'
```

## 8. Verify

```bash
docker build -t jot:check .
docker images jot:check --format '{{.Size}}'     # compare against the previous build

cid=$(docker run -d -p 8080:8080 jot:check)
trap 'docker rm -f "$cid" >/dev/null' EXIT
curl --retry 10 --retry-connrefused -fsS localhost:8080/readyz
```

Run the built image, not `docker compose up`. The compose file pins
`image: hanzei/jot:latest` and has no `build:` section, so it pulls the published image
and tells you nothing about your change. The `trap` matters because the readiness check
is the step most likely to fail — without it a failed run leaves a container holding
port 8080 and the next attempt fails for the wrong reason.

The arm64 leg is the one that breaks quietly, since only CI builds it:

```bash
docker build --platform linux/arm64 -t jot:check-arm64 .   # needs buildx + binfmt
```

Then confirm the running container still serves the SPA and the API, not just
`/readyz` — a broken frontend stage produces an image that starts fine and serves
nothing.

## 9. Documentation

Two places restate the stages by version and go stale silently:

- `README.md` → "Docker Deployment" (stage list, available tags)
- root `CLAUDE.md` → "Docker (Production)" (`Node 24 Alpine` / `Go 1.26 Alpine` / Alpine runtime)

Root `CLAUDE.md` requires documentation updates when build tooling changes; both of
these count.

## 10. Commit and describe

One commit per image:

```text
chore(docker): update runtime base to alpine 3.23
```

In the PR description: every image that moved with old → new, what changed in the new
base (especially for an Alpine or Postgres major), and whether you verified the build
locally or are relying on the Docker workflow. Because these images ship to every
self-hosted install, anything that changes runtime behaviour — TLS roots, healthcheck,
data paths under `/data` — needs the explicit impact-and-migration note that root
`CLAUDE.md` requires for existing installations.

## Related

`update-github-actions` covers the workflows that *build* this image (action pins,
runner labels, permissions). The version numbers themselves live with the language
skills: `update-server-deps` (Go), `update-webapp-deps` (Node).
