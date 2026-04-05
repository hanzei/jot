package sse

import (
	"context"
	"fmt"
	"sync"

	"github.com/sirupsen/logrus"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// EventType identifies the kind of note mutation that occurred.
type EventType string

const (
	EventNoteCreated  EventType = "note_created"
	EventNoteUpdated  EventType = "note_updated"
	EventNoteDeleted  EventType = "note_deleted"
	EventNoteShared   EventType = "note_shared"
	EventNoteUnshared EventType = "note_unshared"
)

// Event is the payload pushed to SSE clients.
type Event struct {
	Type         EventType `json:"type"`
	NoteID       string    `json:"note_id"`
	Note         any       `json:"note"`                        // nil for deleted/unshared
	SourceUserID string    `json:"source_user_id"`              // who triggered the change
	TargetUserID string    `json:"target_user_id,omitempty"`    // user affected (e.g. unshared)
}

// Hub manages per-user SSE subscriber channels.
type Hub struct {
	mu                sync.RWMutex
	clients           map[string][]chan Event // user_id -> subscriber channels
	subscribersActive metric.Int64UpDownCounter
	eventsPublished   metric.Int64Counter
	eventsDropped     metric.Int64Counter
}

// NewHub creates a ready-to-use Hub with OTel instruments initialised from the
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
func (h *Hub) Subscribe(userID string) (<-chan Event, func()) {
	ch := make(chan Event, 16)

	h.mu.Lock()
	h.clients[userID] = append(h.clients[userID], ch)
	h.mu.Unlock()

	h.subscribersActive.Add(context.Background(), 1)

	unsubscribe := func() {
		h.mu.Lock()
		defer h.mu.Unlock()
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

// Publish sends an event to all channels registered for each of the given user IDs.
// Duplicate user IDs are ignored. Events are dropped (non-blocking) if a channel's buffer is full.
// ctx should be the request context of the caller so that OTel exemplars can link
// the metric increments to the active trace span.
func (h *Hub) Publish(ctx context.Context, userIDs []string, event Event) {
	h.mu.RLock()
	defer h.mu.RUnlock()

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
				logrus.WithField("type", event.Type).WithField("note_id", event.NoteID).WithField("user_id", uid).Warn("sse: dropping event, channel full")
				h.eventsDropped.Add(ctx, 1, metric.WithAttributes(eventAttr))
			}
		}
	}
}
