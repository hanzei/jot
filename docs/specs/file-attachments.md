# Feature Spec: File Attachments / Uploads

Status: **Draft / proposal** — for discussion before implementation.
Owner: TBD · Target: Jot (self-hosted note app)

---

## 1. Summary

Let users attach files (images, PDFs, arbitrary documents) to notes. Images can
be embedded inline in a note's markdown body; all files appear as an attachment
list on the note and travel with it through sharing, export, and trash.

This builds directly on the binary-handling pattern Jot already ships for
**profile icons** (`UploadProfileIcon` / `GetUserProfileIcon` in
`server/internal/handlers/auth.go`): `MaxBytesReader` + multipart parse +
`http.DetectContentType` + content-type allowlist + `X-Content-Type-Options:
nosniff` on serve. The main new decisions are **where the bytes live** (the
profile-icon BLOB-in-DB approach does not scale to many large files) and **how
attachments bind to notes, sharing, and the markdown body**.

---

## 2. Goals / Non-goals

**Goals (v1)**
- Attach one or more files to a note (owner or a user the note is shared with).
- Inline image embedding into the markdown body (drag/drop, paste, file picker).
- Non-image files shown as a downloadable attachment list with name/size/type.
- Attachments inherit the note's access rules (owner **or** shared user).
- Attachments survive sharing, trash/restore, export, and import where feasible.
- Sensible limits + validation; protect against accidental internal overload
  (per the project threat model), not malicious insiders.
- Works on both supported DB backends (SQLite default, Postgres).

**Non-goals (v1)**
- Image editing/cropping (beyond the existing avatar resize), OCR, virus
  scanning, full‑text indexing of file contents.
- External object stores (S3/GCS). Designed so a backend can be added later.
- Per-attachment ACLs distinct from the note's sharing.
- Versioning of attachments.

---

## 3. UX

### 3.1 Webapp (primary surface — `NoteModal.tsx`)

Notes are markdown today (`marked` renders content; `NoteCard` shows a markdown
preview). Attachments slot into the existing editor:

**Adding files**
- **Drag & drop** anywhere onto the open note modal → upload starts immediately,
  a progress chip appears.
- **Paste** (`Ctrl/Cmd+V`) an image from clipboard → uploads and, for images,
  inserts a markdown image reference at the cursor.
- **Toolbar button** (📎 paperclip) → native file picker (multi-select).

**Display**
- An **Attachments** strip at the bottom of the note modal: image thumbnails +
  file-type chips (icon, filename, size). Click an image → lightbox; click a
  file → download.
- Inline images: when a user inserts an image, the markdown body gets
  `![alt](/api/attachments/{id})` and the markdown renderer resolves it. Image
  URLs are same-origin and credentialed.
- **NoteCard** preview: if a note has an image attachment, show one thumbnail
  badge (count "+N") so attachments are visible in the grid.

**Managing**
- Hover an attachment → remove (✕). Removing an inline-embedded image also
  offers to strip the markdown reference.
- Upload states: queued → uploading (progress %) → done / error (retry).

**Errors (inline, non-blocking toast + chip state)**
- Too large: "File exceeds the 25 MB limit."
- Unsupported type: "This file type isn't allowed."
- Too many: "Notes can have up to 20 attachments."

**Accessibility**: paperclip button has a label; thumbnails have `alt` derived
from filename; lightbox is keyboard-dismissable (matches `@headlessui` usage).

### 3.2 Mobile (`mobile/`)

- "Attach" action in the note screen → choose **Camera**, **Photo Library**, or
  **Files** (Expo pickers).
