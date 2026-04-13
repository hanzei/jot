package sse

import (
	"sync"
	"testing"
	"testing/synctest"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHub_Subscribe(t *testing.T) {
	t.Run("returns readable channel and unsubscribe func", func(t *testing.T) {
		h, err := NewHub()
		require.NoError(t, err)
		ch, unsub := h.Subscribe(t.Context(), "user1")

		require.NotNil(t, ch)
		require.NotNil(t, unsub)
	})

	t.Run("multiple subscribers for same user each get their own channel", func(t *testing.T) {
		h, err := NewHub()
		require.NoError(t, err)
		ch1, _ := h.Subscribe(t.Context(), "user1")
		ch2, _ := h.Subscribe(t.Context(), "user1")

		assert.NotEqual(t, ch1, ch2)

		h.mu.RLock()
		assert.Len(t, h.clients["user1"], 2)
		h.mu.RUnlock()
	})
}

func TestHub_Unsubscribe(t *testing.T) {
	t.Run("removes channel and closes it", func(t *testing.T) {
		h, err := NewHub()
		require.NoError(t, err)
		_, unsub := h.Subscribe(t.Context(), "user1")

		unsub()

		// Channel should be closed
		h.mu.RLock()
		_, exists := h.clients["user1"]
		h.mu.RUnlock()
		assert.False(t, exists, "user key should be removed when no subscribers remain")
	})

	t.Run("removes only the unsubscribed channel when multiple exist", func(t *testing.T) {
		h, err := NewHub()
		require.NoError(t, err)
		_, unsub1 := h.Subscribe(t.Context(), "user1")
		_, _ = h.Subscribe(t.Context(), "user1")

		unsub1()

		h.mu.RLock()
		assert.Len(t, h.clients["user1"], 1, "one subscriber should remain")
		h.mu.RUnlock()
	})

	t.Run("closed channel is readable and reflects no pending events", func(t *testing.T) {
		h, err := NewHub()
		require.NoError(t, err)
		ch, unsub := h.Subscribe(t.Context(), "user1")
		unsub()

		// Channel should be closed; reading from it should return zero value immediately.
		_, ok := <-ch
		assert.False(t, ok, "closed channel should return ok=false")
	})
}

func TestHub_Publish(t *testing.T) {
	event := Event{
		Type:         EventNoteCreated,
		SourceUserID: "user1",
		Data:         NoteEventData{NoteID: "note1"},
	}

	t.Run("delivers event to subscribed user", func(t *testing.T) {
		h, err := NewHub()
		require.NoError(t, err)
		ch, unsub := h.Subscribe(t.Context(), "user1")
		defer unsub()

		h.Publish(t.Context(), []string{"user1"}, event)

		select {
		case got := <-ch:
			assert.Equal(t, event, got)
		default:
			t.Fatal("expected event in channel but got none")
		}
	})

	t.Run("delivers event to all channels of a user", func(t *testing.T) {
		h, err := NewHub()
		require.NoError(t, err)
		ch1, unsub1 := h.Subscribe(t.Context(), "user1")
		ch2, unsub2 := h.Subscribe(t.Context(), "user1")
		defer unsub1()
		defer unsub2()

		h.Publish(t.Context(), []string{"user1"}, event)

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
		h, err := NewHub()
		require.NoError(t, err)
		ch1, unsub1 := h.Subscribe(t.Context(), "user1")
		ch2, unsub2 := h.Subscribe(t.Context(), "user2")
		defer unsub1()
		defer unsub2()

		h.Publish(t.Context(), []string{"user1", "user2"}, event)

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
		h, err := NewHub()
		require.NoError(t, err)
		ch, unsub := h.Subscribe(t.Context(), "user1")
		defer unsub()

		// Publish to user1 and a non-subscribed user; should not panic or block.
		h.Publish(t.Context(), []string{"user1", "nobody"}, event)

		select {
		case got := <-ch:
			assert.Equal(t, event, got)
		default:
			t.Fatal("expected event in channel but got none")
		}
	})

	t.Run("drops events without blocking when channel buffer is full", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			h, err := NewHub()
			require.NoError(t, err)
			_, unsub := h.Subscribe(t.Context(), "user1")
			defer unsub()

			// Fill the channel buffer (capacity 16).
			for range 16 {
				h.Publish(t.Context(), []string{"user1"}, event)
			}

			// 17th publish must not block; Publish uses a non-blocking select internally.
			done := make(chan struct{})
			go func() {
				h.Publish(t.Context(), []string{"user1"}, event)
				close(done)
			}()

			// Block until all goroutines in the bubble are idle.
			synctest.Wait()

			select {
			case <-done:
				// good — Publish returned without blocking
			default:
				t.Fatal("Publish blocked on full channel")
			}
		})
	})
}

func TestHub(t *testing.T) {
	t.Run("Close", func(t *testing.T) {
		t.Run("closes all subscriber channels", func(t *testing.T) {
			h, err := NewHub()
			require.NoError(t, err)
			ch1, _ := h.Subscribe(t.Context(), "user1")
			ch2, _ := h.Subscribe(t.Context(), "user1")
			ch3, _ := h.Subscribe(t.Context(), "user2")

			h.Close()

			_, ok := <-ch1
			assert.False(t, ok, "ch1 should be closed")
			_, ok = <-ch2
			assert.False(t, ok, "ch2 should be closed")
			_, ok = <-ch3
			assert.False(t, ok, "ch3 should be closed")
		})

		t.Run("is idempotent", func(t *testing.T) {
			h, err := NewHub()
			require.NoError(t, err)
			_, _ = h.Subscribe(t.Context(), "user1")

			// Should not panic when called multiple times.
			h.Close()
			h.Close()
		})

		t.Run("unsubscribe after Close does not panic", func(t *testing.T) {
			h, err := NewHub()
			require.NoError(t, err)
			_, unsub := h.Subscribe(t.Context(), "user1")

			h.Close()

			// Should not panic — hub already closed the channel.
			assert.NotPanics(t, unsub)
		})
	})
}

func TestHub_ConcurrentAccess(t *testing.T) {
	t.Run("concurrent Publish and Close do not race or panic", func(t *testing.T) {
		h, err := NewHub()
		require.NoError(t, err)
		_, _ = h.Subscribe(t.Context(), "user1")

		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			h.Close()
		}()
		go func() {
			defer wg.Done()
			h.Publish(t.Context(), []string{"user1"}, Event{Type: EventNoteCreated, SourceUserID: "u1"})
		}()
		wg.Wait()
	})

	t.Run("concurrent subscribe, publish, and unsubscribe do not race", func(t *testing.T) {
		h, err := NewHub()
		require.NoError(t, err)
		var wg sync.WaitGroup

		// Multiple goroutines subscribing and unsubscribing.
		for range 10 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				ch, unsub := h.Subscribe(t.Context(), "user1")
			h.Publish(t.Context(), []string{"user1"}, Event{Type: EventNoteUpdated, SourceUserID: "u1", Data: NoteEventData{NoteID: "n1"}})
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
			h.Publish(t.Context(), []string{"user1", "user2"}, Event{Type: EventNoteDeleted, SourceUserID: "u2", Data: NoteEventData{NoteID: "n2"}})
			}()
		}

		wg.Wait()
	})
}
