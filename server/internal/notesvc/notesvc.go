// Package notesvc owns the note write operations shared by the REST handlers
// and the MCP tools: validation, the store calls, SSE events, blob cleanup and
// metrics. It also owns the user search both offer for picking share targets
// and assignees. Each transport decodes its own input, calls the service, and shapes
// the result and errors for its client, so a rule changed here applies to both.
//
// Errors are store sentinels (models.Err*), errors marked with apierr.Invalid
// for invalid input, or internal errors. The REST handlers map them to
// statuses with apierr.SentinelStatus. Store errors are returned unwrapped,
// since the callers name the operation (see server/CLAUDE.md); refetchError
// is the one exception.
package notesvc

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/hanzei/jot/server/internal/apierr"
	"github.com/hanzei/jot/server/internal/blobstore"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/notify"
	"github.com/hanzei/jot/server/internal/sse"
	"go.opentelemetry.io/otel/metric"
)

// Service performs note write operations on behalf of a user.
type Service struct {
	noteStore  *models.NoteStore
	labelStore *models.LabelStore
	userStore  *models.UserStore
	imageStore *blobstore.ImageStore
	events     *notify.Publisher

	notesCreated  metric.Int64Counter
	notesUpdated  metric.Int64Counter
	notesDeleted  metric.Int64Counter
	notesRestored metric.Int64Counter
}

// New creates a Service recording its metrics with meter. Returns an error if
// any instrument cannot be created.
func New(noteStore *models.NoteStore, labelStore *models.LabelStore, userStore *models.UserStore, imageStore *blobstore.ImageStore, events *notify.Publisher, meter metric.Meter) (*Service, error) {
	s := &Service{noteStore: noteStore, labelStore: labelStore, userStore: userStore, imageStore: imageStore, events: events}

	for _, c := range []struct {
		dst         *metric.Int64Counter
		name, about string
	}{
		{&s.notesCreated, "notes.created", "Total notes created"},
		{&s.notesUpdated, "notes.updated", "Total notes updated"},
		{&s.notesDeleted, "notes.deleted", "Total notes deleted or moved to trash"},
		{&s.notesRestored, "notes.restored", "Total notes restored from trash"},
	} {
		counter, err := meter.Int64Counter(c.name, metric.WithDescription(c.about))
		if err != nil {
			return nil, fmt.Errorf("create %s instrument: %w", c.name, err)
		}
		*c.dst = counter
	}
	return s, nil
}

// NewItem is a list item supplied with a new note (Create) or a conversion to
// a list (Convert).
type NewItem struct {
	// ID is optional; one is generated when empty.
	ID   string
	Text string
	// Position orders the items; IndentLevel 1 nests an item under the
	// nearest preceding top-level item.
	Position    int
	IndentLevel int
	Completed   bool
}

// NewNote is the input to Create. Zero values take the defaults: a text note
// (a list note when Items are given), the default color, a generated ID.
type NewNote struct {
	ID      string
	Title   string
	Content string
	Type    models.NoteType
	Color   string
	Items   []NewItem
	Labels  []string
	Pinned  bool
}

// Create validates and creates a note with its items, attaches the named
// labels (creating the ones that do not exist yet), and announces it.
func (s *Service) Create(ctx context.Context, userID string, in NewNote) (*models.Note, error) {
	if err := normalizeNewNote(&in); err != nil {
		return nil, err
	}

	labels := models.NormalizeLabelNames(in.Labels)
	if err := s.checkNewLabelNames(ctx, userID, labels); err != nil {
		return nil, err
	}

	items, err := buildItems(in.Items)
	if err != nil {
		return nil, err
	}

	// Create the note and its items atomically so a bad item never leaves an
	// orphaned or partially-populated note behind.
	note, err := s.noteStore.CreateWithItems(ctx, userID, models.NewNote{
		ID:      in.ID,
		Title:   in.Title,
		Content: in.Content,
		Type:    in.Type,
		Color:   in.Color,
		Pinned:  in.Pinned,
	}, items)
	if err != nil {
		return nil, err
	}

	if err = s.attachLabels(ctx, note.ID, userID, labels); err != nil {
		return nil, err
	}

	// CreateWithItems does not read items or labels back; refetch.
	if len(items) > 0 || len(labels) > 0 {
		note, err = s.noteStore.GetByID(ctx, note.ID, userID)
		if err != nil {
			return nil, refetchError("get created note", err)
		}
	}

	s.notesCreated.Add(ctx, 1)
	s.events.NoteToAudience(ctx, note.ID, sse.EventNoteCreated, models.SanitizeNote(*note), userID)
	return note, nil
}