- Thumbnails in a horizontal scroller; tap to view/download.
- Uploads queue through the existing React Query mutation layer; offline =
  queued and flushed by the sync hook when back online (consistent with the
  app's offline-first design). Pending attachments render with a spinner.
- Local cache of downloaded attachments via Expo FileSystem to avoid re-fetch.

### 3.3 Empty/limit states
- A note with no attachments shows nothing extra (no empty strip).
- Storage/limit copy is localized — add keys to all 8 locales and run
  `task check-translations`.

---

## 4. Data model

New `attachments` table. Bytes are stored on disk (see §5); the row holds
metadata + a content hash. Mirror migrations in **both**
`server/internal/database/migrations/sqlite/` and `.../postgres/` as the next
sequential number (`000004_add_attachments.up.sql` / `.down.sql`).

```sql
-- sqlite
CREATE TABLE attachments (
    id            TEXT PRIMARY KEY,              -- 22-char crypto id (models.NewID)
    note_id       TEXT NOT NULL,
    uploader_id   TEXT NOT NULL,                 -- who uploaded (owner or shared user)
    filename      TEXT NOT NULL,                 -- original, sanitized for display
    content_type  TEXT NOT NULL,                 -- validated server-side
    size_bytes    INTEGER NOT NULL,
    sha256        TEXT NOT NULL,                 -- content hash (storage key + dedup)
    width         INTEGER,                       -- nullable, images only
    height        INTEGER,                       -- nullable, images only
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (note_id)     REFERENCES notes (id) ON DELETE CASCADE,
    FOREIGN KEY (uploader_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX idx_attachments_note_id ON attachments(note_id);
CREATE INDEX idx_attachments_sha256  ON attachments(sha256);
```

(Postgres variant: `TIMESTAMPTZ`, `BIGINT` for sizes, `INTEGER` for dims.)

`ON DELETE CASCADE` from `notes` means permanently deleting a note (post-trash)
drops its attachment rows automatically; on-disk blobs are reclaimed by the
orphan sweep in §10.

A `Note` response gains an `attachments []Attachment` field (omitempty), built
alongside `Items`/`Labels`/`SharedWith` in the note store, and a matching
`Attachment` interface in `shared/src/types.ts` (single source of truth — do not
redefine in webapp).

---

## 5. Storage backend

**Decision: store bytes on the filesystem, content-addressed by SHA-256, with a
small pluggable interface. Do not extend the profile-icon BLOB-in-DB approach to
attachments.**

Rationale:
- Profile icons are one small (resized) image per user — fine as a BLOB.
  Attachments are many, potentially up to tens of MB, and would bloat the SQLite
  file / Postgres rows, hurt backups, and stream poorly.
- Content addressing gives free dedup (same file attached twice = one blob) and
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
  the mounted `/data` volume). Layout: `UPLOAD_DIR/<sha[0:2]>/<sha[2:4]>/<sha>`
  to keep directories shallow. The path is derived solely from the validated hex
  hash, so user input never reaches the filesystem path (no traversal).
- The interface leaves room for an S3 backend later without touching handlers.

**Backup note for operators**: with this design a full backup is now *DB + the
upload dir* (previously DB-only). This is a documentation change — call it out in
README and the PR description per the project's compatibility rules.

> Alternative considered — keep everything in the DB as a BLOB for "one-file
> backup" parity with profile icons. Rejected for v1 on size/scaling grounds, but
> the `Blobstore` interface could trivially get a `dbBlobstore` if single-artifact
> backup is later judged more important than scale.

---

## 6. API

