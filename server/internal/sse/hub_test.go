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
		ch, _, unsub := h.Subscribe(t.Context(), "user1")

		require.NotNil(t, ch)
		require.NotNil(t, unsub)
	})

	t.Run("multiple subscribers for same user each get their own channel", func(t *testing.T) {
		h, err := NewHub()
		require.NoError(t, err)
		ch1, _, _ := h.Subscribe(t.Context(), "user1")
		ch2, _, _ := h.Subscribe(t.Context(), "user1")

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
		_, _, unsub := h.Subscribe(t.Context(), "user1")

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
		_, _, unsub1 := h.Subscribe(t.Context(), "user1")
		_, _, _ = h.Subscribe(t.Context(), "user1")

		unsub1()

		h.mu.RLock()
		assert.Len(t, h.clients["user1"], 1, "one subscriber should remain")
		h.mu.RUnlock()
	})

	t.Run("closed channel is readable and reflects no pending events", func(t *testing.T) {
		h, err := NewHub()
		require.NoError(t, err)
		ch, _, unsub := h.Subscribe(t.Context(), "user1")
		unsub()

		// Channel should be closed; reading from it should return zero value immediately.
		_, ok := <-ch
		assert.False(t, ok, "closed channel should return ok=false")
	})
}

func TestHubPublish(t *testing.T) {
	event := Event{
		Type:         EventNoteCreated,
		SourceUserID: "user1",
		Data:         NoteEventData{NoteID: "note1"},
	}

	t.Run("delivers event to subscribed user", func(t *testing.T) {
		h, err := NewHub()
		require.NoError(t, err)
		ch, _, unsub := h.Subscribe(t.Context(), "user1")
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
		ch1, _, unsub1 := h.Subscribe(t.Context(), "user1")
		ch2, _, unsub2 := h.Subscribe(t.Context(), "user1")
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
		ch1, _, unsub1 := h.Subscribe(t.Context(), "user1")
		ch2, _, unsub2 := h.Subscribe(t.Context(), "user2")
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
		ch, _, unsub := h.Subscribe(t.Context(), "user1")
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
}

func TestHubEviction(t *testing.T) {
	event := Event{
		Type:         EventNoteCreated,
		SourceUserID: "user1",
		Data:         NoteEventData{NoteID: "note1"},
	}

	t.Run("evicts a subscriber whose buffer is full without blocking", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			h, err := NewHub()
			require.NoError(t, err)
			slow, _, unsubSlow := h.Subscribe(t.Context(), "user1")
			defer unsubSlow()
			fast, _, unsubFast := h.Subscribe(t.Context(), "user1")
			defer unsubFast()

			for range subscriberBufferSize {
				h.Publish(t.Context(), []string{"user1"}, event)
				<-fast // keep the other subscriber drained
			}

			// The overflowing publish must not block.
			done := make(chan struct{})
			go func() {
				h.Publish(t.Context(), []string{"user1"}, event)
				close(done)
			}()
			synctest.Wait()
			select {
			case <-done:
			default:
				t.Fatal("Publish blocked on full channel")
			}

			// The slow subscriber's backlog is discarded (its client resyncs
			// in full on reconnect), so its channel reads as closed at once.
			_, ok := <-slow
			assert.False(t, ok, "slow subscriber's channel should be closed with nothing left buffered")

			// The healthy subscriber is unaffected and stays registered.
			got, ok := <-fast
			require.True(t, ok)
			assert.Equal(t, event, got)
			assert.Equal(t, 1, h.SubscriberCount())

			// Publishing again neither panics on the closed channel nor
			// reaches the evicted subscriber.
			h.Publish(t.Context(), []string{"user1"}, event)
			<-fast
		})
	})

	t.Run("unsubscribe after eviction does not double-close", func(t *testing.T) {
		h, err := NewHub()
		require.NoError(t, err)
		_, _, unsub := h.Subscribe(t.Context(), "user1")
		for range subscriberBufferSize + 1 {
			h.Publish(t.Context(), []string{"user1"}, event)
		}
		assert.NotPanics(t, unsub)
		h.mu.RLock()
		_, present := h.clients["user1"]
		h.mu.RUnlock()
		assert.False(t, present)
	})

	t.Run("Close after eviction does not double-close", func(t *testing.T) {
		h, err := NewHub()
		require.NoError(t, err)
		_, _, unsub := h.Subscribe(t.Context(), "user1")
		for range subscriberBufferSize + 1 {
			h.Publish(t.Context(), []string{"user1"}, event)
		}
		assert.NotPanics(t, h.Close)
		assert.NotPanics(t, unsub)
	})
}

