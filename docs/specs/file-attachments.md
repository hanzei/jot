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
- Hover a gallery tile → remove via a **trash/bin icon** (🗑). Removal is
  **client-deferred**: the tile hides immediately and an **undo toast** ("Image
  removed — Undo") shows for **~10s**. Undo cancels — nothing was ever sent to the
  server. Only when the toast expires does the client fire `DELETE` (§6), which is
  a plain hard-delete. This keeps all "undo" state on the client and the server
  logic simple (no soft-delete/restore). No markdown cleanup needed since images
  are not referenced from the body.
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
  Undo cancels, expiry fires the `DELETE` — same client-deferred flow as the
  webapp.
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
`created_at`), built alongside `Items`/`Labels`/`SharedWith` in the note store,
and a matching `NoteImage` interface in `shared/src/types.ts` (single source of
truth — do not redefine in webapp).

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

  ```text
  UPLOAD_DIR/
    blobs/  <sha[0:2]>/<sha[2:4]>/<sha>        # originals (source of truth)
    thumb/  <sha[0:2]>/<sha[2:4]>/<sha>.jpg    # derived tiles
  ```

  Directories are fanned out by hash prefix to stay shallow. Every path is
  derived solely from the validated hex hash, so user input never reaches the
  filesystem path (no traversal).
- **Thumbnails are a derived cache, not an entity — and a v1.1 optimization
  (§13), not MVP.** In MVP the grid renders originals downscaled by CSS (layout
  driven by the `width`/`height` metadata, so no reflow); thumbnails are added
  later purely to cut bandwidth. When they ship, a thumbnail is deterministic from
  `(original sha256, target size)`, so it is keyed by the *original's* sha and gets
  **no `note_images` row and no refcount of its own**. It is generated **eagerly
  during the upload request** with the avatar resize pipeline (output JPEG, so the
  thumbnail response is always `image/jpeg`) — the grid never waits on a
  first-request miss — and regenerated on demand if the file ever goes missing,
  since it is disposable. Grid tiles then use the thumbnail; the lightbox always
  uses the original. A future multi-size need extends the key to `<sha>_<w>.jpg`
  with no schema change.
- **Thumbnail lifecycle rides on the original.** When an original's refcount hits
  zero and it is GC'd (§10), delete its thumbnail at the matching prefixed path
  (`thumb/<sha[0:2]>/<sha[2:4]>/<sha>.jpg`) in the same step — no separate sweep.
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
| `POST` | `/api/images` | Upload an image (multipart `file`, `note_id`). 201 → `NoteImage`. Requires write access to `note_id` (owner or shared). |
| `GET` | `/api/images/{id}` | Stream the full-size image bytes. Requires access to the parent note. |
| `GET` | `/api/images/{id}/thumbnail` | Resized thumbnail for grid tiles. *(v1.1)* |
| `DELETE` | `/api/images/{id}` | Hard-delete the image row (client-deferred; fired after the undo toast expires). Reclaims the blob if unreferenced (§10). Requires note access. |

