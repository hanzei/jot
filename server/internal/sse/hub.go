package sse

import (
	"sync"

	"github.com/sirupsen/logrus"
)

// EventType identifies the kind of note mutation that occurred.
type EventType string

const (
	EventNoteCreated  EventType = "note_created"
	EventNoteUpdated  EventType = "note_updated"
	EventNoteDeleted  EventType = "note_deleted"
	EventNoteShared   EventType = "note_shared"
	EventNoteUnshared EventType = "note_unshared"
	EventNoteOpened   EventType = "note_opened"
	EventNoteClosed   EventType = "note_closed"
)

// Event is the payload pushed to SSE clients.
type Event struct {
	Type         EventType `json:"type"`
	NoteID       string    `json:"note_id"`
	Note         any       `json:"note"`                     // nil for deleted/unshared
	SourceUserID string    `json:"source_user_id"`           // who triggered the change
	TargetUserID string    `json:"target_user_id,omitempty"` // user affected (e.g. unshared)
}

// Hub manages per-user SSE subscriber channels.
type Hub struct {
	mu      sync.RWMutex
	clients map[string][]chan Event // user_id -> subscriber channels
}

// NewHub creates a ready-to-use Hub.
func NewHub() *Hub {
	return &Hub{
		clients: make(map[string][]chan Event),
	}
}

// Subscribe registers a buffered channel for userID and returns an unsubscribe function.
// The caller must call unsubscribe when the SSE connection closes.
func (h *Hub) Subscribe(userID string) (<-chan Event, func()) {
	ch := make(chan Event, 16)

	h.mu.Lock()
	h.clients[userID] = append(h.clients[userID], ch)
	h.mu.Unlock()

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
	}

	return ch, unsubscribe
}

// Publish sends an event to all channels registered for each of the given user IDs.
// Duplicate user IDs are ignored. Events are dropped (non-blocking) if a channel's buffer is full.
func (h *Hub) Publish(userIDs []string, event Event) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	seen := make(map[string]struct{}, len(userIDs))
	for _, uid := range userIDs {
		if _, ok := seen[uid]; ok {
			continue
		}
		seen[uid] = struct{}{}
		for _, ch := range h.clients[uid] {
			select {
			case ch <- event:
			default:
				logrus.WithField("type", event.Type).WithField("note_id", event.NoteID).WithField("user_id", uid).Warn("sse: dropping event, channel full")
			}
		}
	}
}
