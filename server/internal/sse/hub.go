package sse

import (
	"context"
	"fmt"
	"maps"
	"sync"

	"github.com/hanzei/jot/server/internal/logutil"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// EventType identifies the kind of mutation that occurred.
type EventType string

const (
	EventNoteCreated        EventType = "note_created"
	EventNoteUpdated        EventType = "note_updated"
	EventNoteDeleted        EventType = "note_deleted"
	EventNoteShared         EventType = "note_shared"
	EventNoteUnshared       EventType = "note_unshared"
	EventLabelsChanged      EventType = "labels_changed"
	EventProfileIconUpdated EventType = "profile_icon_updated"
	EventNoteImageAdded     EventType = "note_image_added"
	EventNoteImageRemoved   EventType = "note_image_removed"
)

// NoteEventData is the Data payload for note-related events.
type NoteEventData struct {
	NoteID string `json:"note_id"`
	Note   any    `json:"note"` // nil for deleted/unshared
}

// NoteImageEventData is the Data payload for note_image_added/note_image_removed
// events. Image is set for note_image_added; ImageID is set for
// note_image_removed (the row is already gone by the time that event fires).
type NoteImageEventData struct {
	NoteID  string `json:"note_id"`
	Image   any    `json:"image,omitempty"`
	ImageID string `json:"image_id,omitempty"`
}

// ProfileIconEventData is the Data payload for profile_icon_updated events.
type ProfileIconEventData struct {
	User any `json:"user"`
}

// LabelsEventData is the Data payload for labels_changed events.
type LabelsEventData struct {
	Label any `json:"label"`
}

// Event is the payload pushed to SSE clients.
type Event struct {
	Type         EventType `json:"type"`
	SourceUserID string    `json:"source_user_id"`           // who triggered the change
	TargetUserID string    `json:"target_user_id,omitempty"` // user affected (e.g. unshared)
	ClientID     string    `json:"client_id,omitempty"`      // tab/device that triggered the mutation
	Data         any       `json:"data,omitempty"`
}

// Hub manages per-user SSE subscriber channels.
type Hub struct {
	mu                sync.RWMutex
	clients           map[string][]chan Event // user_id -> subscriber channels
	closed            bool
	subscribersActive metric.Int64UpDownCounter
	eventsPublished   metric.Int64Counter
	eventsDropped     metric.Int64Counter
}

// NewHub creates a ready-to-use Hub with OTel instruments initialized from the
// global MeterProvider. Returns an error if any instrument cannot be created.
func NewHub() (*Hub, error) {
	meter := otel.GetMeterProvider().Meter("github.com/hanzei/jot/server")

	subscribersActive, err := meter.Int64UpDownCounter(
		"sse.subscribers.active",
		metric.WithDescription("Number of active SSE subscriber connections"),
	)
	if err != nil {
		return nil, fmt.Errorf("create sse.subscribers.active instrument: %w", err)
	}

	eventsPublished, err := meter.Int64Counter(
		"sse.events.published",
		metric.WithDescription("Total SSE events delivered to subscriber channels"),
	)
	if err != nil {
		return nil, fmt.Errorf("create sse.events.published instrument: %w", err)
	}

	eventsDropped, err := meter.Int64Counter(
		"sse.events.dropped",
		metric.WithDescription("Total SSE events dropped because a subscriber channel was full"),
	)
	if err != nil {
		return nil, fmt.Errorf("create sse.events.dropped instrument: %w", err)
	}

	return &Hub{
		clients:           make(map[string][]chan Event),
		subscribersActive: subscribersActive,
		eventsPublished:   eventsPublished,
		eventsDropped:     eventsDropped,
	}, nil
}

// Subscribe registers a buffered channel for userID and returns an unsubscribe function.
// The caller must call unsubscribe when the SSE connection closes.
// ctx is used to link the active-subscriber gauge increment to the caller's trace span.
func (h *Hub) Subscribe(ctx context.Context, userID string) (<-chan Event, func()) {
	ch := make(chan Event, 16)

	h.mu.Lock()
	if h.closed {
		// The hub is shutting down. Hand back an already-closed channel so the
		// caller's read loop exits immediately instead of blocking forever —
		// nothing would ever close this channel otherwise, which would leak the
		// ServeSSE goroutine and stall graceful shutdown until its deadline. The
		// returned unsubscribe is a no-op since the channel was never registered.
		h.mu.Unlock()
		close(ch)
		return ch, func() {}
	}
	h.clients[userID] = append(h.clients[userID], ch)
	h.mu.Unlock()

	h.subscribersActive.Add(ctx, 1)

	unsubscribe := func() { //nolint:contextcheck // request ctx is already canceled when unsubscribe runs
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.closed {
			// Hub.Close already closed this channel; just decrement the counter.
			h.subscribersActive.Add(context.Background(), -1)
			return
		}
		channels := h.clients[userID]
		for i, c := range channels {
			if c == ch {
				h.clients[userID] = append(channels[:i], channels[i+1:]...)
				break
			}
		}
		if len(h.clients[userID]) == 0 {
			delete(h.clients, userID)
		}
		close(ch)
		h.subscribersActive.Add(context.Background(), -1)
	}

	return ch, unsubscribe
}

// Close terminates all active SSE subscriptions by closing their channels,
// causing any ServeSSE goroutines blocked on channel reads to exit. It is
// safe to call Close multiple times. After Close, calls to unsubscribe from
// existing subscriptions are safe and will not double-close channels. Publish
// becomes a no-op after Close. Subscribe after Close returns an already-closed
// channel and a no-op unsubscribe, so a late connection during shutdown exits
// cleanly instead of blocking.
func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	h.closed = true
	for channels := range maps.Values(h.clients) {
		for _, ch := range channels {
			close(ch)
		}
	}
}

// Publish sends an event to all channels registered for each of the given user IDs.
// Duplicate user IDs are ignored. Events are dropped (non-blocking) if a channel's buffer is full.
// ctx should be the request context of the caller so that OTel exemplars can link
// the metric increments to the active trace span. Publish is a no-op after Close.
func (h *Hub) Publish(ctx context.Context, userIDs []string, event Event) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.closed {
		return
	}

	eventAttr := attribute.String("event.type", string(event.Type))

	seen := make(map[string]struct{}, len(userIDs))
	for _, uid := range userIDs {
		if _, ok := seen[uid]; ok {
			continue
		}
		seen[uid] = struct{}{}
		for _, ch := range h.clients[uid] {
			select {
			case ch <- event:
				h.eventsPublished.Add(ctx, 1, metric.WithAttributes(eventAttr))
			default:
				logutil.FromContext(ctx).WithField("type", string(event.Type)).WithField("user_id", uid).Warn("SSE: dropping event, channel full")
				h.eventsDropped.Add(ctx, 1, metric.WithAttributes(eventAttr))
			}
		}
	}
}
