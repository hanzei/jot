# Feature Spec: Note Images

Status: **Draft / proposal** — for discussion before implementation.
Owner: TBD · Target: Jot (self-hosted note app)

---

## 1. Summary

Let users attach **images** to notes. Images render in a **gallery above the
note body** (Google Keep style) — a single image as a full-width banner, two or
more as a thumbnail grid. They are *not* embedded into the markdown body; they
are a first-class part of the note that travels with it through sharing, export,
and trash.

This builds on the binary-handling pattern Jot already ships for **profile
icons** (`UploadProfileIcon` / `GetUserProfileIcon` in
`server/internal/handlers/auth.go`): `MaxBytesReader` + multipart parse +
`http.DetectContentType` + image-type allowlist + image decode/resize +
`X-Content-Type-Options: nosniff` on serve. The main new decisions are **where
the bytes live** (the profile-icon BLOB-in-DB approach does not scale to many
images) and **how images bind to a note and render in order**.

Scope is deliberately narrow: **images only** (no PDFs/documents), **rendered as
a gallery** (no markdown embedding), **max 10 per note**.

---

## 2. Goals / Non-goals

**Goals (v1)**
- Attach up to **10 images** to a note (owner or a user the note is shared with).
- Images render **above the note title/body**: one image = banner, 2+ = grid
  gallery; tap to open a full-screen lightbox/carousel.
- Images inherit the note's access rules (owner **or** shared user).
- Images survive sharing, trash/restore, export, and import where feasible.
- Sensible limits + validation; protect against accidental internal overload
  (per the project threat model), not malicious insiders.
- Works on both supported DB backends (SQLite default, Postgres).

**Non-goals (v1)**
- Non-image files (PDF, documents, arbitrary uploads) — images only.
- Markdown/inline embedding of images into the note body.
- Image editing/cropping (beyond decode + thumbnail), OCR, full-text indexing.
- External object stores (S3/GCS) — designed so a backend can be added later.
- Per-image ACLs distinct from the note's sharing; image versioning.

---

## 3. UX

### 3.1 Webapp (primary surface — `NoteModal.tsx`)

**Adding images**
- **Drag & drop** image files onto the open note modal → upload starts, a
  progress placeholder appears in the gallery.
- **Paste** (`Ctrl/Cmd+V`) an image from the clipboard → uploads and appends to
  the note's image set (no markdown is inserted).
- **Toolbar button** (🖼 image icon) → native file picker, image types only,
  multi-select.

**Rendering** (matches the supplied mockups)
- Images render in a **header region above the note title**:
  - **1 image** → full-width banner.
  - **2+ images** → responsive thumbnail grid (e.g. 2 columns), cropped to
    uniform tiles; the last tile shows a "+N" overlay if more exist than fit.
- Tap/click any image → full-screen **lightbox** with swipe/arrow navigation
  (keyboard-dismissable, consistent with existing `@headlessui` modals).
- **NoteCard** in the grid shows the **first image as a cover thumbnail** at the
  top of the card (Keep-style), with a small "+N" badge when there are more.

**Managing**
- Hover a gallery tile → remove via a **trash/bin icon** (🗑). Removing hides the
  image immediately and shows an **undo toast** ("Image removed — Undo"). Clicking
  Undo restores it instantly; letting the toast expire finalizes the removal. See
  §6/§10 for the soft-delete + restore mechanics behind this. No markdown cleanup
  needed since images are not referenced from the body.
- Images display in **upload order** (no user reordering in v1).
- Upload states: queued → uploading (progress %) → done / error (retry).

**Errors (inline toast + tile state)**
- Too large: "Image exceeds the 25 MB limit."
- Wrong type: "Only images can be attached."
- Too many: "Notes can have up to 10 images."

**Accessibility**: image button has a label; tiles get `alt` from the original
filename; lightbox is keyboard navigable/closeable.

### 3.2 Mobile (`mobile/`)

- "Add image" action in the note screen → **Camera**, **Photo Library**, or
  **Files** (Expo pickers, images only).
- Gallery renders above the note body, same banner/grid rules; tap → full-screen
  viewer.
