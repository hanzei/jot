# Design: Native JSON Export & Import

**Status:** Proposal  
**Author:** Design Agent  
**Date:** 2026-03-20

---

## Summary

Add a native Jot JSON export and import flow for **owned notes only**. The export is a Jot-specific JSON backup format designed for round-trip restore, not a Google Keep compatibility format. Web gets the first user-facing export control in Settings. Mobile support is deferred.

---

## Motivation

Jot already supports importing Google Keep exports, but it does not offer users a first-class way to back up their own notebook or move it between Jot instances. For a self-hosted app, that is a major product gap.

The goal of this feature is to make Jot portable on its own terms:

- Users can download a structured backup of their notes.
- Users can restore that backup into Jot later.
- The format preserves Jot-specific note structure such as labels, colors, todo items, ordering, and archive state.

This is intentionally different from the existing Google Keep import path, which is a migration aid and does not represent the full Jot data model.

---

## Scope

**In scope (V1):**

- Export **owned notes only** as a native Jot JSON file.
- Import that same native Jot JSON file through the existing import flow.
- Preserve note content and note organization metadata needed for a practical round trip:
  - title
  - content
  - note type
  - color
  - pinned state
  - archived state
  - manual ordering position
  - completed-items-collapsed state
  - todo items with text, completed state, position, and indent level
  - label names
- Add a web Settings control to download the export file.
- Extend the existing web import messaging so users can import either Google Keep data or a Jot export JSON file.
- Keep Google Keep import working unchanged.

**Out of scope (V1):**

- Mobile export/import UI.
- Exporting notes merely shared *with* the current user.
- Exporting or importing note shares / collaborators.
- Exporting or importing todo assignments.
- Exporting or importing profile icons, sessions, or user settings.
- ZIP export.
- Markdown export.
- Background jobs or async export processing.

---

## Product Decisions

### 1. Format

Use a **Jot-native JSON envelope** rather than exporting raw `Note[]`.

**Why:**

- Avoids ambiguity with Google Keep JSON.
- Gives room for format versioning.
- Keeps the format stable even if API response shapes change later.
- Makes server-side import detection straightforward.

### 2. Ownership

Export **owned notes only**.

**Why:**

- Jot distinguishes between "I can access this note" and "I own this note."
- Owner-only actions already exist for trash, restore, and permanent deletion.
- Exporting shared-with-me content raises privacy and product questions that are not needed for V1.

### 3. Collaboration metadata

Do **not** round-trip shares or assignees in V1.

**Why:**

- Imported data should restore cleanly into any Jot instance, even if collaborator accounts do not exist there.
- Current assignment validation requires a note to be shared before assignees are valid.
- Keeping export/import owner-centric makes the first version simpler and more predictable.

### 4. Mobile

Defer mobile UI until the web format and backend contract are stable.

---

## Export Format

### Envelope

```json
{
  "format": "jot_export",
  "version": 1,
  "exported_at": "2026-03-20T21:00:00Z",
  "notes": [
    {
      "title": "Weekly plan",
      "content": "",
      "note_type": "todo",
      "color": "#fbbc04",
      "pinned": true,
      "archived": false,
      "position": 0,
      "unpinned_position": 3,
      "checked_items_collapsed": false,
      "labels": ["planning", "work"],
      "items": [
        {
          "text": "Write export spec",
          "completed": true,
          "position": 0,
          "indent_level": 0
        },
        {
          "text": "Review API shape",
          "completed": false,
          "position": 1,
          "indent_level": 1
        }
      ]
    }
  ]
}
```

### Proposed schema

```ts
interface JotExportV1 {
  format: 'jot_export';
  version: 1;
  exported_at: string;
  notes: ExportedNoteV1[];
}

interface ExportedNoteV1 {
  title: string;
  content: string;
  note_type: 'text' | 'todo';
  color: string;
  pinned: boolean;
  archived: boolean;
  position: number;
  unpinned_position?: number;
  checked_items_collapsed?: boolean;
  labels: string[];
  items?: ExportedNoteItemV1[];
}

interface ExportedNoteItemV1 {
  text: string;
  completed: boolean;
  position: number;
  indent_level: number;
}
```

### Notes on omitted fields

V1 intentionally omits:

- note IDs
- label IDs
- `shared_with`
- `is_shared`
- `assigned_to`
- `deleted_at`
- `created_at`
- `updated_at`

**Rationale:**

- IDs are instance-specific and should not be treated as durable restore keys.
- Shares and assignees depend on other users existing and being granted access.
- Excluding trashed notes and timestamps keeps the first format smaller and import logic simpler.