> Originally shipped as `POST /api/notes/{id}/images` (create nested under the
> note); moved to the fully top-level `POST /api/images` with `note_id` in the
> form body (issue #732) so image URLs — already note-independent for
> read/thumbnail/delete — are consistently addressed by image id alone across
> the whole lifecycle, matching the content-addressed, refcounted blob model.

**Authorization**: every route resolves the parent note and reuses the existing
"owner **or** shared-with" check (same predicate as note read/update). No new
permission concept — an image is exactly as accessible as its note. PAT-auth
works identically.

### 6.1 How clients fetch the note list

**Decided**: image metadata is **embedded in every `Note`** (list and single-note
`GET /notes/{id}` alike), just like the existing embedded `items` / `labels` /
`shared_with`. Because clients always receive the full image list with the note,
there is **no separate `GET /api/notes/{id}/images` endpoint** — it would be
redundant.

`GET /api/notes` (and its `?trashed` / `?archived` / `?search` / `?label` /
`?my_tasks` variants) is **unchanged in shape**: it still returns an array of
`Note` objects. Each note simply gains an `images` array. No new list endpoint,
no pagination change, no extra round-trip to discover a note's images.

- **Metadata only in the JSON.** Each embedded `NoteImage` is
  `{ id, filename, content_type, width, height, created_at }` (a few hundred
  bytes). Image *bytes* are never in the list payload.
- **Batch-loaded, no N+1.** Images for the whole result set are loaded in a
  single query (`WHERE note_id IN (...) ORDER BY note_id, created_at`), mirroring
  the existing `batchLoadSharesAndLabels` — one extra query per list request
  regardless of note count.
- **Bytes fetched out-of-band and cached.** Clients render tiles from
  `GET /api/images/{id}/thumbnail` and the lightbox from `GET /api/images/{id}`.
  Both are immutable (content-addressed, `ETag = sha256`, `Cache-Control`), so
  they are served from cache on subsequent list loads. The embedded
  `width`/`height` let clients reserve tile aspect ratios up front to avoid
  layout reflow while thumbnails load.
- **Stays live via SSE.** `note_image_added` / `note_image_removed` (§8) patch the
  already-loaded list without a refetch.

After an upload (`POST` → `NoteImage`) or a delete, clients patch the note's
embedded `images` array locally; SSE delivers the same change to other clients.

**Upload handler** (mirrors `UploadProfileIcon`):
1. `r.Body = http.MaxBytesReader(w, r.Body, limit+overhead)`; `ParseMultipartForm`.
2. Read `file`, enforce the **10-per-note** cap, compute SHA-256 while reading.
3. `http.DetectContentType` → must be in the **image allowlist** (§7); reject
   anything else (this is what enforces "images only").
4. **Decode the image** to confirm it's valid and capture width/height (reuse the
   avatar pipeline). *(v1.1)* also **generate the thumbnail eagerly** here and
   store it under the `thumb/` keyspace (§5).
5. `Blobstore.Put` (no-op if hash already present → dedup), insert the row.
6. Emit SSE event (§8), return `NoteImage`.

**Remove/undo**: undo is entirely client-side (§3.1). The client hides the tile,
runs a ~10s timer, and only fires `DELETE` on expiry; Undo cancels the timer so no
request is sent. `DELETE` therefore hard-deletes the row, emits
`note_image_removed`, and reclaims the blob if now unreferenced (§10) — no
`deleted_at`, no restore endpoint, no retention window on the server. Trade-off: if
the client dies during the ~10s window the `DELETE` never fires and the image
reappears on next load (fail-safe), and there is no post-toast recovery.

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
  `{ note_id, image_id }`. `note_image_removed` fires when the client's deferred
  `DELETE` lands (~10s after removal), so collaborators see the removal then.
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
**Export/import bundling is deferred to a "Later" phase (§13)** — the design below
is the intended shape, not MVP scope. Until it lands, export/import simply omits
images (notes still round-trip; images are re-added afterward):

- **Export** (`handlers/export.go`): produce a **zip bundle** — the notes JSON
  plus an `images/` folder of the original blobs (named by id/sha). Chosen over
  base64-inlining so large binaries don't bloat the JSON.
- **Import** (`handlers/import.go`): re-create images from the bundle, re-hashing
  and de-duping on the way in; if a blob is missing, import the note without it
  and warn.

---

## 10. Lifecycle & orphan cleanup

- Dedup means a blob may be referenced by multiple rows (same image on several
  notes). **Reference count = `COUNT(*) FROM note_images WHERE sha256=?`**.
- On row delete (client-deferred `DELETE` in §6, or a note hard-delete cascade):
  if no rows reference that `sha256`, `Blobstore.Delete` the blob (and its
  thumbnail). This is the primary reclamation path and runs synchronously with the
  delete.
- A lightweight periodic **sweep** (startup + daily) deletes on-disk blobs with
  zero referencing rows, as a safety net for crash-after-row-delete races. A row
  whose blob is missing is logged and surfaced as a broken tile.
- Removing an image just deletes its row — no markdown references to clean up.

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

## 12. Telemetry & admin stats

**OpenTelemetry**
- Wrap the image store with an `_otel.go` variant like existing stores
  (`note_store_otel.go`, etc.).
- Metrics: upload count/bytes, dedup hit rate, total blob bytes on disk, sweep
  reclaimed bytes. Trace spans on upload (read → validate → decode → put →
  insert) and download.

**Admin stats page** (`GET /api/admin/stats` → `models.AdminStats`, rendered on
`webapp/src/pages/Admin.tsx`)
- Extend the existing `AdminStorageStats` group (which already reports
  `database_size_bytes`) with **total image storage**:

  ```go
  type AdminStorageStats struct {
      DatabaseSizeBytes int64 `json:"database_size_bytes"`
      ImageCount        int64 `json:"image_count"`         // distinct stored blobs
      ImagesSizeBytes   int64 `json:"images_size_bytes"`   // total bytes on disk
  }
  ```