- Remove uses the same **trash/bin icon** and shows an **undo toast** (Snackbar);
  Undo restores the image, expiry finalizes the removal — same soft-delete flow
  as the webapp.
- Uploads queue through the existing React Query mutation layer; offline =
  queued and flushed by the sync hook when back online (offline-first design).
  Pending images render with a spinner.
- Downloaded images cached via Expo FileSystem to avoid re-fetch.

### 3.3 Empty/limit states
- A note with no images shows no gallery region.
- Limit/error copy is localized — add keys to all 8 locales and run
  `task check-translations`.

---

## 4. Data model

New `note_images` table. Bytes are stored on disk (see §5); the row holds
metadata + a content hash. Mirror migrations in **both**
`server/internal/database/migrations/sqlite/` and `.../postgres/` as the next
sequential number (`000004_add_note_images.up.sql` / `.down.sql`).

```sql
-- sqlite
CREATE TABLE note_images (
    id            TEXT PRIMARY KEY,              -- 22-char crypto id (models.NewID)
    note_id       TEXT NOT NULL,
    uploader_id   TEXT NOT NULL,                 -- who uploaded (owner or shared user)
    filename      TEXT NOT NULL,                 -- original, for display/alt text
    content_type  TEXT NOT NULL,                 -- validated image/* type
    size_bytes    INTEGER NOT NULL,
    sha256        TEXT NOT NULL,                 -- content hash (storage key + dedup)
    width         INTEGER NOT NULL,              -- captured at upload
    height        INTEGER NOT NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,  -- also the gallery sort key
    deleted_at    DATETIME DEFAULT NULL,         -- soft-delete for undo (§6/§10)
    FOREIGN KEY (note_id)     REFERENCES notes (id) ON DELETE CASCADE,
    FOREIGN KEY (uploader_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX idx_note_images_note_id ON note_images(note_id, created_at);
CREATE INDEX idx_note_images_sha256  ON note_images(sha256);
```

(Postgres variant: `TIMESTAMPTZ`, `BIGINT` for size, `INTEGER` for dims.)

`ON DELETE CASCADE` from `notes` means permanently deleting a note (post-trash)
drops its image rows automatically; on-disk blobs are reclaimed by the orphan
sweep in §10.

A `Note` response gains an `images []NoteImage` field (omitempty, ordered by
`created_at`, `deleted_at IS NULL` only), built alongside
`Items`/`Labels`/`SharedWith` in the note store, and a matching `NoteImage`
interface in `shared/src/types.ts` (single source of truth — do not redefine in
webapp).

---

## 5. Storage backend

**Decision: store bytes on the filesystem, content-addressed by SHA-256, behind
a small pluggable interface. Do not extend the profile-icon BLOB-in-DB approach
to note images.**

Rationale:
- Profile icons are one small resized image per user — fine as a BLOB. Up to 10
  full-size images per note across many notes would bloat the SQLite file /
  Postgres rows, hurt backups, and stream poorly.
- Content addressing gives free dedup (same image attached twice = one blob) and
  immutable, traversal-proof storage keys.

```go
type Blobstore interface {
    Put(ctx context.Context, sha string, r io.Reader) error
    Open(ctx context.Context, sha string) (io.ReadSeekCloser, error)
    Delete(ctx context.Context, sha string) error
}
```

- **v1 backend: `fsBlobstore`** rooted at a new config `UPLOAD_DIR`
  (default `./uploads`, sibling of the `./jot.db` DSN; in Docker this lives under
  the mounted `/data` volume). Both originals and thumbnails live under this one
  root — **not** a separate top-level `./thumbnails` — so there is a single
  config value, a single volume to mount, and a single thing to back up:

  ```
  UPLOAD_DIR/
    blobs/  <sha[0:2]>/<sha[2:4]>/<sha>        # originals (source of truth)
    thumb/  <sha[0:2]>/<sha[2:4]>/<sha>.jpg    # derived tiles
  ```

  Directories are fanned out by hash prefix to stay shallow. Every path is
  derived solely from the validated hex hash, so user input never reaches the
  filesystem path (no traversal).
