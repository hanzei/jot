package sse

import (
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHub_Subscribe(t *testing.T) {
	t.Run("returns readable channel and unsubscribe func", func(t *testing.T) {
		h := NewHub()
		ch, unsub := h.Subscribe("user1")

		require.NotNil(t, ch)
		require.NotNil(t, unsub)
	})

	t.Run("multiple subscribers for same user each get their own channel", func(t *testing.T) {
		h := NewHub()
		ch1, _ := h.Subscribe("user1")
		ch2, _ := h.Subscribe("user1")

		assert.NotEqual(t, ch1, ch2)

		h.mu.RLock()
		assert.Len(t, h.clients["user1"], 2)
		h.mu.RUnlock()
	})
}

func TestHub_Unsubscribe(t *testing.T) {
	t.Run("removes channel and closes it", func(t *testing.T) {
		h := NewHub()
		_, unsub := h.Subscribe("user1")

		unsub()

		// Channel should be closed
		h.mu.RLock()
		_, exists := h.clients["user1"]
		h.mu.RUnlock()
		assert.False(t, exists, "user key should be removed when no subscribers remain")
	})

	t.Run("removes only the unsubscribed channel when multiple exist", func(t *testing.T) {
		h := NewHub()
		_, unsub1 := h.Subscribe("user1")
		_, _ = h.Subscribe("user1")

		unsub1()

		h.mu.RLock()
		assert.Len(t, h.clients["user1"], 1, "one subscriber should remain")
		h.mu.RUnlock()
	})

	t.Run("closed channel is readable and reflects no pending events", func(t *testing.T) {
		h := NewHub()
		ch, unsub := h.Subscribe("user1")
		unsub()

		// Channel should be closed; reading from it should return zero value immediately.
		_, ok := <-ch
		assert.False(t, ok, "closed channel should return ok=false")
	})
}

func TestHub_Publish(t *testing.T) {
	event := Event{
		Type:         EventNoteCreated,
		NoteID:       "note1",
		SourceUserID: "user1",
	}

	t.Run("delivers event to subscribed user", func(t *testing.T) {
		h := NewHub()
		ch, unsub := h.Subscribe("user1")
		defer unsub()

		h.Publish([]string{"user1"}, event)

		select {
		case got := <-ch:
			assert.Equal(t, event, got)
		default:
			t.Fatal("expected event in channel but got none")
		}
	})

	t.Run("delivers event to all channels of a user", func(t *testing.T) {
		h := NewHub()
		ch1, unsub1 := h.Subscribe("user1")
		ch2, unsub2 := h.Subscribe("user1")
		defer unsub1()
		defer unsub2()

		h.Publish([]string{"user1"}, event)

		select {
		case got := <-ch1:
			assert.Equal(t, event, got)
		default:
			t.Fatal("expected event in ch1 but got none")
		}

		select {
		case got := <-ch2:
			assert.Equal(t, event, got)
		default:
			t.Fatal("expected event in ch2 but got none")
		}
	})

	t.Run("delivers event to multiple different users", func(t *testing.T) {
		h := NewHub()
		ch1, unsub1 := h.Subscribe("user1")
		ch2, unsub2 := h.Subscribe("user2")
		defer unsub1()
		defer unsub2()

		h.Publish([]string{"user1", "user2"}, event)

		select {
		case got := <-ch1:
			assert.Equal(t, event, got)
		default:
			t.Fatal("expected event in ch1 but got none")
		}

		select {
		case got := <-ch2:
			assert.Equal(t, event, got)
		default:
			t.Fatal("expected event in ch2 but got none")
		}
	})

	t.Run("skips users with no subscribers", func(t *testing.T) {
		h := NewHub()
		ch, unsub := h.Subscribe("user1")
		defer unsub()

		// Publish to user1 and a non-subscribed user; should not panic or block.
		h.Publish([]string{"user1", "nobody"}, event)

		select {
		case got := <-ch:
			assert.Equal(t, event, got)
		default:
			t.Fatal("expected event in channel but got none")
		}
	})

	t.Run("drops events without blocking when channel buffer is full", func(t *testing.T) {
		h := NewHub()
		ch, unsub := h.Subscribe("user1")
		defer unsub()

		// Fill the channel buffer (capacity 16).
		for range 16 {
			h.Publish([]string{"user1"}, event)
		}

		// This 17th publish must not block.
		done := make(chan struct{})
		go func() {
			h.Publish([]string{"user1"}, event)
			close(done)
		}()

		// Wait for the goroutine with a timeout; drain one buffered event first
		// to give Publish room to proceed if it ended up in the default branch.
		select {
		case <-done:
			// good — did not block
		case <-time.After(2 * time.Second):
			t.Fatal("Publish blocked: channel was not full or took too long to return")
		default:
			// The goroutine has not finished yet; drain one buffered slot and
			// wait again with a generous timeout so the goroutine can proceed.
			select {
			case <-ch:
			case <-time.After(2 * time.Second):
				t.Fatal("timed out draining event from full channel")
			}
			select {
			case <-done:
				// good
			case <-time.After(2 * time.Second):
				t.Fatal("Publish did not return after draining a slot from the full channel")
			}
		}
	})
}

func TestHub_ConcurrentAccess(t *testing.T) {
	t.Run("concurrent subscribe, publish, and unsubscribe do not race", func(t *testing.T) {
		h := NewHub()
		var wg sync.WaitGroup

		// Multiple goroutines subscribing and unsubscribing.
		for range 10 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				ch, unsub := h.Subscribe("user1")
				h.Publish([]string{"user1"}, Event{Type: EventNoteUpdated, NoteID: "n1", SourceUserID: "u1"})
				// Drain any delivered event so the channel doesn't block unsubscribe.
				select {
				case <-ch:
				default:
				}
				unsub()
			}()
		}

		// Separate goroutines only publishing.
		for range 5 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				h.Publish([]string{"user1", "user2"}, Event{Type: EventNoteDeleted, NoteID: "n2", SourceUserID: "u2"})
			}()
		}

		wg.Wait()
	})
}
