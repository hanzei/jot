# SSE Client ID Filtering — Design Spec

**Date:** 2026-04-07  
**Status:** Approved

---

## Problem

SSE events are broadcast to every subscriber channel registered for a user ID,
including the tab or device that triggered the mutation. This causes redundant
work on the originating client:

- **Webapp:** every note edit triggers a `loadNotes()` refetch on the same tab
  that just made the change.
- **Mobile:** own-device mutations trigger query invalidation on the same device
  that already applied the change.

`source_user_id` exists in every event but only identifies the *user*, not the
*tab or device*. It cannot distinguish "my tab" from "my other tab", so it
cannot be used to suppress own-client events in multi-tab or multi-device
scenarios.

---

## Goals

1. The client that triggered a mutation does not process the resulting SSE event.
2. Other tabs/devices of the same user continue to receive and process the event.
3. Other users sharing the note continue to receive and process the event.
4. Clean up the existing same-user workaround in mobile `useSSE.ts`.

---

## Non-Goals

- Server-side exclusion (not sending the event at all to the originating
  connection). Client-side filtering is sufficient; the hub stays simple.
- Reducing SSE traffic. One extra event per mutation on one channel is
  negligible.

---

## Approach: Client ID Tag with Client-Side Filtering

Each client generates a unique ID once per lifetime (tab load or app launch).
It sends this ID as an `X-Client-ID` HTTP header on every mutating request. The
server stamps the ID onto the published SSE event. Each client drops incoming
events whose `client_id` matches its own ID.

**Why not server-side connection exclusion?**  
The server would need to deliver the SSE connection ID back to the client before
the client can attach it to mutations. This creates a sequencing dependency
(SSE must connect before mutations are allowed) and requires awkward wiring
between the long-lived SSE connection and the short-lived HTTP client. The
client-ID approach is self-contained: the client generates its own ID at module
initialization with no coordination needed.

---

## Data Model Changes

### `server/internal/sse/hub.go`

Add `ClientID` to the `Event` struct:

```go
type Event struct {
    Type         EventType `json:"type"`
    SourceUserID string    `json:"source_user_id"`
    TargetUserID string    `json:"target_user_id,omitempty"`
    ClientID     string    `json:"client_id,omitempty"` // tab/device that triggered the mutation
    Data         any       `json:"data,omitempty"`
}
```

`ClientID` is omitted when the mutation originates from a non-browser client
(MCP tools, `jotctl`, direct API calls) that does not send `X-Client-ID`.

### `shared/src/types.ts`

Add `client_id?: string` to all three SSE event interfaces:

```typescript
export interface NoteSSEEvent {
  type: 'note_created' | 'note_updated' | 'note_deleted' | 'note_shared' | 'note_unshared';
  source_user_id: string;
  target_user_id?: string;
  client_id?: string;   // new
  data: { note_id: string; note: Note | null };
}

export interface LabelsChangedSSEEvent {
  type: 'labels_changed';
  source_user_id: string;
  client_id?: string;   // new
  data: { label: Label };
}

export interface ProfileIconSSEEvent {
  type: 'profile_icon_updated';
  source_user_id: string;
  client_id?: string;   // new
  data: { user: User };
}
```

Optional because clients that do not send `X-Client-ID` (MCP, `jotctl`, old
clients) produce events without the field; those events must still be processed.

---

## Server Changes

### Handlers (`notes.go`, `labels.go`, `auth.go`, `sharing.go`)

Read `X-Client-ID` from the request header and include it when constructing
`sse.Event`:

```go
clientID := r.Header.Get("X-Client-ID")
h.hub.Publish(ctx, audienceIDs, sse.Event{
    Type:         sse.EventNoteUpdated,
    SourceUserID: userID,
    ClientID:     clientID,
    Data:         sse.NoteEventData{NoteID: noteID, Note: note},
})
```

No changes to `Hub.Publish()` or `Hub.Subscribe()`. The hub is unaware of
client IDs and requires no modification.

---

## Webapp Changes

### `webapp/src/utils/api.ts`