func TestHub(t *testing.T) {
	t.Run("Close", func(t *testing.T) {
		t.Run("closes all subscriber channels", func(t *testing.T) {
			h, err := NewHub()
			require.NoError(t, err)
			ch1, _, _ := h.Subscribe(t.Context(), "user1")
			ch2, _, _ := h.Subscribe(t.Context(), "user1")
			ch3, _, _ := h.Subscribe(t.Context(), "user2")

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
			_, _, _ = h.Subscribe(t.Context(), "user1")

			// Should not panic when called multiple times.
			h.Close()
			h.Close()
		})

		t.Run("unsubscribe after Close does not panic", func(t *testing.T) {
			h, err := NewHub()
			require.NoError(t, err)
			_, _, unsub := h.Subscribe(t.Context(), "user1")

			h.Close()

			// Should not panic — hub already closed the channel.
			assert.NotPanics(t, unsub)
		})

		t.Run("Subscribe after Close returns a closed channel and no-op unsubscribe", func(t *testing.T) {
			h, err := NewHub()
			require.NoError(t, err)
			h.Close()

			// A connection that races the shutdown must not block forever: the
			// channel is already closed so the caller's read loop exits, and the
			// subscription is never registered on the hub.
			ch, _, unsub := h.Subscribe(t.Context(), "user1")
			_, ok := <-ch
			assert.False(t, ok, "channel should be closed")

			h.mu.RLock()
			_, exists := h.clients["user1"]
			h.mu.RUnlock()
			assert.False(t, exists, "late subscriber must not be registered")

			assert.NotPanics(t, unsub, "no-op unsubscribe must not panic")
		})
	})
}

func TestHub_ConcurrentAccess(t *testing.T) {
	t.Run("concurrent Publish and Close do not race or panic", func(t *testing.T) {
		h, err := NewHub()
		require.NoError(t, err)
		_, _, _ = h.Subscribe(t.Context(), "user1")

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
			wg.Go(func() {
				ch, _, unsub := h.Subscribe(t.Context(), "user1")
				h.Publish(t.Context(), []string{"user1"}, Event{Type: EventNoteUpdated, SourceUserID: "u1", Data: NoteEventData{NoteID: "n1"}})
				// Drain any delivered event so the channel doesn't block unsubscribe.
				select {
				case <-ch:
				default:
				}
				unsub()
			})
		}

		// Separate goroutines only publishing.
		for range 5 {
			wg.Go(func() {
				h.Publish(t.Context(), []string{"user1", "user2"}, Event{Type: EventNoteDeleted, SourceUserID: "u2", Data: NoteEventData{NoteID: "n2"}})
			})
		}

		wg.Wait()
	})
}

func TestHubInvalidateUser(t *testing.T) {
	t.Run("signals every stream of that user and no other", func(t *testing.T) {
		h, err := NewHub()
		require.NoError(t, err)
		_, recheck1, unsub1 := h.Subscribe(t.Context(), "user1")
		defer unsub1()
		_, recheck2, unsub2 := h.Subscribe(t.Context(), "user1")
		defer unsub2()
		_, other, unsubOther := h.Subscribe(t.Context(), "user2")
		defer unsubOther()

		h.InvalidateUser("user1")

		for _, ch := range []<-chan struct{}{recheck1, recheck2} {
			select {
			case <-ch:
			default:
				t.Fatal("expected a recheck signal")
			}
		}
		select {
		case <-other:
			t.Fatal("another user's stream must not be signaled")
		default:
		}
	})

	t.Run("coalesces repeated signals without blocking", func(t *testing.T) {
		h, err := NewHub()
		require.NoError(t, err)
		_, recheck, unsub := h.Subscribe(t.Context(), "user1")
		defer unsub()

		h.InvalidateUser("user1")
		h.InvalidateUser("user1")

		<-recheck
		select {
		case <-recheck:
			t.Fatal("pending signals should coalesce into one")
		default:
		}
	})

	t.Run("is a no-op for unknown users, after unsubscribe, eviction and Close", func(t *testing.T) {
		h, err := NewHub()
		require.NoError(t, err)
		assert.NotPanics(t, func() { h.InvalidateUser("nobody") })

		_, _, unsub := h.Subscribe(t.Context(), "user1")
		unsub()
		assert.NotPanics(t, func() { h.InvalidateUser("user1") })

		_, _, unsubEvicted := h.Subscribe(t.Context(), "user1")
		defer unsubEvicted()
		for range subscriberBufferSize + 1 {
			h.Publish(t.Context(), []string{"user1"}, Event{Type: EventNoteCreated})
		}
		assert.NotPanics(t, func() { h.InvalidateUser("user1") })

		_, _, unsubClosed := h.Subscribe(t.Context(), "user1")
		h.Close()
		assert.NotPanics(t, func() { h.InvalidateUser("user1") })
		assert.NotPanics(t, unsubClosed)
	})

	t.Run("races with unsubscribe, eviction and Close without panicking", func(t *testing.T) {
		h, err := NewHub()
		require.NoError(t, err)
		var wg sync.WaitGroup
		for range 10 {
			wg.Go(func() {
				_, _, unsub := h.Subscribe(t.Context(), "user1")
				h.InvalidateUser("user1")
				unsub()
			})
			wg.Go(func() {
				for range subscriberBufferSize + 1 {
					h.Publish(t.Context(), []string{"user1"}, Event{Type: EventNoteCreated})
				}
			})
			wg.Go(func() { h.InvalidateUser("user1") })
		}
		wg.Go(h.Close)
		wg.Wait()
	})
}
