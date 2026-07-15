package main

import (
	"net/http"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestNoteUpdateOptimisticConcurrency covers the base_version optimistic-concurrency
// guard on PATCH /notes/{id} that lets a stale offline edit be detected (409)
// instead of silently overwriting a concurrent change from another device (issue
// #489).
func TestNoteUpdateOptimisticConcurrency(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "concurrencyuser", "password123", false)
	ctx := t.Context()

	t.Run("new note starts at version 1", func(t *testing.T) {
		note, err := user.Client.CreateTextNote(ctx, &client.CreateTextNoteRequest{Content: "v1"})
		require.NoError(t, err)
		assert.Equal(t, 1, note.Version)
	})

	t.Run("content update bumps version", func(t *testing.T) {
		note, err := user.Client.CreateTextNote(ctx, &client.CreateTextNoteRequest{Content: "start"})
		require.NoError(t, err)
		require.Equal(t, 1, note.Version)

		updated, err := user.Client.UpdateTextNote(ctx, note.ID, &client.UpdateTextNoteRequest{
			Content: ptr("changed"),
		})
		require.NoError(t, err)
		assert.Equal(t, 2, updated.Version)
		assert.Equal(t, "changed", updated.Text.Content)
	})

	t.Run("matching base_version succeeds", func(t *testing.T) {
		note, err := user.Client.CreateTextNote(ctx, &client.CreateTextNoteRequest{Content: "base"})
		require.NoError(t, err)

		updated, err := user.Client.UpdateTextNote(ctx, note.ID, &client.UpdateTextNoteRequest{
			Content:     ptr("on top of base"),
			BaseVersion: ptr(note.Version),
		})
		require.NoError(t, err)
		assert.Equal(t, note.Version+1, updated.Version)
		assert.Equal(t, "on top of base", updated.Text.Content)
	})

	t.Run("stale base_version is rejected with 409 and content is preserved", func(t *testing.T) {
		note, err := user.Client.CreateTextNote(ctx, &client.CreateTextNoteRequest{Content: "original"})
		require.NoError(t, err)
		staleVersion := note.Version

		// Another device commits a newer change first, bumping the version.
		winner, err := user.Client.UpdateTextNote(ctx, note.ID, &client.UpdateTextNoteRequest{
			Content: ptr("winner wrote this"),
		})
		require.NoError(t, err)
		require.Equal(t, staleVersion+1, winner.Version)

		// The stale offline edit replays against the original base version.
		_, err = user.Client.UpdateTextNote(ctx, note.ID, &client.UpdateTextNoteRequest{
			Content:     ptr("stale clobber"),
			BaseVersion: ptr(staleVersion),
		})
		require.Error(t, err)
		assert.Equal(t, http.StatusConflict, client.StatusCode(err))

		// The winning write must survive untouched.
		fetched, err := user.Client.GetNote(ctx, note.ID)
		require.NoError(t, err)
		assert.Equal(t, "winner wrote this", fetched.Text.Content)
		assert.Equal(t, winner.Version, fetched.Version)
	})

	t.Run("update without base_version still works (backwards compatible)", func(t *testing.T) {
		note, err := user.Client.CreateTextNote(ctx, &client.CreateTextNoteRequest{Content: "compat"})
		require.NoError(t, err)

		// First content write bumps to v2.
		_, err = user.Client.UpdateTextNote(ctx, note.ID, &client.UpdateTextNoteRequest{Content: ptr("v2")})
		require.NoError(t, err)

		// A versionless write lands as last-write-wins regardless of staleness.
		updated, err := user.Client.UpdateTextNote(ctx, note.ID, &client.UpdateTextNoteRequest{Content: ptr("v3")})
		require.NoError(t, err)
		assert.Equal(t, "v3", updated.Text.Content)
		assert.Equal(t, 3, updated.Version)
	})

	t.Run("resending identical content does not bump the version", func(t *testing.T) {
		note, err := user.Client.CreateTextNote(ctx, &client.CreateTextNoteRequest{Content: "same"})
		require.NoError(t, err)
		require.Equal(t, 1, note.Version)

		// An autosave/retry that resends the unchanged content must not bump the
		// version, or it would invalidate other devices' base_version for no reason.
		updated, err := user.Client.UpdateTextNote(ctx, note.ID, &client.UpdateTextNoteRequest{
			Content:     ptr("same"),
			BaseVersion: ptr(note.Version),
		})
		require.NoError(t, err)
		assert.Equal(t, 1, updated.Version)
	})

	t.Run("per-user-only update does not change the content version", func(t *testing.T) {
		note, err := user.Client.CreateTextNote(ctx, &client.CreateTextNoteRequest{Content: "peruser"})
		require.NoError(t, err)
		require.Equal(t, 1, note.Version)

		// Pinning is a per-user field (note_user_state), so it must not bump the
		// shared content version that other collaborators' edits are gated on.
		updated, err := user.Client.UpdateTextNote(ctx, note.ID, &client.UpdateTextNoteRequest{
			Pinned: ptr(true),
		})
		require.NoError(t, err)
		assert.Equal(t, 1, updated.Version)
		assert.True(t, updated.Pinned)
	})
}