- **Computed dedup-aware from the DB**, so it reflects real disk footprint and
  needs no filesystem walk (works for both SQLite and Postgres):

  ```sql
  SELECT COUNT(*), COALESCE(SUM(size_bytes), 0)
  FROM (SELECT DISTINCT sha256, size_bytes FROM note_images);
  ```
  Counting `DISTINCT sha256` avoids double-counting deduped images. Thumbnails
  (small, derived) are excluded — noted as approximate; an exact total including
  thumbnails would require walking `UPLOAD_DIR`.
- Add the field to the `AdminStats` interface in `shared/src/types.ts` and render
  it in the Storage section of `Admin.tsx` (human-readable bytes, beside DB size),
  with a localized label added to all 8 locales (`task check-translations`).
- Covered by the admin-stats integration test and `Admin.test.tsx`.

---

## 13. Phasing

- **MVP**: `note_images` table + `fsBlobstore`, upload/get + hard-delete
  (client-deferred undo toast), size+type+count limits, image decode/validation, webapp
  picker + drag/drop + paste, gallery-above-body rendering (banner + grid
  rendering **originals** downscaled by CSS, laid out from `width`/`height`),
  lightbox, inline serving with `nosniff`, auth via note access, **SSE live
  updates** (`note_image_added` / `note_image_removed`), total-image-storage stat
  on the admin page.
- **v1.1**: **thumbnails** — eager generation at upload + `thumb/` keyspace +
  thumbnail endpoint + grid/NoteCard tiles switching to them (bandwidth
  optimization); NoteCard cover thumbnail.
- **v1.2**: **mobile** — camera/library/files pickers + offline upload queue.
- **Later**: export/import bundling, storage quotas, S3 backend.

---

## 14. Testing

- **Server integration** (new `server/http_note_images_test.go`, following
  `http_profile_icon_test.go`): upload happy path, oversize → 413, non-image →
  400, 11th image → rejected, upload-order listing, download content-type +
  nosniff, access control (non-shared → 403/404, shared → 200), dedup, delete
  removes the image, blob reclaimed only when unreferenced (deduped blob survives
  while another row uses it), cascade on note hard-delete.
- **Store unit tests** for refcount/cleanup logic (delete-time GC + orphan sweep).
- **Admin stats**: extend the admin-stats integration test + `Admin.test.tsx` to
  assert `images_size_bytes` / `image_count` (dedup-aware; deduped image counted
  once).
- **Webapp** (Vitest + RTL): drag/drop, paste, banner vs grid rendering, lightbox,
  bin-icon remove → undo toast, Undo cancels the pending `DELETE`, expiry fires it,
  error states, NoteCard cover.
- **E2E** (Playwright, required for user-facing features per `CLAUDE.md`): upload
  one image → banner above body; upload several → grid; open lightbox; reload;
  remove via bin icon → undo toast → Undo keeps the image; remove again → let it
  expire → image gone after reload.
- **i18n**: add keys to all locales, run `task check-translations`.
- Run `task test`, `task lint`, `task test-e2e`, `task gen-docs` before PR.

---

## 15. Resolved decisions

1. **Storage** — filesystem, content-addressed (§5). Not DB-BLOB.
2. **Animated GIFs** — static (first-frame) thumbnail tile; animate only in the
   lightbox (which serves the original). Applies once thumbnails ship (v1.1); MVP
   grids render originals, so GIFs animate inline there until then.
3. **Delete/undo** — **client-deferred**: the client hides the image, runs a ~10s
   undo toast, and only fires `DELETE` (a plain hard-delete) on expiry; Undo cancels
   it. No server-side soft-delete, restore endpoint, or retention window. Accepted
   trade-off: no post-toast recovery, and a client death mid-window leaves the image
   in place (fail-safe). Supersedes the earlier soft-delete + 7-day design.
4. **Quotas** — **deferred**; rely on the per-note count, per-file size, and
   upload rate limits for v1.
5. **Export format** — **zip bundle** (notes JSON + `images/` folder), not
   base64-inline (§9).
6. **Image without a note** — **require `note_id`**; create the note first, then
   upload. No draft/orphan uploads.
