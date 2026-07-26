package client

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseSSEEvent(t *testing.T) {
	t.Run("client_id round-trips", func(t *testing.T) {
		raw := []byte(`{"type":"note_updated","source_user_id":"user1","target_user_id":"user2","client_id":"tab-abc123","data":{"note_id":"note1"}}`)

		ev, ok := parseSSEEvent(raw)

		require.True(t, ok)
		assert.Equal(t, "note_updated", ev.Type)
		assert.Equal(t, "user1", ev.SourceUserID)
		assert.Equal(t, "user2", ev.TargetUserID)
		assert.Equal(t, "tab-abc123", ev.ClientID)
		require.NotNil(t, ev.NoteData)
		assert.Equal(t, "note1", ev.NoteData.NoteID)
	})

	t.Run("missing client_id defaults to empty", func(t *testing.T) {
		raw := []byte(`{"type":"note_updated","source_user_id":"user1","data":{"note_id":"note1"}}`)

		ev, ok := parseSSEEvent(raw)

		require.True(t, ok)
		assert.Empty(t, ev.ClientID)
	})
}