### Text notes vs todo notes

- `notes` must be present as a JSON array, not `null`.
- For `note_type: "text"`, exporters may omit `items`; import must treat an absent `items` field as equivalent to `items: []`.
- For `note_type: "todo"`, `items` may be omitted and normalized to `[]`, or provided with todo items.
- For `note_type: "text"`, `items` must be absent or equal to `[]`. A text note with non-empty `items` is invalid.
- For `note_type: "text"`, exporters should omit `checked_items_collapsed`. Import should accept it as missing and normalize it to `false`.
- For `note_type: "todo"`, exporters should include `checked_items_collapsed` when true and may omit it when false. Import should normalize absence to `false`.
- `unpinned_position` is optional. When absent, import falls back to `position`. When present on an unpinned note, import should preserve it rather than reject it, so a later pin/unpin cycle can restore the exported return position.

If later we want a "full-fidelity archive" mode, we can add additional optional fields in `version: 2`.

---

## API Design

### 1. Export endpoint

Add:

- `GET /api/v1/notes/export`

This endpoint is authenticated and returns a downloadable JSON file.

### Query params

**V1:** none required.

Optional future expansion:

- `include_trashed=true`
- `format=zip`

### Response

- `200 OK`
- `Content-Type: application/json`
- `Content-Disposition: attachment; filename="jot-export-YYYY-MM-DDTHH-mm-ssZ.json"`

The body is `JotExportV1`.

### Route placement

Register `/notes/export` **before** `/notes/{id}` in `server/internal/server/server.go`, just as `/notes/trash`, `/notes/reorder`, and `/notes/import` are registered before the ID route.

---

## Import Design

### 1. Reuse the existing endpoint

Keep using:

- `POST /api/v1/notes/import`

But broaden it from "Google Keep import" to "supported note import formats."

### 2. Detection strategy

On upload:

- If the payload is ZIP, keep the existing Google Keep ZIP behavior.
- If the payload is JSON:
  - Decode the raw JSON into a lightweight generic envelope first.
  - If it is an object with `format: "jot_export"` and `version: 1`, treat it as native Jot import.
  - Otherwise, fall back to the existing Google Keep JSON parsing behavior.

This detection must happen **before** trying to unmarshal JSON into the existing Google Keep note shape. Otherwise a valid Jot export envelope with `notes: []` or without Keep-style top-level fields could be rejected as an invalid Keep note before native import is even attempted.

### 3. Import behavior for Jot JSON

For each exported note:

1. Create the note with the exported title/content/type/color.
2. Apply pinned and archived state after create if needed, but do **not** rely on the normal pin-transition side effects in `NoteStore.Update` as the final source of truth for imported ordering metadata.
3. Restore `checked_items_collapsed`, normalizing a missing value to `false`.
4. Recreate todo items with exported text/completed/position/indent level.
5. Recreate labels by name using the current label-add flow, deduplicating by name per user.
6. Restore exported ordering metadata after all notes are created.

### 4. Ordering restoration

Current `NoteStore.Create` always inserts a new active unpinned note at position `0`, so repeated create calls will not naturally preserve exported ordering.

To make round-trip ordering deterministic, native import should:

1. create all notes first and keep a mapping of export-order index to newly created note IDs;
2. apply pinned / archived / collapsed state updates;
3. run a final reorder pass for active pinned notes using exported pinned notes sorted by exported `position`;
4. run a final reorder pass for active unpinned notes using exported unpinned notes sorted by exported `position`;
5. run archived reorder passes too, splitting archived notes into pinned and unpinned buckets if the export contains both, so archived ordering round-trips consistently with the same `pinned DESC, position ASC` rule used elsewhere;
6. persist `unpinned_position` when present so pinned notes return to the expected location after unpinning.

By default, native Jot import should run inside a **single database transaction** so the import is all-or-nothing.

- Any validation failure or creation failure must roll back the full import.
- Ordering restoration steps are part of that same transaction and also trigger rollback on failure.
- This is different from the current Google Keep import path, which is best-effort and returns per-note failures in `ImportResponse.errors`.

Because the existing `ReorderNotes` store method only updates `position`, and the normal `Update` path recomputes `position` / `unpinned_position` when pin state changes, native import must add an **import-specific store helper** that updates `position` and `unpinned_position` together inside the import transaction.

Do not assume `ReorderNotes` alone is enough to restore `unpinned_position`, and do not assume a normal pin/unpin update call will preserve imported ordering metadata.

### 5. Optional best-effort mode

