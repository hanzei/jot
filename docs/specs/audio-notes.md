# Audio notes

Status: **Proposal** — nothing here is implemented yet. Target: server, webapp,
mobile, `@jot/shared`.

An audio note is a third note type next to text and list notes. The user
records a voice memo, Jot transcribes it, and the note shows both: a player for
the recording and the transcript as read-only text.

---

## 1. User flow

1. The user creates a new **audio note**. It starts empty: no recording, no
   transcript. Title, color, labels, pin and sharing work as on other notes.
2. They press **Record**. While recording they see the elapsed time and a level
   meter, and can **Pause** and **Resume** as often as they like. Pausing does
   not end the recording; everything until Stop becomes one file.
3. They press **Stop**. The recording is uploaded and is then fixed: there is no
   re-recording, appending or trimming in v1. **Discard** before Stop throws the
   recording away and leaves the note empty.
4. The note shows a player straight away and "Transcribing…" until the
   transcript arrives, then the transcript as read-only, selectable text with a
   **Copy** button.
5. If transcription fails, the note shows the reason and a **Retry** button. If
   the server has no transcription service configured, the note is just a
   recording with a player.

An audio note that is closed without a recording is discarded, like an empty
text-note draft.

---

## 2. Architecture

```text
 webapp / mobile                Jot server                      transcription service
 ───────────────                ──────────                      ─────────────────────
 record (pause/resume)
 stop → POST /notes/{id}/audio ─▶ store blob, note_audio row
                                  status = pending ─┐
                                                    │ worker
                                                    ├──────────▶ POST /v1/audio/transcriptions
                                                    │◀────────── {"text": "..."}
                                  notes.content = transcript
 ◀─────────── SSE note_updated ── status = done ────┘
 GET /api/v1/audio/{id} (Range) ◀─ blob
```

Transcription runs in a **separate container** next to Jot, not inside the Jot
binary and not on the client:

- **Inside the binary** would mean cgo (whisper.cpp or sherpa-onnx). The server
  is built with `CGO_ENABLED=0` (pure-Go SQLite) so GoReleaser can cross-compile
  arm64 without a C toolchain; that would end. Model files (75 MB–1.5 GB) would
  also have to ship or be downloaded, and transcription would compete with the
  API for CPU.
- **On the client** would mean a different engine per platform: an in-browser
  Whisper model (hundreds of MB per browser), Apple's and Android's on-device
  recognizers on mobile. The web's built-in `SpeechRecognition` sends audio to
  Google in Chrome by default and does not exist in Firefox. Collaborators on a
  shared note would see whatever the recorder's device happened to produce.
- **A separate service** gives one engine for every client, keeps the Jot build
  unchanged, and can run on another machine with a GPU.

Jot talks to it with one HTTP request in the shape of OpenAI's
`POST /v1/audio/transcriptions`, which several local servers implement. Any of
them can be used:

| Service | Notes |
|---|---|
| **whisper.cpp `whisper-server`** (reference setup) | C++, CPU-friendly, quantized models. Official image `ghcr.io/ggml-org/whisper.cpp:main` for amd64 and arm64, with ffmpeg included. Needs `--convert` so it accepts WebM/MP4 (it only reads WAV otherwise) and `--inference-path /v1/audio/transcriptions`. Models are downloaded once into a mounted volume. |
| **Speaches** | Python, faster-whisper. OpenAI-compatible; CPU and CUDA compose files; loads models on demand by name. Larger image. |
| **Parakeet servers** (sherpa-onnx / ONNX) | Reportedly much faster than Whisper on CPU, but only 25 European languages. |

The same setting can point at a hosted API. That is the operator's choice; Jot
neither defaults to nor documents a cloud provider.

---

## 3. Data model

### 3.1 Note type

`note_type = 'audio'` joins `text` and `list`. Neither backend constrains the
column; `models.NoteType.Valid()` is the gate and gains the new value.

| Field | Text note | List note | Audio note |
|---|---|---|---|
| `title` | — | user | user |
| `content` | user (Markdown) | — | **transcript**, server-written, read-only |
| `items` | — | user | — |
| `audio` | — | — | `NoteAudio` or `null` before upload |

The transcript lives in `notes.content` on purpose: the `note_search` FTS
triggers already index `title || content`, so audio notes become searchable by
what was said with no search change, and export, MCP reads and card previews
pick it up the same way.