// normalizeNewNote validates in's fields and fills in the type and color
// defaults.
func normalizeNewNote(in *NewNote) error {
	// An empty note is allowed: clients create one when the first thing added
	// to a new note is an image, which needs a note id to attach to.
	if err := models.ValidateNoteTitle(in.Title); err != nil {
		return apierr.Invalid(err)
	}
	if err := models.ValidateNoteContent(in.Content); err != nil {
		return apierr.Invalid(err)
	}
	if len(in.Items) > models.NoteItemsMaxCount {
		return models.ErrNoteItemCapExceeded
	}

	// Items only exist on list notes, so they imply the type.
	switch {
	case len(in.Items) > 0 && in.Type == "":
		in.Type = models.NoteTypeList
	case len(in.Items) > 0 && in.Type != models.NoteTypeList:
		return apierr.Invalid(errors.New("note_type must be 'list' when items are provided"))
	case in.Type == "":
		in.Type = models.NoteTypeText
	}
	if !in.Type.Valid() {
		return apierr.Invalid(fmt.Errorf("note_type must be %q or %q", models.NoteTypeText, models.NoteTypeList))
	}
	if err := models.ValidateNoteTypeFields(in.Type, &in.Title, &in.Content, nil); err != nil {
		return err
	}

	color, err := normalizeColor(in.Color)
	if err != nil {
		return err
	}
	in.Color = color

	if in.ID != "" && !models.IsValidID(in.ID) {
		return apierr.Invalid(errors.New("invalid note ID format"))
	}
	return nil
}

