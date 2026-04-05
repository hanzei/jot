package client

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// SSENoteData is the Data payload for note-related SSE events.
type SSENoteData struct {
	NoteID string `json:"note_id"`
	Note   *Note  `json:"note"`
}

// SSEProfileIconData is the Data payload for profile_icon_updated SSE events.
type SSEProfileIconData struct {
	User *User `json:"user"`
}

// SSELabelsData is the Data payload for labels_changed SSE events.
type SSELabelsData struct {
	Label *Label `json:"label"`
}

// SSEEvent is a single event received from the server-sent events stream.
// Depending on Type, NoteData, LabelsData, or ProfileData may be non-nil.
type SSEEvent struct {
	Type         string
	SourceUserID string
	TargetUserID string
	NoteData     *SSENoteData        // set for note_created/updated/deleted/shared/unshared
	LabelsData   *SSELabelsData      // set for labels_changed
	ProfileData  *SSEProfileIconData // set for profile_icon_updated
}

// sseEventWire is the raw JSON shape of an SSE event envelope.
type sseEventWire struct {
	Type         string          `json:"type"`
	SourceUserID string          `json:"source_user_id"`
	TargetUserID string          `json:"target_user_id,omitempty"`
	Data         json.RawMessage `json:"data,omitempty"`
}

func parseSSEEvent(raw []byte) (SSEEvent, bool) {
	var wire sseEventWire
	if err := json.Unmarshal(raw, &wire); err != nil {
		return SSEEvent{}, false
	}
	ev := SSEEvent{
		Type:         wire.Type,
		SourceUserID: wire.SourceUserID,
		TargetUserID: wire.TargetUserID,
	}
	switch wire.Type {
	case "note_created", "note_updated", "note_deleted", "note_shared", "note_unshared":
		var d SSENoteData
		if len(wire.Data) > 0 {
			if err := json.Unmarshal(wire.Data, &d); err != nil {
				return SSEEvent{}, false
			}
		}
		ev.NoteData = &d
	case "labels_changed":
		var d SSELabelsData
		if len(wire.Data) > 0 {
			if err := json.Unmarshal(wire.Data, &d); err != nil {
				return SSEEvent{}, false
			}
		}
		ev.LabelsData = &d
	case "profile_icon_updated":
		var d SSEProfileIconData
		if len(wire.Data) > 0 {
			if err := json.Unmarshal(wire.Data, &d); err != nil {
				return SSEEvent{}, false
			}
		}
		ev.ProfileData = &d
	}
	return ev, true
}

// SubscribeSSE opens a long-lived SSE connection and sends each parsed event
// to the returned channel. The connection is closed when ctx is canceled.
// The caller must drain the channel; events are dropped if the channel is full.
func (c *Client) SubscribeSSE(ctx context.Context) (<-chan SSEEvent, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url("/api/v1/events"), nil)
	if err != nil {
		return nil, fmt.Errorf("create SSE request: %w", err)
	}
	req.Header.Set("Accept", "text/event-stream")

	resp, err := c.httpClient.Do(req) //nolint:bodyclose // body is closed in the goroutine below
	if err != nil {
		return nil, fmt.Errorf("connect to SSE stream: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		_ = resp.Body.Close()
		return nil, &Error{StatusCode: resp.StatusCode}
	}

	ch := make(chan SSEEvent, 32)
	go func() {
		defer resp.Body.Close()
		defer close(ch)
		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 64*1024), 512*1024)
		for scanner.Scan() {
			line := scanner.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			event, ok := parseSSEEvent([]byte(strings.TrimPrefix(line, "data: ")))
			if !ok {
				continue
			}
			select {
			case ch <- event:
			case <-ctx.Done():
				return
			default:
				// channel full; drop event rather than block
			}
		}
	}()

	return ch, nil
}