`notes.content` is capped at 10,000 characters (`NoteContentMaxLength`), but
that is an input rule for user edits. The transcript is written by the server,
so it gets its own bound, `NoteTranscriptMaxLength` (100,000 characters,
truncated with an ellipsis). Paths that accept content from outside — the
import endpoint in particular — apply the transcript bound to audio notes and
the content bound to text notes.

### 3.2 `note_audio` table

One row per audio note, in both `migrations/sqlite/` and
`migrations/postgres/`:

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | Minted per upload; the playback URL is `/audio/{id}`. |
| `note_id` | text, **unique**, FK → notes, cascade | Enforces one recording per note. |
| `uploaded_by` | text FK → users | Who recorded it (may be a collaborator). |
| `sha256` | text | Content address in the audio store. |
| `content_type` | text | Normalized container type, see §4.2. |
| `size_bytes` | integer | |
| `duration_ms` | integer | Client-reported at upload; replaced by the service's value if it returns one. |
| `transcript_status` | text | `none`, `pending`, `processing`, `done`, `failed`. |
| `transcript_error` | text, nullable | Short message safe to show the user. |
| `transcript_language` | text, nullable | Detected language, if the service reports it. |
| `transcript_attempts` | integer | Automatic attempts so far. |
| `transcript_next_attempt_at` | timestamp, nullable | Backoff for transient failures. |
| `transcript_claimed_at` | timestamp, nullable | Worker lease, see §5.3. |
| `created_at`, `updated_at` | timestamp | |

Timestamps follow the server rules: generated in Go and bound as
`models.Timestamp(models.Now())`, and the table gets an entry in
`timestampColumnsByTable`. An index on `(transcript_status,
transcript_next_attempt_at)` serves the worker's poll.

A separate table instead of columns on `notes` keeps the notes row generic,
mirrors `note_images`, and gives the blob reclaim its refcount query.

### 3.3 Shared types

```ts
export type NoteType = 'text' | 'list' | 'audio';

export type TranscriptStatus = 'none' | 'pending' | 'processing' | 'done' | 'failed';

export interface NoteAudio {
  id: string;
  content_type: string;
  size_bytes: number;
  duration_ms: number;
  transcript_status: TranscriptStatus;
  transcript_error: string | null;
  transcript_language: string | null;
  created_at: string;
}

export interface AudioNote extends BaseNote {
  note_type: 'audio';
  title: string;
  /** The transcript. Empty until transcript_status is 'done'. */
  content: string;
  audio: NoteAudio | null;
}

export type Note = TextNote | ListNote | AudioNote;
```

About 44 non-test files across the four workspaces branch on the note type
today. Each needs an explicit audio case; TypeScript's exhaustiveness checks
will find most of them once the union grows.

---

## 4. Storage and playback

### 4.1 Audio store

Audio blobs get their own content-addressed store, `blobstore.AudioStore`, built
on the same private `blobStore` primitive as `ImageStore`, rooted at
`<JOT_UPLOAD_DIR>/audio/`. It must not share `blobs/`: the image orphan sweep
deletes every blob there that no `note_images` row references, so it would
delete audio.

- Hard-delete paths (single note purge, trash emptying, user deletion) reclaim
  through an audio counterpart of `ReclaimIfOrphaned`, never by deleting the
  blob directly. Duplicating an audio note copies the `note_audio` row with the
  same `sha256`, so refcounts matter here too.
- An audio sweep runs alongside the image sweep (startup, then daily) with the
  same grace period, pinning and "skip if nothing is referenced" guard.
- **Backups do not change:** they are still the database plus
  `JOT_UPLOAD_DIR`, which now also holds `audio/`.

### 4.2 Accepted formats

The client records whatever its platform produces; Jot stores it unchanged and
does not transcode (that would mean bundling ffmpeg).

| Client | Recorder | Preferred container |
|---|---|---|
| Webapp | `MediaRecorder` | First of `audio/mp4` (AAC), `audio/webm;codecs=opus`, `audio/ogg;codecs=opus` that `MediaRecorder.isTypeSupported` accepts. MP4/AAC first because every target can play it. |
| Mobile | `expo-audio` | `.m4a` (AAC) on both platforms. |

The server sniffs the container from the first bytes (MP4 `ftyp`, WebM/Matroska
EBML header, Ogg `OggS`) and rejects anything else with 400
`unsupported_audio_type`. The stored `content_type` is the normalized container
(`audio/mp4`, `audio/webm`, `audio/ogg`), not the client's claim.

