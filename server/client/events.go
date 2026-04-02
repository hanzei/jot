package client

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// SSEEvent is a single event received from the server-sent events stream.
type SSEEvent struct {
	Type         string  `json:"type"`
	NoteID       string  `json:"note_id,omitempty"`
	SourceUserID string  `json:"source_user_id"`
	TargetUserID string  `json:"target_user_id,omitempty"`
	User         *User   `json:"user,omitempty"`
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
		for scanner.Scan() {
			line := scanner.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var event SSEEvent
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event); err != nil {
				continue
			}
			select {
			case ch <- event:
			case <-ctx.Done():
				return
			}
		}
	}()

	return ch, nil
}
