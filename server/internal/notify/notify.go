// Package notify publishes the SSE events that follow a note or label write.
//
// Every write surface — the REST handlers and the MCP server — goes through a
// Publisher, so a change reaches open webapp and mobile clients the same way
// whichever surface made it. Publishing is best-effort: failures are logged and
// never fail the write that triggered them.
package notify

import (
	"context"

	"github.com/hanzei/jot/server/internal/logutil"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/sse"
)

// Publisher fans note and label changes out to the SSE hub. A Publisher with a
// nil hub is valid and publishes nothing.
type Publisher struct {
	hub       *sse.Hub
	noteStore *models.NoteStore
}

// New returns a Publisher that resolves note audiences through noteStore.
func New(hub *sse.Hub, noteStore *models.NoteStore) *Publisher {
	return &Publisher{hub: hub, noteStore: noteStore}
}

func (p *Publisher) publish(ctx context.Context, userIDs []string, eventType sse.EventType, sourceUserID string, data any) {
	p.hub.Publish(ctx, userIDs, sse.Event{
		Type:         eventType,
		SourceUserID: sourceUserID,
		ClientID:     sse.ClientIDFromContext(ctx),
		Data:         data,
	})
}

// NoteToAudience sends the same note payload to everyone with access to the
// note. Used for creates, where no audience member has per-user state yet.
func (p *Publisher) NoteToAudience(ctx context.Context, noteID string, eventType sse.EventType, note any, sourceUserID string) {
	if p.hub == nil {
		return
	}
	audienceIDs, err := p.noteStore.GetNoteAudienceIDs(ctx, noteID)
	if err != nil {
		logutil.FromContext(ctx).WithError(err).WithField("note_id", noteID).Error("Failed to get note audience for SSE publish")
		return
	}
	p.publish(ctx, audienceIDs, eventType, sourceUserID, sse.NoteEventData{NoteID: noteID, Note: note})
}

// PersonalizedNote fetches each audience member's personalized view of a note
// and sends them an individual event. Used when shared fields (title, content,
// items) change so every collaborator receives the update with their own
// per-user state intact.
func (p *Publisher) PersonalizedNote(ctx context.Context, noteID string, audienceIDs []string, sourceUserID string, eventType sse.EventType) {
	if p.hub == nil {
		return
	}
	for _, uid := range audienceIDs {
		n, err := p.noteStore.GetByID(ctx, noteID, uid)
		if err != nil {
			logutil.FromContext(ctx).WithError(err).WithField("note_id", noteID).WithField("user_id", uid).Warn("Failed to fetch personalized note for SSE publish")
			continue
		}
		p.publish(ctx, []string{uid}, eventType, sourceUserID, sse.NoteEventData{NoteID: noteID, Note: models.SanitizeNote(*n)})
	}
}

// NoteUpdated sends note_updated after a note change. If shared fields changed,
// every collaborator gets a personalized event (note is ignored); otherwise
// only the acting user is notified, with note as the payload.
func (p *Publisher) NoteUpdated(ctx context.Context, noteID string, note *models.Note, userID string, sharedFieldChanged bool) {
	if p.hub == nil {
		return
	}
	if sharedFieldChanged {
		audienceIDs, err := p.noteStore.GetNoteAudienceIDs(ctx, noteID)
		if err != nil {
			logutil.FromContext(ctx).WithError(err).WithField("note_id", noteID).Error("Failed to get note audience for SSE publish")
			return
		}
		p.PersonalizedNote(ctx, noteID, audienceIDs, userID, sse.EventNoteUpdated)
		return
	}
	var payload any
	if note != nil {
		payload = models.SanitizeNote(*note)
	}
	p.publish(ctx, []string{userID}, sse.EventNoteUpdated, userID, sse.NoteEventData{NoteID: noteID, Note: payload})
}

// NoteDeleted sends note_deleted to audienceIDs, which the caller must resolve
// before the delete (afterwards the shares are gone).
func (p *Publisher) NoteDeleted(ctx context.Context, noteID string, audienceIDs []string, sourceUserID string) {
	if p.hub == nil || len(audienceIDs) == 0 {
		return
	}
	p.publish(ctx, audienceIDs, sse.EventNoteDeleted, sourceUserID, sse.NoteEventData{NoteID: noteID})
}

// LabelsChanged tells the user's other sessions that a label was created.
func (p *Publisher) LabelsChanged(ctx context.Context, userID string, label *models.Label) {
	if p.hub == nil {
		return
	}
	p.publish(ctx, []string{userID}, sse.EventLabelsChanged, userID, sse.LabelsEventData{Label: label})
}

// LabelNoteUpdates sends note_updated for every note a renamed or deleted label
// was attached to. Labels are per-user, so only the acting user's view changes
// and only they are notified.
func (p *Publisher) LabelNoteUpdates(ctx context.Context, noteIDs []string, userID string) {
	if p.hub == nil {
		return
	}
	for _, noteID := range noteIDs {
		note, err := p.noteStore.GetByIDAnyState(ctx, noteID, userID)
		if err != nil {
			continue
		}
		p.publish(ctx, []string{userID}, sse.EventNoteUpdated, userID, sse.NoteEventData{NoteID: noteID, Note: models.SanitizeNote(*note)})
	}
}