If we later add an explicit opt-in flag such as `allow_partial_import=true`, native import may support a best-effort mode:

- valid notes are created and committed;
- per-note validation or creation failures are collected into `ImportResponse.errors`;
- ordering restoration failures for affected notes are logged and skipped rather than rolling back already created notes.

V1 should **not** enable this mode by default.

### 6. Import semantics

- Imported notes become **owned by the importing user**.
- Imported notes are **not shared**, even if the source note was shared.
- Imported todo items are **unassigned**.
- Existing notes are **not overwritten**; import creates new notes.
- Native Jot import and Google Keep import share the same success response shape for successful 2xx requests:

```ts
interface ImportResponse {
  imported: number;
  skipped: number;
  errors?: string[];
}
```

Rules for `ImportResponse.errors`:

- `errors` is only present for successful requests that completed with partial failures.
- `errors` remains a `string[]` in V1 to match the current API contract.
- Each entry represents one failed note and should contain both:
  - a stable machine-readable failure code prefix
  - a short user-facing message
- Recommended format: `"<code>: <message>"`, for example `invalid_note_type: note #3 uses unsupported note_type "drawing"`.
- `errors` must never include stack traces or internal debug details; those belong in server logs.

For native Jot import in default all-or-nothing mode, `errors` should usually be absent because any validation or creation failure returns a non-2xx response and rolls back the whole import.

#### Validation failures

Today, most server validation failures are returned as plain-text `400` responses via `wrapHandler` / `http.Error`. Native Jot import can either:

- keep that existing plain-text error contract for consistency, or
- intentionally introduce a structured JSON validation payload for this endpoint.

If we choose the structured path, treat it as a **new** contract for `/notes/import`, update Swagger/client expectations accordingly, and return a payload such as:

```json
{
  "code": "invalid_jot_export",
  "message": "notes must be a JSON array"
}
```

If we keep the existing server-wide pattern, the equivalent response would instead be a plain-text `400` body such as:

```text
notes must be a JSON array
```

Example successful partial-import response shape:

```json
{
  "imported": 2,
  "skipped": 0,
  "errors": [
    "invalid_note_type: note #3 uses unsupported note_type \"drawing\""
  ]
}
```

---

## Backend Design

### 1. Handler additions

Add an export handler on `NotesHandler`, for example:

```go
func (h *NotesHandler) ExportNotes(w http.ResponseWriter, r *http.Request) (int, any, error)
```

Unlike most handlers, this one should write headers, call `w.WriteHeader(http.StatusOK)`, and stream the attachment body directly. After that, it should return `0, nil, nil` so `wrapHandler` does not try to JSON-encode another response body.

The handler must not return `http.StatusOK, nil, nil` after writing the response body itself, or `wrapHandler` will attempt to write a second empty status response. Returning `0, nil, nil` is only correct after the handler has already completed the full response write itself.

### 2. Export data loading

Load the current user's **owned active + archived notes** via an owner-filtered note-store path.

V1 should exclude trashed notes entirely.

Because the export format is owner-centric and share-free, store code can serialize a dedicated export DTO instead of exposing raw `models.Note`.

When populating export DTOs:

- `position` preserves the current manual ordering.
- `unpinned_position`, when available, preserves where a note should return after unpinning.
- notes shared with other users are exported as plain owned notes without share metadata.

Do **not** reuse the normal list-notes query without modification. The current `GetByUserID` path is based on `note_user_state.user_id`, which also includes notes shared with the current user. Export must explicitly filter on `notes.user_id = requesting user`.

### 3. Native import parser

Add native import structs in Go, e.g.:

```go
type JotExport struct {
    Format     string             `json:"format"`
    Version    int                `json:"version"`
    ExportedAt time.Time          `json:"exported_at"`
    Notes      []JotExportNote    `json:"notes"`
}
```

Validation rules:

- `format` must equal `"jot_export"`
- `version` must equal `1`
- `exported_at` should be RFC3339
- `notes` must be present and must be a JSON array, not `null`
- note and item validation should mirror the canonical **create/import** server rules in `server/internal/handlers/notes.go`, especially `normalizeCreateNoteRequest`, `createTodoItems`, and `validateColor`
- do not treat `validateTodoItems` as the primary import reference; it is update-oriented and includes assignment/share validation that V1 native import intentionally skips because assignments are out of scope
- title length must be at most 200 Unicode code points (runes)
- content length must be at most 10000 Unicode code points (runes)
- item text length must be at most 500 Unicode code points (runes)
- a note can have at most the current server `noteItemsMaxCount`
- `position` must be a non-negative integer
- `indent_level` must be an integer in the currently enforced server range of `0..1`
- color must pass the current server color validation (`validateColor`) and match the Jot note color format
- text notes must have `items` absent or equal to `[]`
- label names should be trimmed, empty labels skipped, and duplicate names deduplicated by exact name, matching the current label-creation flow