Generate a per-tab client ID at module initialization and attach it as a default
axios header:

```typescript
const CLIENT_ID = crypto.randomUUID();
axiosInstance.defaults.headers.common['X-Client-ID'] = CLIENT_ID;
export { CLIENT_ID };
```

`crypto.randomUUID()` is available in all modern browsers and in the jsdom test
environment (Node 19+).

### `webapp/src/utils/useSSE.ts`

Import `CLIENT_ID` and drop events that the current tab originated:

```typescript
import { CLIENT_ID } from '@/utils/api';

// inside onmessage, after parsing:
if (event.client_id && event.client_id === CLIENT_ID) return;
onEventRef.current(event);
```

Events with no `client_id` (e.g., from `jotctl` or MCP) fall through and are
processed normally.

---

## Mobile Changes

### `mobile/src/api/client.ts`

Generate a per-launch client ID at module initialization and attach it as a
default header on the existing axios instance (the same pattern as the webapp).
`crypto.randomUUID()` is available globally on Hermes (React Native 0.73+):

```typescript
const CLIENT_ID = crypto.randomUUID();
api.defaults.headers.common['X-Client-ID'] = CLIENT_ID;
export { CLIENT_ID };
```

### `mobile/src/hooks/useSSE.ts`

Import the client ID and filter at the very top of the event handler (before any
query invalidation):

```typescript
if (event.client_id && event.client_id === clientId) return;
```

#### Existing workaround: `source_user_id` check

The current check at line 69:

```typescript
// Only notify subscribers about updates from other users. Updates from
// the current user (possibly from another device) are handled by query
// invalidation above and don't need an "updated by someone else" toast.
if (event.source_user_id !== userIdRef.current) {
  onNoteUpdatedRef.current?.(event);
}
```

This check is **kept** but its scope changes. Before this fix it also suppressed
same-device events (which are now filtered by `client_id` before reaching this
point). After the fix it exclusively handles the cross-device, same-user case:
the current user edited a note on another device, query invalidation should
fire, but the "someone updated your note" notification callback should not. The
comment is updated to reflect this.

---

## Test Changes

### Server integration tests

- Extend existing SSE event assertions to verify `client_id` equals the
  `X-Client-ID` header value when the header is present.
- Add a case where `X-Client-ID` is absent: assert `client_id` is omitted from
  the event JSON.

### `webapp/src/utils/__tests__/useSSE.test.ts`

Add three cases:

1. Event with `client_id` matching `CLIENT_ID` → `onEvent` is **not** called.
2. Event with `client_id` not matching `CLIENT_ID` → `onEvent` **is** called.
3. Event with no `client_id` → `onEvent` **is** called.

### `mobile/__tests__/useSSE.test.tsx`

- Update the "invalidates queries for same-user events to support cross-device
  sync" test: use a different `client_id` in the event (simulating a different
  device). Assert query invalidation fires and notification callback is
  suppressed.
- Add a test: event with the same `client_id` as the current device → no query
  invalidation, no notification callback.

---

## Correctness Scenarios

| Scenario | `client_id` in event | `source_user_id` | Tab/device | Result |
|---|---|---|---|---|
| Own tab edit | `"cli-A"` | `user-1` | Tab A (`"cli-A"`) | Filtered — no reload |
| Other tab, same user | `"cli-A"` | `user-1` | Tab B (`"cli-B"`) | Processed — reloads |
| Another user's edit | `"cli-X"` | `user-2` | Tab A (`"cli-A"`) | Processed — reloads |
| MCP / jotctl mutation | _(absent)_ | `user-1` | Tab A (`"cli-A"`) | Processed — reloads |
| Own device mobile | `"mob-A"` | `user-1` | Device A (`"mob-A"`) | Filtered — no invalidation |
| Other device, same user | `"mob-B"` | `user-1` | Device A (`"mob-A"`) | Processed — invalidates, no toast |
| Other user's device | `"mob-X"` | `user-2` | Device A (`"mob-A"`) | Processed — invalidates, toast fires |