**To verify early in implementation:** that a WebM/Opus recording made in
Chromium or Firefox plays in Safari on macOS and iOS. If it does not, the
webapp shows "This recording can't be played in this browser" with a download
link, and we revisit server-side transcoding in the sidecar.

### 4.3 Serving

`GET /api/v1/audio/{id}` mirrors `GET /images/{id}`: access check through the
note, `Content-Type` from the stored value, `X-Content-Type-Options: nosniff`,
`Cache-Control: private, max-age=31536000, immutable`, ETag from the hash.
`http.ServeContent` provides byte ranges, which the player needs for seeking
and which Safari requires before it plays media at all.

The service worker does **not** cache audio. Range requests return 206
responses, which the Cache API cannot store as-is; offline playback on the web
is out of scope for v1. Mobile downloads the file into its local cache for
offline playback, like `useNoteImageCache`.

### 4.4 Limits

- **Size:** `JOT_UPLOAD_MAX_BYTES` (default 25 MB) applies, as for images.
  The upload is streamed to a temp file while hashing, not read into memory.
- **Duration:** `JOT_AUDIO_MAX_DURATION` (default `10m`, range `1m`–`60m`). The
  client stops recording automatically at the cap and says so. The server cannot
  measure duration without decoding, so it trusts the client's `duration_ms`
  only for display and relies on the byte cap for protection.

  The 10-minute default keeps a typical transcript under the 10,000-character
  text-note cap (roughly 1,500–1,700 spoken words). AAC at 64 kbps is about
  0.5 MB a minute, so a 60-minute cap needs a larger `JOT_UPLOAD_MAX_BYTES`;
  the docs say so next to the variable.

---

## 5. Transcription

### 5.1 Configuration

| Variable | Default | Meaning |
|---|---|---|
| `JOT_TRANSCRIPTION_URL` | unset | Full endpoint URL, e.g. `http://whisper:8080/v1/audio/transcriptions`. Unset disables transcription. |
| `JOT_TRANSCRIPTION_MODEL` | empty | Sent as the `model` form field. whisper.cpp ignores it; Speaches needs it (e.g. `Systran/faster-whisper-small`). |
| `JOT_TRANSCRIPTION_API_KEY` | unset | Sent as `Authorization: Bearer …` when set. |
| `JOT_TRANSCRIPTION_TIMEOUT` | `15m` | Deadline for one request. |
| `JOT_TRANSCRIPTION_CONCURRENCY` | `1` | Jobs in flight at once (1–8). |

A full URL rather than a base URL means whisper.cpp also works with its default
`/inference` path. Startup logs whether transcription is enabled, and the URL
without credentials. It does not probe the service: a sidecar that starts after
Jot is normal.

`GET /api/v1/config` gains `transcription_enabled` and
`audio_max_duration_seconds` so clients can adapt their UI.

### 5.2 Request

```text
POST {JOT_TRANSCRIPTION_URL}
Content-Type: multipart/form-data
  file             = <the stored blob, original filename + content type>
  model            = {JOT_TRANSCRIPTION_MODEL}   (omitted when empty)
  response_format  = json
```

Jot reads `text` from the JSON response, and `language` and `duration` if they
are present. No language hint is sent in v1, so the service auto-detects; see §9.

### 5.3 Worker

A background worker, started and stopped like the other background tasks
(`startPeriodicTask`, `bgWg`), drives `note_audio.transcript_status`. The
database is the queue, so nothing is lost on restart:

| From | Event | To |
|---|---|---|
| — | Upload, transcription enabled | `pending` |
| — | Upload, transcription disabled | `none` |
| `none`, `failed` | `POST /notes/{id}/audio/transcribe` | `pending` (attempts reset) |
| `pending` | Worker claims it | `processing` |
| `processing` | Service returns a transcript | `done` |
| `processing` | Transient error, fewer than 3 attempts | `pending`, with backoff |
| `processing` | Permanent error, or the 3rd transient one | `failed` |
| `processing` | Lease expired or graceful shutdown | `pending` |

- **Wake-ups:** an in-process nudge on upload and retry, plus a poll every
  minute for due `pending` rows (cheap: indexed, usually empty).
- **Claim:** pick the oldest due `pending` row, then
  `UPDATE … SET transcript_status = 'processing', transcript_claimed_at = ?
  WHERE id = ? AND transcript_status = 'pending'`. Only the instance whose
  update hit a row runs the job.