### 4. Shared types

Add native export/import DTOs to `shared/src/types.ts` so the format is explicit and reusable across:

- web tests
- future mobile implementation
- possible Go client updates

---

## Web UX

### Settings placement

Add export next to the existing import section in Settings.

Recommended UI:

- Keep the current Import section, but update copy to mention Google Keep **and** Jot JSON.
- Add a new sibling card:
  - title: "Export"
  - description: "Download your notes as a Jot JSON backup."
  - action: "Export notes"

### Interaction

Clicking **Export notes** immediately downloads the JSON file.

No modal is required in V1.

### Import copy updates

Update current import text so users understand accepted formats:

- Google Keep JSON / ZIP
- Jot export JSON

The existing `ImportModal` already accepts `.json` and `.zip`, so the main change is messaging plus backend format detection.

---

## Mobile UX

Deferred.

When mobile work begins later, the existing Settings screen is the right place to surface export/import. The API format should already be stable by then.

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| User owns zero notes | Export succeeds with `"notes": []` |
| User has archived notes | Included in export and restored as archived |
| User has trashed notes | Excluded in V1 |
| User owns notes that were shared with others | Exported as plain owned notes without share metadata |
| User imports the same export twice | Creates duplicates; no deduplication in V1 |
| Export contains labels that already exist on importing account | Reuse existing labels by name |
| Export contains invalid shape or unsupported version | `400 Bad Request` |
| Export contains todo items with invalid indent level | Rejected using normal validation rules |
| Native Jot JSON is uploaded to `/notes/import` | Parsed as Jot import via `format/version` detection |
| Google Keep JSON is uploaded to `/notes/import` | Existing behavior remains unchanged |

---

## Security and Load Considerations

- Keep the existing multipart body cap on `/notes/import`.
- Native JSON import should use the same bounded-read approach as Keep import.
- Export should only include owned notes for the authenticated user.
- Export should not include profile icons or other binary user assets.
- Export generation is synchronous in V1; if note counts grow large later, we can revisit streaming ZIP or background job generation.

---

## Testing Plan

### Server tests

Add focused tests parallel to the existing import tests:

- export returns `200` for authenticated user
- export returns `401` when unauthenticated
- export contains only notes owned by the requester
- export excludes trashed notes in V1
- export JSON matches expected envelope shape
- `NotesHandler.ExportNotes` writes headers, calls `w.WriteHeader(http.StatusOK)`, streams the attachment body itself, and returns `0, nil, nil`
- `NotesHandler.ExportNotes` response contains no duplicate/conflicting headers and no spurious JSON body from `wrapHandler`
- `NotesHandler.ExportNotes` final observed status code is the one written by the handler (`200 OK`)
- native import accepts valid Jot export JSON
- native import rejects invalid version / invalid format marker
- native import default mode is all-or-nothing and rolls back fully on validation or ordering failure
- optional best-effort mode, when enabled later, reports per-note failures through `ImportResponse.errors`
- round trip test: create notes -> export -> import into a fresh user -> verify note content, labels, color, order, archived state, todo items, `checked_items_collapsed` on todo notes, `unpinned_position` for pinned notes, and todo item `indent_level`
- duplicate import test: importing the same payload twice creates distinct notes with no deduplication
- Google Keep import tests continue passing unchanged

### Web tests

Add targeted tests for:

- export button renders in Settings
- clicking export triggers a download request
- import modal copy mentions Jot JSON support

### E2E

Add a high-signal web e2e flow:

1. Create representative notes.
2. Export JSON.
3. Log into a different fresh account or reset state.
4. Import that JSON.
5. Verify the notes reappear with expected structure.

---

## Rollout Sequence

1. Add shared export DTOs.
2. Add `GET /notes/export`.
3. Extend `/notes/import` to detect and import native Jot JSON.
4. Update Swagger annotations / generated docs for any new or changed import/export API behavior.
5. Add server tests for export and round-trip native import.
6. Add web export button and import copy updates.
7. Add web tests / e2e.

---

## Future Extensions

- `include_trashed=true`
- ZIP export
- Markdown export
- Timestamp preservation
- Share / collaborator restoration
- Assignment restoration
- Mobile UI
- Admin-triggered user data export
