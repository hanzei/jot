package handlers

import (
	"context"
	"encoding/json/v2"
	"fmt"
	"net/http"
	"time"

	"github.com/hanzei/jot/server/internal/apierr"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/logutil"
	"github.com/hanzei/jot/server/internal/sse"
)

// sseHeartbeatInterval is how often an idle stream sends an empty event so the
// client's liveness watchdog stays satisfied.
const sseHeartbeatInterval = 30 * time.Second

// DefaultSSECredentialRecheckInterval is how often an open stream re-checks
// the credential it was opened with, as a backstop to Hub.InvalidateUser. It is
// what notices session expiry, which deletes nothing at the moment it happens.
const DefaultSSECredentialRecheckInterval = 5 * time.Minute

// credentialChecker re-validates the credential a request was authenticated
// with. *auth.SessionService implements it.
type credentialChecker interface {
	CredentialStillValid(ctx context.Context) (bool, error)
}

// EventsHandler streams SSE events to authenticated clients.
type EventsHandler struct {
	hub             *sse.Hub
	credentials     credentialChecker
	recheckInterval time.Duration
}

// NewEventsHandler creates an EventsHandler backed by the given hub. Each
// stream re-checks its credential with credentials whenever the hub signals
// it and every recheckInterval, and ends once the credential is gone.
func NewEventsHandler(hub *sse.Hub, credentials credentialChecker, recheckInterval time.Duration) *EventsHandler {
	if hub == nil {
		panic("NewEventsHandler: hub must not be nil")
	}
	if credentials == nil {
		panic("NewEventsHandler: credentials must not be nil")
	}
	if recheckInterval <= 0 {
		panic("NewEventsHandler: recheckInterval must be positive")
	}
	return &EventsHandler{hub: hub, credentials: credentials, recheckInterval: recheckInterval}
}

// credentialValid reports whether the stream's credential is still valid. A
// failed check counts as invalid: ending the stream only makes the client
// reconnect, and the reconnect is authenticated afresh.
func (h *EventsHandler) credentialValid(ctx context.Context) bool {
	valid, err := h.credentials.CredentialStillValid(ctx)
	if err != nil {
		if ctx.Err() == nil {
			logutil.FromContext(ctx).WithError(err).Warn("SSE: failed to re-check credential, closing stream")
		}
		return false
	}
	if !valid {
		logutil.FromContext(ctx).Debug("SSE: credential no longer valid, closing stream")
	}
	return valid
}

// ServeSSE is a plain http.HandlerFunc (not the (int, error) pattern) because
// it holds the connection open indefinitely.
func (h *EventsHandler) ServeSSE(w http.ResponseWriter, r *http.Request) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		apierr.Write(w, r, http.StatusUnauthorized, apierr.CodeUnauthorized, "unauthorized")
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		logutil.FromContext(r.Context()).Error("SSE response writer does not support flushing")
		apierr.Write(w, r, http.StatusInternalServerError, apierr.CodeInternal, apierr.InternalMessage)
		return
	}

	// Disable the server's write deadline for this long-lived SSE connection only.
	rc := http.NewResponseController(w)
	if err := rc.SetWriteDeadline(time.Time{}); err != nil {
		logutil.FromContext(r.Context()).WithError(err).Error("Failed to clear SSE write deadline")
		apierr.Write(w, r, http.StatusInternalServerError, apierr.CodeInternal, apierr.InternalMessage)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable nginx proxy buffering

	ch, recheck, unsubscribe := h.hub.Subscribe(r.Context(), user.ID)
	defer unsubscribe()

	// The credential may have been revoked between authentication and
	// Subscribe, when an InvalidateUser call could not reach this stream yet.
	if !h.credentialValid(r.Context()) {
		return
	}

	// Flush the headers immediately so the client knows the connection is open.
	if _, err := fmt.Fprintf(w, ": connected\n\n"); err != nil {
		return
	}
	flusher.Flush()

	h.stream(r.Context(), w, flusher, ch, recheck)
}

// stream writes events to w until the client disconnects, the hub closes ch,
// a write fails, or the stream's credential stops being valid.
func (h *EventsHandler) stream(ctx context.Context, w http.ResponseWriter, flusher http.Flusher, ch <-chan sse.Event, recheck <-chan struct{}) {
	heartbeat := time.NewTicker(sseHeartbeatInterval)
	defer heartbeat.Stop()
	// A stream that outlives its credential keeps receiving the user's events
	// and keeps the client's watchdog satisfied, so it is ended (not muted)
	// and the client's reconnect is refused.
	recheckTicker := time.NewTicker(h.recheckInterval)
	defer recheckTicker.Stop()

	for {
		var frame []byte
		select {
		case <-ctx.Done():
			return
		case event, ok := <-ch:
			if !ok {
				return
			}
			data, err := json.Marshal(event)
			if err != nil {
				logutil.FromContext(ctx).WithError(err).WithField("type", event.Type).Error("Failed to marshal SSE event")
				continue
			}
			frame = fmt.Appendf(nil, "data: %s\n\n", data)
		case <-recheck:
		case <-recheckTicker.C:
		case <-heartbeat.C:
			// Send an empty data event (not an SSE comment) so the client's
			// message listener fires and can reset its liveness watchdog.
			frame = []byte("data:\n\n")
		}
		if frame == nil {
			// Woken by InvalidateUser or the periodic re-check.
			if !h.credentialValid(ctx) {
				return
			}
			continue
		}
		if _, err := w.Write(frame); err != nil {
			return
		}
		flusher.Flush()
	}
}