- **Thumbnails are a derived cache, not an entity.** A thumbnail is deterministic
  from `(original sha256, target size)`, so it is keyed by the *original's* sha
  and gets **no `note_images` row and no refcount of its own**. Generate it with
  the avatar resize pipeline (output JPEG, so the thumbnail response is always
  `image/jpeg`); regenerate on demand if the file is missing since it is
  disposable. Grid tiles use the thumbnail; the lightbox uses the original. A
  future multi-size need extends the key to `<sha>_<w>.jpg` with no schema change.
- **Thumbnail lifecycle rides on the original.** When an original's refcount hits
  zero and it is GC'd (§10), delete its `thumb/<sha>.jpg` in the same step — no
  separate sweep.
- The interface leaves room for an S3 backend later without touching handlers.

**Backup note for operators**: a full backup is now *DB + the upload dir*
(previously DB-only). This is a documentation change — call it out in README and
the PR description per the project's compatibility rules.

> Alternative considered — keep everything in the DB as a BLOB for "one-file
> backup" parity with profile icons. Rejected for v1 on size/scaling grounds; the
> `Blobstore` interface could trivially get a `dbBlobstore` later if single-file
> backup is judged more important than scale.

---

## 6. API

All routes sit behind the existing auth middleware (session cookie or PAT) and
follow the `(int, any, error)` handler signature wrapped by `wrapHandler`.
`wrapHandler` already promotes `*http.MaxBytesError` to **413**, so the size cap
needs no special handling. Regenerate Swagger with `task gen-docs` after adding
annotations.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/notes/{noteId}/images` | Upload an image to a note (multipart `file`). 201 → `NoteImage`. Requires note write access (owner or shared). |
| `GET` | `/api/images/{id}` | Stream the full-size image bytes. Requires access to the parent note. |
| `GET` | `/api/images/{id}/thumbnail` | Resized thumbnail for grid tiles. |
| `DELETE` | `/api/images/{id}` | **Soft-remove** the image (sets `deleted_at`, hides it). Requires note access. |
| `POST` | `/api/images/{id}/restore` | Undo a removal within the grace window (clears `deleted_at`); `410 Gone` if already swept. |

**Authorization**: every route resolves the parent note and reuses the existing
"owner **or** shared-with" check (same predicate as note read/update). No new
permission concept — an image is exactly as accessible as its note. PAT-auth
works identically.

### 6.1 How clients fetch the note list

**Decided**: image metadata is **embedded in every `Note`** (list and single-note
`GET /notes/{id}` alike), just like the existing embedded `items` / `labels` /
`shared_with`. Because clients always receive the full image list with the note,
there is **no separate `GET /api/notes/{noteId}/images` endpoint** — it would be
redundant.

`GET /api/notes` (and its `?trashed` / `?archived` / `?search` / `?label` /
`?my_tasks` variants) is **unchanged in shape**: it still returns an array of
`Note` objects. Each note simply gains an `images` array. No new list endpoint,
no pagination change, no extra round-trip to discover a note's images.

- **Metadata only in the JSON.** Each embedded `NoteImage` is
  `{ id, filename, content_type, width, height, created_at }` (a few hundred
  bytes). Image *bytes* are never in the list payload.
- **Batch-loaded, no N+1.** Images for the whole result set are loaded in a
  single query (`WHERE note_id IN (...) AND deleted_at IS NULL ORDER BY note_id,
  created_at`), mirroring the existing `batchLoadSharesAndLabels` — one extra
  query per list request regardless of note count.
- **Bytes fetched out-of-band and cached.** Clients render tiles from
  `GET /api/images/{id}/thumbnail` and the lightbox from `GET /api/images/{id}`.
  Both are immutable (content-addressed, `ETag = sha256`, `Cache-Control`), so
  they are served from cache on subsequent list loads. The embedded
  `width`/`height` let clients reserve tile aspect ratios up front to avoid
  layout reflow while thumbnails load.
- **Stays live via SSE.** `note_image_added` / `note_image_removed` (§8) patch the
  already-loaded list without a refetch.

After an upload (`POST` → `NoteImage`) or a remove/restore, clients patch the
note's embedded `images` array locally; SSE delivers the same change to other
clients.

**Upload handler** (mirrors `UploadProfileIcon`):
1. `r.Body = http.MaxBytesReader(w, r.Body, limit+overhead)`; `ParseMultipartForm`.
2. Read `file`, enforce the **10-per-note** cap, compute SHA-256 while reading.
3. `http.DetectContentType` → must be in the **image allowlist** (§7); reject
   anything else (this is what enforces "images only").
4. **Decode the image** to confirm it's valid and capture width/height (reuse the
   avatar pipeline). Generate/queue a thumbnail.
5. `Blobstore.Put` (no-op if hash already present → dedup), insert the row.
6. Emit SSE event (§8), return `NoteImage`.

**Remove/undo**: `DELETE` sets `deleted_at` and emits `note_image_removed`; the
image drops out of note responses immediately, powering the undo toast.
`POST .../restore` clears `deleted_at` (emits `note_image_added`) if still within
the grace window. The blob is untouched until the sweep finalizes the delete
(§10), so restore is instant and needs no re-upload.

**Download handler** (mirrors `GetUserProfileIcon`):
- Set `Content-Type` from the stored image type and **`X-Content-Type-Options:
  nosniff`**. Serve **inline** (images are safe to render; no forced-download
  branch needed since only images exist).
- Use `http.ServeContent` with the blob's `ReadSeeker` for range requests,
  `ETag` (= sha256) and caching. Content is immutable per hash, so
  `Cache-Control: private, max-age=...` is safe.

---

## 7. Limits, validation & security

Add to `shared/src/constants.ts` (and a server-side mirror in
`internal/handlers/validation.go`) so client and server agree:

- `UPLOAD_MAX_BYTES` — default **25 MB** per image. Configurable via env
  `UPLOAD_MAX_BYTES` using the existing `parseIntRangeEnv` helper.
- `IMAGE_MAX_PER_NOTE` — **10**.
- `IMAGE_ALLOWED_TYPES` — `image/png`, `image/jpeg`, `image/webp`, `image/gif`.

Security posture (consistent with the project threat model — guard against
accidental internal overload; baseline authz mandatory):
- **Type enforcement**: validate with `http.DetectContentType` *and* a successful
  image decode; store the detected type; serve with `nosniff`.
- **Exclude `image/svg+xml`** from the allowlist — SVG can carry script and would
  be a stored-XSS vector when rendered inline. (If SVG is ever wanted, it must be
  served `Content-Disposition: attachment`, never inline.)
- **Path safety**: storage key is the hex hash; the original filename is stored
  for display/alt only and never used as a filesystem path.
- **Authz**: parent-note access check on every read/write/delete; IDs are
  22-char crypto-random and access is still verified (no enumeration).
- **Overload protection** (priority per `CLAUDE.md`): the 10-per-note cap, the
  size cap, plus a per-user upload rate limit / concurrent-upload cap aligned
  with existing middleware.
- A per-user/instance storage quota is a candidate follow-up (§15).

---

## 8. Realtime (SSE)

Add `EventType`s in `internal/sse/hub.go` (the hub already has `note_updated`,
`profile_icon_updated`, etc.):
- `note_image_added` / `note_image_removed`, payloads `{ note_id, image }` /
  `{ note_id, image_id }`. A restore (undo) re-emits `note_image_added`.
- Fan-out audience = the note's owner + shared users (same logic as
  `note_updated`), so a collaborator sees a new image appear without reload.

Simpler alternative: piggyback on `note_updated` and have clients refetch images.
Dedicated events are cheaper and match existing granularity.

---

## 9. Sharing, trash, export/import

- **Sharing**: nothing extra to store — images are reachable by anyone with note
  access. A shared user can add/remove images (write access), matching how
  shared notes already allow content edits.
- **Trash/restore**: images stay attached through soft-delete (note
  `deleted_at`); blobs become reclaimable only after the note is *permanently*
  deleted (cascade removes rows; §10 reclaims bytes).
- **Export** (`handlers/export.go`): include image metadata and bundle blobs
  (e.g. an `images/` folder in a zip, or base64-inline for JSON export — decide
  per the current export format).
- **Import** (`handlers/import.go`): re-create images from the bundle, re-hashing
  and de-duping on the way in; if a blob is missing, import the note without it
  and warn.

---

## 10. Lifecycle & orphan cleanup

- **Soft-delete finalization**: rows whose `deleted_at` is older than the undo
  grace window (config, e.g. a few minutes) are hard-deleted by the sweep. Until
  then they can be restored (§6).
- Dedup means a blob may be referenced by multiple rows (same image on several
  notes). **Reference count = `COUNT(*) FROM note_images WHERE sha256=?`** (rows
  pending soft-delete still count, so their blob survives for undo).
- On row hard-delete (sweep finalization or note hard-delete): if no rows
  reference that `sha256`, `Blobstore.Delete` the blob (and its thumbnail).
- A periodic **sweep** (startup + daily, plus the grace-window pass above)
  deletes on-disk blobs with zero referencing rows, covering crash races. A row
  whose blob is missing is logged and surfaced as a broken tile.
- Removing an image just hides its gallery tile — no markdown references to clean
  up.

---

## 11. Migrations & backward compatibility

- Additive only: new `note_images` table + new `UPLOAD_DIR`. Existing installs
  migrate cleanly with no data changes; the table starts empty.
- New env `UPLOAD_DIR` (default `./uploads`); document in README + Docker (ensure
  it resolves under the `/data` volume so it persists and is backed up).
- API change is additive (`Note.images`), but per `CLAUDE.md` the **backup-surface
  change (DB → DB + upload dir)** must be called out explicitly in the PR
  description with operator upgrade guidance.

---

## 12. Telemetry

- Wrap the image store with an `_otel.go` variant like existing stores
  (`note_store_otel.go`, etc.).
- Metrics: upload count/bytes, dedup hit rate, total blob bytes on disk, sweep
  reclaimed bytes. Trace spans on upload (read → validate → decode → put →
  insert) and download.

---

## 13. Phasing

- **MVP**: `note_images` table + `fsBlobstore`, upload/list/get + soft-delete +
  restore (undo toast), size+type+count limits, image decode/validation, webapp
  picker + drag/drop + paste, gallery-above-body rendering (banner + grid),
  lightbox, inline serving with `nosniff`, auth via note access.
- **v1.1**: thumbnails endpoint + grid tiles using them, SSE live updates,
  NoteCard cover thumbnail, mobile camera/library/files + offline queue.
- **Later**: export/import bundling, storage quotas, S3 backend.

---

## 14. Testing

- **Server integration** (new `server/http_note_images_test.go`, following
  `http_profile_icon_test.go`): upload happy path, oversize → 413, non-image →
  400, 11th image → rejected, upload-order listing, download content-type +
  nosniff, access control (non-shared → 403/404, shared → 200), dedup,
  soft-delete hides image, restore within window → visible again, restore after
  sweep → 410, blob reclaimed only after finalization, cascade on note
  hard-delete.
- **Store unit tests** for refcount/cleanup logic and grace-window finalization.
- **Webapp** (Vitest + RTL): drag/drop, paste, banner vs grid rendering, lightbox,
  bin-icon remove → undo toast → restore, error states, NoteCard cover.
- **E2E** (Playwright, required for user-facing features per `CLAUDE.md`): upload
  one image → banner above body; upload several → grid; open lightbox; reload;
  remove via bin icon → undo toast → image returns.
- **i18n**: add keys to all locales, run `task check-translations`.
- Run `task test`, `task lint`, `task test-e2e`, `task gen-docs` before PR.

---

## 15. Open questions

1. **Storage**: confirm filesystem (content-addressed) over DB-BLOB for v1.
2. **Thumbnails**: generate eagerly at upload vs lazily on first request? (Lazy is
   simpler; eager gives predictable grid latency.)
3. **Animated GIFs**: keep animation (serve original in grid) or freeze to a
   static thumbnail tile? (Leaning: static thumbnail, animate in lightbox.)
4. **Undo grace window** length before the sweep finalizes a removal (e.g. 30s
   toast vs a few minutes server-side)? Client toast and server grace should be
   configured together.
5. **Quotas**: per-user / per-instance storage cap in v1, or defer? (Threat model
   prioritizes overload protection, so a cap may be worth MVP inclusion.)
6. **Export format**: zip bundle vs base64-inline — depends on current export.
7. **Image without a note**: require a `note_id` (create the note first) vs allow
   a draft upload bound on save? (Leaning: require `note_id`.)