- **Lease recovery:** a `processing` row whose `transcript_claimed_at` is older
  than the timeout plus a grace period goes back to `pending` (the process died
  mid-job). A job interrupted by graceful shutdown is put back right away and
  does not count as an attempt.
- **Success:** one transaction writes the transcript (bounded, §3.1) into
  `notes.content`, bumps `version`, records the change as made by
  `uploaded_by` so collaborators get the "updated" badge, and sets the row to
  `done` with language and duration. If the note was hard-deleted meanwhile,
  the result is dropped. A note in the trash still gets its transcript, since
  it can be restored.
- **Errors:**
  - Connection errors, timeouts, 5xx, 408 and 429 are **transient**: attempts
    go up and the row goes back to `pending` with backoff (1, 5, 30 minutes).
    The third transient failure is final: `failed`, "The transcription service
    is unavailable."
  - Any other 4xx, or a response without `text`, is **permanent**: `failed` at
    once, with a short message. The full response goes to the server log, not
    to the user.
- **Empty transcript:** `done` with empty content; the UI shows "No speech
  detected."
- **Events:** every status change publishes the note through
  `PersonalizedNote(…, EventNoteUpdated)`. The note embeds `audio`, so clients
  need no new SSE event type.

This covers the threat model's "unintentional internal overload" concerns:
bounded concurrency, bounded automatic retries with backoff, uploads behind the
existing `expensive` rate limit, and a manual retry that only works from
`none` or `failed`.

### 5.4 Reference deployment

`docker-compose.yml` gains an optional, commented-out `whisper` service using
`ghcr.io/ggml-org/whisper.cpp:main`, pinned as `tag@sha256` with the manifest
index digest per the repo's pinning rule. It runs `whisper-server` with
`--convert`, `--inference-path /v1/audio/transcriptions` and a model from a
mounted `./whisper-models` volume, on the compose network only (no published
port). The README documents the one-time model download and suggests a model
per kind of hardware: `base` or `small` for a small CPU-only server,
`large-v3-turbo` with a GPU.

