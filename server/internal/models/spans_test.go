package models

import (
	"io"
	"testing"
	"time"

	"github.com/hanzei/jot/server/internal/logutil"
	"github.com/sirupsen/logrus"
	logtest "github.com/sirupsen/logrus/hooks/test"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel/attribute"
)

func TestStartSpanSlowOperationLog(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name      string
		threshold time.Duration
		sleep     time.Duration
		wantLog   bool
	}{
		{"slower than threshold", time.Millisecond, 5 * time.Millisecond, true},
		{"faster than threshold", time.Hour, 0, false},
		{"threshold zero disables", 0, 5 * time.Millisecond, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			logger := logrus.New()
			logger.SetOutput(io.Discard)
			hook := logtest.NewLocal(logger)
			ctx := logutil.NewContext(t.Context(), logutil.NewRequestLogger(logger.WithField("request_id", "req-1")))

			_, end := startSpan(ctx, newInstrumentation(tc.threshold), "FakeStore.Op", nil,
				attribute.String("note.content", "secret"),
			)
			time.Sleep(tc.sleep)
			end()

			if !tc.wantLog {
				assert.Empty(t, hook.AllEntries())
				return
			}
			require.Len(t, hook.AllEntries(), 1)
			entry := hook.LastEntry()
			assert.Equal(t, logrus.WarnLevel, entry.Level)
			assert.Equal(t, "Slow store operation", entry.Message)
			duration, err := time.ParseDuration(entry.Data["duration"].(string))
			require.NoError(t, err)
			assert.GreaterOrEqual(t, duration, tc.sleep)
			delete(entry.Data, "duration")
			// Exactly these fields: span attributes can carry note content and
			// must never reach the log.
			assert.Equal(t, logrus.Fields{"request_id": "req-1", "op": "FakeStore.Op"}, entry.Data)
		})
	}
}