// checkNewLabelNames rejects, before anything is written, a name that is over
// the length limit and does not match an existing label: the one name
// attachLabels would otherwise fail on after the note already exists.
func (s *Service) checkNewLabelNames(ctx context.Context, userID string, names []string) error {
	for _, name := range names {
		lengthErr := models.ValidateLabelName(name)
		if lengthErr == nil {
			continue
		}
		_, err := s.labelStore.GetLabelByName(ctx, userID, name)
		if errors.Is(err, models.ErrLabelNotFoundOrNotOwned) {
			return lengthErr
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// attachLabels attaches the user's labels with the given names to noteID,
// creating the ones that do not exist yet.
func (s *Service) attachLabels(ctx context.Context, noteID, userID string, names []string) error {
	for _, name := range names {
		label, _, err := s.labelStore.GetOrCreateLabel(ctx, userID, name)
		if err != nil {
			return err
		}
		if err = s.noteStore.AddLabelToNote(ctx, noteID, label.ID, userID); err != nil {
			return err
		}
	}
	return nil
}

// buildItems validates items and resolves them into store items. Grouping is
// reconstructed from IndentLevel the way the migration backfill and Jot import
// do it: each indented item attaches to the most recent top-level item by
// position. Items are sorted by position so a parent always precedes its
// children. A parent without an ID gets a generated one here so its children
// can reference it; other items without one are left for the store to fill
// in, which skips the collision check it runs on a supplied ID.
func buildItems(items []NewItem) ([]models.NewNoteItem, error) {
	ordered := slices.Clone(items)
	slices.SortStableFunc(ordered, func(a, b NewItem) int { return cmp.Compare(a.Position, b.Position) })

	built := make([]models.NewNoteItem, 0, len(ordered))
	lastTopLevel := -1 // index into built; -1 when no top-level item precedes
	for _, item := range ordered {
		if err := validateItem(item); err != nil {
			return nil, err
		}

		parentID := ""
		if item.IndentLevel == 1 && lastTopLevel >= 0 {
			parent := &built[lastTopLevel]
			if parent.ID == "" {
				generated, err := models.GenerateID()
				if err != nil {
					return nil, fmt.Errorf("generate item ID: %w", err)
				}
				parent.ID = generated
			}
			parentID = parent.ID
		}

		built = append(built, models.NewNoteItem{
			ID:        item.ID,
			Text:      item.Text,
			Position:  item.Position,
			Completed: item.Completed,
			ParentID:  parentID,
		})

		if item.IndentLevel == 0 {
			lastTopLevel = len(built) - 1
		}
	}
	return built, nil
}

// validateItem checks one item's fields.
func validateItem(item NewItem) error {
	if item.IndentLevel < 0 || item.IndentLevel > 1 {
		return apierr.Invalid(errors.New("indent_level must be 0 or 1"))
	}
	if err := validateItemText(item.Text); err != nil {
		return err
	}
	if item.ID != "" && !models.IsValidID(item.ID) {
		return errInvalidItemID
	}
	return nil
}

// normalizeColor returns color's canonical form, the default for "".
func normalizeColor(color string) (string, error) {
	if color == "" {
		return models.DefaultNoteColor, nil
	}
	normalized, err := models.NormalizeNoteColor(color)
	if err != nil {
		return "", apierr.Invalid(err)
	}
	return normalized, nil
}

// Update applies the set fields of u to the note and announces the change.
// An empty color resets to the default.
func (s *Service) Update(ctx context.Context, noteID, userID string, u models.NoteUpdate) (*models.Note, error) {
	if u.Title != nil {
		if err := models.ValidateNoteTitle(*u.Title); err != nil {
			return nil, apierr.Invalid(err)
		}
	}
	if u.Content != nil {
		if err := models.ValidateNoteContent(*u.Content); err != nil {
			return nil, apierr.Invalid(err)
		}
	}
	if u.Color != nil {
		color, err := normalizeColor(*u.Color)
		if err != nil {
			return nil, err
		}
		u.Color = &color
	}

	note, err := s.noteStore.Update(ctx, noteID, userID, u)
	if err != nil {
		return nil, err
	}

	// Title and content are shared with collaborators, who each get their own
	// copy of the note; the other fields are per-user, so only the caller's
	// sessions need to hear of them. (List items are changed through the item
	// operations, which announce their own changes.)
	s.events.NoteUpdated(ctx, noteID, note, userID, u.Title != nil || u.Content != nil)
	s.notesUpdated.Add(ctx, 1)
	return note, nil
}

// Delete moves a note to the trash or, with permanent, deletes a note that
// is already there, reclaiming its image blobs.
func (s *Service) Delete(ctx context.Context, noteID, userID string, permanent bool) error {
	// Resolve the audience before deleting, while the shares still exist.
	audienceIDs, audienceErr := s.noteStore.GetNoteAudienceIDs(ctx, noteID)

	if permanent {
		shas, err := s.noteStore.DeleteFromTrash(ctx, noteID, userID)
		if err != nil {
			return err
		}
		blobstore.ReclaimOrphaned(ctx, s.noteStore, s.imageStore, shas)
	} else if err := s.noteStore.MoveToTrash(ctx, noteID, userID); err != nil {
		return err
	}

	if audienceErr == nil {
		s.events.NoteDeleted(ctx, noteID, audienceIDs, userID)
	}
	s.notesDeleted.Add(ctx, 1)
	return nil
}

// EmptyTrash permanently deletes every note in the user's trash and returns
// how many there were.
func (s *Service) EmptyTrash(ctx context.Context, userID string) (int, error) {
	deleted, shas, err := s.noteStore.EmptyTrash(ctx, userID)
	if err != nil {
		return 0, err
	}
	blobstore.ReclaimOrphaned(ctx, s.noteStore, s.imageStore, shas)

	for _, note := range deleted {
		s.events.NoteDeleted(ctx, note.NoteID, note.AudienceIDs, userID)
	}
	if len(deleted) > 0 {
		s.notesDeleted.Add(ctx, int64(len(deleted)))
	}
	return len(deleted), nil
}

// Restore moves a note out of the trash and returns it.
func (s *Service) Restore(ctx context.Context, noteID, userID string) (*models.Note, error) {
	if err := s.noteStore.RestoreFromTrash(ctx, noteID, userID); err != nil {
		return nil, err
	}
	note, err := s.noteStore.GetByID(ctx, noteID, userID)
	if err != nil {
		return nil, refetchError("get restored note", err)
	}

	s.notesRestored.Add(ctx, 1)
	// Every collaborator's copy of the note comes back, so each needs its own.
	s.events.NoteUpdated(ctx, noteID, note, userID, true)
	return note, nil
}

// refetchError reports a failure to read back a note the operation already
// changed. It deliberately does not wrap err: a sentinel such as "not found"
// here would tell the client its committed write failed, so the transports
// must see an internal error instead. (err.Error() rather than %v, which
// errorlint rejects for an error.)
func refetchError(op string, err error) error {
	return fmt.Errorf("%s: %s", op, err.Error())
}

// Duplicate copies a note the user can see into a new note they own. newID
// and itemIDs (source item ID to copy ID) are optional client-supplied IDs,
// for idempotent replay.
func (s *Service) Duplicate(ctx context.Context, noteID, userID, newID string, itemIDs map[string]string) (*models.Note, error) {
	if newID != "" && !models.IsValidID(newID) {
		return nil, apierr.Invalid(errors.New("invalid duplicate note ID format"))
	}
	if err := validateDuplicateItemIDs(itemIDs); err != nil {
		return nil, err
	}

	source, err := s.noteStore.GetByID(ctx, noteID, userID)
	if err != nil {
		return nil, err
	}
	note, err := s.noteStore.Duplicate(ctx, source, userID, newID, itemIDs)
	if err != nil {
		return nil, err
	}

	s.events.NoteToAudience(ctx, note.ID, sse.EventNoteCreated, models.SanitizeNote(*note), userID)
	s.notesCreated.Add(ctx, 1)
	return note, nil
}

func validateDuplicateItemIDs(itemIDs map[string]string) error {
	for srcID, newID := range itemIDs {
		if !models.IsValidID(srcID) {
			return apierr.Invalid(errors.New("invalid source item ID format in item_ids"))
		}
		if !models.IsValidID(newID) {
			return apierr.Invalid(errors.New("invalid new item ID format in item_ids"))
		}
	}
	return nil
}

// Conversion is the input to Convert. The transform (splitting text into list
// items, or rendering a list back into text) is computed by the client and
// sent precomputed; the service validates it against the limits on directly
// authored notes. Content applies when converting to text; Title and Items
// when converting to a list.
type Conversion struct {
	Type    models.NoteType
	Content *string
	Title   *string
	Items   []NewItem
	// BaseVersion, when set, rejects the conversion with
	// models.ErrNoteVersionConflict unless the note is still at that version.
	BaseVersion *int
}

// Convert changes a note between text and list and announces the change.
func (s *Service) Convert(ctx context.Context, noteID, userID string, c Conversion) (*models.Note, error) {
	title, content, items, err := resolveConversion(c)
	if err != nil {
		return nil, err
	}

	current, err := s.noteStore.GetByID(ctx, noteID, userID)
	if err != nil {
		return nil, err
	}
	// Only reject a same-type request outright when the caller gave no
	// base_version to check a replay against: a request that arrives after its
	// own earlier attempt already committed (the response was lost and the
	// caller retried) legitimately finds the note converted already. With a
	// base_version, defer to ConvertType, whose version-gated update plus
	// idempotent-replay check (matching type AND content/items, not just type)
	// tells a genuine replay apart from a stale conflicting write.
	if c.BaseVersion == nil && current.NoteType == c.Type {
		return nil, apierr.Invalid(models.ErrNoteTypeUnchanged)
	}

	note, err := s.noteStore.ConvertType(ctx, noteID, userID, c.Type, title, content, items, c.BaseVersion)
	if err != nil {
		return nil, err
	}

	s.events.NoteUpdated(ctx, noteID, note, userID, true)
	s.notesUpdated.Add(ctx, 1)
	return note, nil
}

// resolveConversion validates c and resolves it into the title, content and
// items to persist. Only the fields of the target type are meaningful;
// supplying the others is rejected so a client can't accidentally send a
// stale value for the direction it isn't using.
func resolveConversion(c Conversion) (title, content string, items []models.NewNoteItem, err error) {
	if !c.Type.Valid() {
		return "", "", nil, apierr.Invalid(errors.New("note_type must be 'text' or 'list'"))
	}

	if c.Type == models.NoteTypeList {
		if c.Content != nil {
			return "", "", nil, apierr.Invalid(errors.New("content must not be set when converting to a list"))
		}
		if c.Title != nil {
			title = *c.Title
		}
		if err = models.ValidateNoteTitle(title); err != nil {
			return "", "", nil, apierr.Invalid(err)
		}
		if len(c.Items) > models.NoteItemsMaxCount {
			return "", "", nil, models.ErrNoteItemCapExceeded
		}
		items, err = buildItems(c.Items)
		if err != nil {
			return "", "", nil, err
		}
		return title, "", items, nil
	}

	if len(c.Items) > 0 {
		return "", "", nil, apierr.Invalid(errors.New("items must not be set when converting to text"))
	}
	// A text note has no title, so accepting one here would silently discard it.
	if c.Title != nil {
		return "", "", nil, apierr.Invalid(errors.New("title must not be set when converting to text"))
	}
	if c.Content != nil {
		content = *c.Content
	}
	if err = models.ValidateNoteContent(content); err != nil {
		return "", "", nil, apierr.Invalid(err)
	}
	return "", content, nil, nil
}