Whisper can produce text from silence (stock phrases such as "Thanks for
watching"). Enabling the service's voice-activity detection where available is
part of the documented setup. Jot does not filter transcripts.

---

## 6. API

All under `/api/v1`. Swagger annotations on every handler; `task gen-docs`.

| Method & path | Behavior |
|---|---|
| `POST /notes` with `note_type: "audio"` | Creates an empty audio note. Accepts `title`, `color`, `labels` and a client-supplied `id`; `content` and `items` are rejected with 400. 201. |
| `POST /notes/{id}/audio` | Multipart `file` plus optional `duration_ms`. 201 with `NoteAudio`. 400 if the note is not an audio note or the format is not accepted; 409 `audio_already_exists` if the note has a recording; 413 over `JOT_UPLOAD_MAX_BYTES`. Behind the `expensive` rate limit. Any user with access may upload, as with images. |
| `GET /audio/{id}` | The recording, with byte ranges (§4.3). |
| `POST /notes/{id}/audio/transcribe` | Requests a transcription from `none` or `failed`: resets attempts and sets `pending`. 202. 409 from any other state; 422 `transcription_disabled` when no service is configured. Behind the `expensive` rate limit. |
| `PATCH /notes/{id}` | On an audio note: `title`, `color`, `pinned`, `archived` and the other metadata fields as usual; `content` is rejected with `ErrNoteFieldNotAllowed`. |
| Note type conversion | To or from `audio` is rejected with 400. The transcript can be copied out through the clipboard instead (§7). |
| Duplicate | Allowed: copies the note, the transcript and the `note_audio` row (same blob). |

**API-breaking change for clients:** `note_type` gains a value. A client from
before this change that receives an audio note must not crash. The webapp and
mobile app ship audio support in the same release as the server, but a mobile
app that has not been updated yet will meet audio notes recorded on the web.
Phase 1 therefore includes a fallback in both clients that renders an unknown
note type as a read-only card ("This note type needs a newer version of
Jot"); it ships before the server starts creating audio notes.

### 6.1 Other surfaces

- **Export/import:** the bundle gains an `audio/` folder and an `audio` field
  per note; the format version goes from 2 to 3, and import accepts both. An
  imported recording's transcript status is kept if `done`, otherwise reset to
  `none`.
- **Google Keep import:** Keep has voice notes, but the importer skips their
  audio today. Bringing them in is a follow-up, not part of v1.
- **MCP:** reads return audio notes with the transcript as `content` and
  `note_type: "audio"`. `create_note` rejects `audio`, since MCP cannot record.
- **Admin stats:** count audio notes next to text and list notes.

---

## 7. Clients

### 7.1 Webapp

- **Entry point:** "Audio note" next to the existing new-note choices.
- **Recorder** (empty audio note): a large Record button. While recording:
  elapsed time against the cap, a level meter (`AnalyserNode`), Pause/Resume,
  Stop, Discard. Leaving the page while recording asks for confirmation
  (`beforeunload`).
- **After Stop:** upload progress, then the player (native `<audio controls>`)
  and the transcript area showing the status:

  | `transcript_status` | Shown |
  |---|---|
  | `pending`, `processing` | "Transcribing…" |
  | `done` | Transcript text, selectable, with Copy; "No speech detected" if empty |
  | `failed` | `transcript_error` and Retry |
  | `none` | Nothing if transcription is disabled; a "Transcribe" button if it has since been enabled |

- **Card:** title, or the first line of the transcript; a microphone icon and
  the duration; "Transcribing…" while pending.
- **Microphone access** needs a secure context (HTTPS or `localhost`). On plain
  HTTP the Record button is disabled with an explanation. This matters for
  self-hosters on a LAN.
- New strings go through i18n (`check-translations`).

### 7.2 Mobile

- `expo-audio`, added with `npx expo install` so the version matches the SDK.
  Its config plugin adds the microphone permission strings. A new native module
  means a new development build.
- Same recorder and states as the web. Recording pauses when the app goes to
  the background or the system interrupts audio (a phone call); the user
  resumes manually. The screen stays awake while recording.
- **Offline:** recording works without a connection. The note is created
  locally and queued as usual, and the file goes into a `pending_audio_uploads`
  table that mirrors `pending_image_uploads` (#618) and is drained by the same
  sync engine. The note shows "Waiting to upload" until it is sent;
  transcription starts once it reaches the server.
- **Known limitation:** if the app is killed mid-recording, the m4a file is not
  finalized and the recording is lost.

### 7.3 Settings

No per-user settings in v1. Transcription is an instance-wide setting.

---

## 8. Testing

- **Server:** `http_audio_test.go` integration tests (`t.Parallel()`, own
  server per test) with an `httptest` stub as the transcription service:
  upload, sniffing, cap and 409 paths, range requests, worker success,
  transient retry with backoff, permanent failure, lease recovery, manual
  retry, disabled mode, hard-delete reclaim, sweep, export/import round trip.
  Store and migration tests run against Postgres in CI as usual.
- **Webapp e2e** (`webapp/e2e/`, page object for the audio note): Chromium's
  fake media devices (`--use-fake-ui-for-media-stream`,
  `--use-fake-device-for-media-stream`, `--use-file-for-fake-audio-capture`)
  for recording, and a stub transcription service configured through
  `JOT_TRANSCRIPTION_URL` in the e2e server for a fixed transcript. Covers
  record → pause → resume → stop → transcript, failure → retry, and the
  disabled state.
- **Mobile:** unit tests for the upload queue and the state rendering.

---

## 9. Decisions to confirm

| Question | Proposal |
|---|---|
| Re-record or replace a recording? | No in v1. Delete the note and record a new one. |
| Language hint for the service? | None; auto-detect. A per-user "spoken language" setting can come later if detection proves unreliable for short memos. |
| Default duration cap | 10 minutes, configurable up to 60. |
| Does a transcript arriving mark a shared note "updated"? | Yes, attributed to the recorder. |
| Reference service | whisper.cpp; Speaches documented as the alternative. |

---

## 10. Delivery

Each phase is its own PR, and each leaves the app working.

1. **Server foundation:** migration, note type, `AudioStore` with reclaim and
   sweep, upload/serve/duplicate, `PATCH` rules, export/import v3, MCP and admin
   stats. Plus the unknown-note-type fallback in the webapp and mobile.
2. **Transcription:** config, worker, retry endpoint, `/config` fields,
   compose sidecar and README.
3. **Webapp:** recorder, player, transcript states, card, e2e tests.
4. **Mobile:** `expo-audio` recorder, offline upload queue, local file cache.
