package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/sse"
)

// EventsHandler streams SSE events to authenticated clients.
type EventsHandler struct {
	hub *sse.Hub
}

// NewEventsHandler creates an EventsHandler backed by the given hub.
func NewEventsHandler(hub *sse.Hub) *EventsHandler {
	return &EventsHandler{hub: hub}
}

// ServeSSE is a plain http.HandlerFunc (not the (int, error) pattern) because
// it holds the connection open indefinitely.
func (h *EventsHandler) ServeSSE(w http.ResponseWriter, r *http.Request) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	// Disable the server's write deadline for this long-lived SSE connection only.
	rc := http.NewResponseController(w)
	if err := rc.SetWriteDeadline(time.Time{}); err != nil {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable nginx proxy buffering

	ch, unsubscribe := h.hub.Subscribe(user.ID)
	defer unsubscribe()

	// Flush the headers immediately so the client knows the connection is open.
	if _, err := fmt.Fprintf(w, ": connected\n\n"); err != nil {
		return
	}
	flusher.Flush()

	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case event, ok := <-ch:
			if !ok {
				return
			}
			data, err := json.Marshal(event)
			if err != nil {
				continue
			}
			if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
				return
			}
			flusher.Flush()
		case <-ticker.C:
			if _, err := fmt.Fprintf(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