All routes sit behind the existing auth middleware (session cookie or PAT) and
follow the `(int, any, error)` handler signature wrapped by `wrapHandler`.
`wrapHandler` already promotes `*http.MaxBytesError` to **413**, so the size cap
needs no special handling. Regenerate Swagger with `task gen-docs` after adding
annotations.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/notes/{noteId}/attachments` | Upload a file to a note (multipart `file`). 201 → `Attachment`. Requires note write access (owner or shared). |
| `GET` | `/api/notes/{noteId}/attachments` | List a note's attachments (metadata). |
| `GET` | `/api/attachments/{id}` | Download/stream the bytes. Requires access to the parent note. |
| `GET` | `/api/attachments/{id}/thumbnail` | Resized image thumbnail (images only; 404 for non-images). |
| `DELETE` | `/api/attachments/{id}` | Detach + delete. Requires note access. |

**Authorization**: every attachment route resolves the parent note and reuses
the existing "owner **or** shared-with" check (same predicate used by note
read/update). No new permission concept — an attachment is exactly as accessible
as its note. PAT-authenticated requests work identically.

**Upload handler** (mirrors `UploadProfileIcon`):
1. `r.Body = http.MaxBytesReader(w, r.Body, limit+overhead)`; `ParseMultipartForm`.
2. Read `file`, enforce per-note count cap, compute SHA-256 while reading.
3. `http.DetectContentType` → check against allowlist (§7). Reject mismatch with
   the declared type.
4. For images, decode to capture width/height (reuse the avatar image pipeline;
   optionally generate a thumbnail eagerly or lazily on first request).
5. `Blobstore.Put` (no-op if hash already present → dedup), insert metadata row.
6. Emit SSE event (§8), return `Attachment`.

**Download handler** (mirrors `GetUserProfileIcon`):
- Set `Content-Type` from the stored type, **`X-Content-Type-Options: nosniff`**,
  and `Content-Disposition`:
  - `inline` for image types (so inline markdown embeds render),
  - `attachment; filename="..."` for everything else (force download, never
    execute in the browser context — important since arbitrary types are
    allowed).
- Use `http.ServeContent` with the blob's `ReadSeeker` + `created_at` for range
  requests, `ETag` (= sha256), and caching. Content is immutable per hash, so
  `Cache-Control: private, max-age=...` is safe.

---

## 7. Limits, validation & security

Add to `shared/src/constants.ts` (and a server-side mirror in
`internal/handlers/validation.go`) so client and server agree:

- `ATTACHMENT_MAX_BYTES` — default **25 MB** per file. Configurable via env
  `ATTACHMENT_MAX_BYTES` using the existing `parseIntRangeEnv` helper.
- `ATTACHMENT_MAX_PER_NOTE` — default **20**.
- `ATTACHMENT_ALLOWED_TYPES` — allowlist. Suggested v1: images
  (`image/png`, `image/jpeg`, `image/webp`, `image/gif`), `application/pdf`,
  plain text/markdown/csv, common office docs. Configurable for operators who
  want to broaden/narrow it.

Security posture (consistent with the project threat model — guard against
accidental internal overload, baseline authz mandatory):
- **Content sniffing**: validate with `http.DetectContentType`, store the
  detected type, serve with `nosniff`.
- **Never inline-render untrusted HTML/SVG**: exclude `image/svg+xml` and
  `text/html` from the allowlist by default (SVG can carry script). If SVG is
  later wanted, serve it `Content-Disposition: attachment` only.
- **Path safety**: storage key is the hex hash; original filename is stored for
  display only and is never used as a filesystem path.
- **Authz**: parent-note access check on every read/write/delete; no
  enumeration (IDs are 22-char crypto-random, and access is still checked).
- **Rate limiting / overload protection**: cap concurrent uploads and apply a
  per-user upload rate limit (align with existing middleware), plus the size and
  per-note caps above. This is the priority defense per `CLAUDE.md`.
- A per-user/global storage quota is a candidate follow-up (see §15).

---

## 8. Realtime (SSE)

Add an `EventType` in `internal/sse/hub.go` (the hub already has
`note_updated`, `profile_icon_updated`, etc.):
- `attachment_added` / `attachment_removed`, payload `{ note_id, attachment }` /
  `{ note_id, attachment_id }`.
- Fan-out audience = the note's owner + shared users (same audience logic used
  for `note_updated`). Webapp/mobile update the note's attachment list live, so a
  collaborator sees a new image appear without reload.

Simpler alternative: piggyback on `note_updated` and let clients refetch
attachments. Dedicated events are cheaper and match existing granularity.

---

## 9. Sharing, trash, export/import

- **Sharing**: nothing extra to store — attachments are reachable by anyone with
  note access. A shared user can add/remove attachments (write access), matching
  how shared notes already allow content edits.
- **Trash/restore**: attachments stay attached through soft-delete (note
  `deleted_at`). They become eligible for blob cleanup only after the note is
  *permanently* deleted (cascade removes rows; §10 reclaims bytes).
- **Export** (`handlers/export.go`): include attachment metadata in the note
  export and bundle blobs (e.g. a zip with a `attachments/` folder, or
  base64-inline for the JSON export — decide based on current export format).
- **Import** (`handlers/import.go`): re-create attachments from the bundle,
  re-hashing and de-duping on the way in. If a referenced blob is missing, import
  the note without it and warn.

---

## 10. Lifecycle & orphan cleanup

- Dedup means a blob may be referenced by multiple attachment rows (same file on
  several notes). **Reference count = `COUNT(*) FROM attachments WHERE sha256=?`**.
- On attachment delete or note hard-delete: remove the row; if no rows reference
  that `sha256`, `Blobstore.Delete` the blob.
- A periodic **sweep** (startup + daily) deletes on-disk blobs with zero
  referencing rows, covering crash-after-row-delete races. Conversely, a row
  whose blob is missing is logged and surfaced as a broken attachment.
- Deleting the sole inline image leaves a dangling markdown ref; the webapp
  offers to strip it (§3), but a broken `![]()` is otherwise harmless.

---

## 11. Migrations & backward compatibility

- Additive only: new table + new `UPLOAD_DIR`. Existing installs migrate cleanly
  with no data changes; `attachments` starts empty.
- New env `UPLOAD_DIR` (default `./uploads`); document in README + Docker (ensure
  it resolves under the `/data` volume so it persists and is backed up).
- API change is additive (`Note.attachments`), but per `CLAUDE.md` the
  **backup-surface change (DB → DB + upload dir)** must be called out explicitly
  in the PR description with operator upgrade guidance.

---

## 12. Telemetry

- Wrap the attachment store with an `_otel.go` variant like the existing stores
  (`note_store_otel.go`, etc.).
- Metrics: upload count/bytes, dedup hit rate, total blob bytes on disk, sweep
  reclaimed bytes. Trace spans on upload (read → validate → put → insert) and
  download.

---

## 13. Phasing

- **MVP**: table + `fsBlobstore`, upload/list/download/delete, size+type+count
  limits, webapp paperclip + drag/drop + inline image paste, download serving
  with `nosniff`/`Content-Disposition`, auth via note access. SSE + thumbnails
  can be fast-follow.
- **v1.1**: thumbnails, SSE live updates, NoteCard thumbnail badge, mobile
  camera/library/files + offline queue.
- **Later**: export/import bundling, storage quotas, S3 backend, drag-to-reorder.

---

## 14. Testing

- **Server integration** (new `server/http_attachments_test.go`, following the
  `http_profile_icon_test.go` style): upload happy path, oversize → 413,
  disallowed type → 400, count cap, download content-type/disposition/nosniff,
  access control (non-shared user → 403/404, shared user → 200), dedup, delete +
  blob reclamation, cascade on note hard-delete.
- **Store unit tests** for refcount/cleanup logic.
- **Webapp** (Vitest + RTL): drag/drop, paste-to-inline, error states, list
  rendering.
- **E2E** (Playwright, required for user-facing features per `CLAUDE.md`): upload
  an image to a note, see it inline + in the strip, reload, download, delete.
- **i18n**: add keys to all locales, run `task check-translations`.
- Run `task test`, `task lint`, `task test-e2e`, `task gen-docs` before PR.

---

## 15. Open questions

1. **Storage**: confirm filesystem (content-addressed) over DB-BLOB for v1.
2. **Type allowlist**: strict images+PDF only, or broad with `nosniff`+forced
   download? (Leaning broad-but-downloaded.)
3. **Quotas**: per-user / per-instance storage cap in v1, or defer? (Threat model
   prioritizes overload protection, so a cap may be worth MVP inclusion.)
4. **Export format**: zip bundle vs base64-inline — depends on current export.
5. **Attachment without a note**: always require a `note_id`, or allow a
   "draft/orphan" upload that gets bound on note save? (Simpler: require note_id;
   create the note first.)
6. **Inline embed URL**: route-based (`/api/attachments/{id}`) vs a stable
   per-note path — route-based is simplest and chosen above.
