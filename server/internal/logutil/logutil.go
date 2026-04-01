package logutil

import (
	"context"

	"github.com/sirupsen/logrus"
)

type contextKey struct{}

// RequestLogger holds a logrus entry that is stored in request context.
// AddField permanently enriches the shared logger (used by middleware to attach
// request-scoped metadata such as user_id). WithField/WithFields/WithError return
// derived loggers without mutating the shared entry, so per-call fields like
// error and status_code do not leak into the final "request completed" log line.
type RequestLogger struct {
	entry *logrus.Entry
}

// NewRequestLogger wraps an existing entry.
func NewRequestLogger(entry *logrus.Entry) *RequestLogger {
	return &RequestLogger{entry: entry}
}

// AddField permanently enriches the shared logger in-place.
// Use this in middleware to attach request-scoped metadata (e.g. user_id)
// that should appear on every subsequent log line for this request.
func (rl *RequestLogger) AddField(key string, value any) {
	rl.entry = rl.entry.WithField(key, value)
}

// WithField returns a derived logger with the given field added.
// The shared logger is not mutated.
func (rl *RequestLogger) WithField(key string, value any) *RequestLogger {
	return &RequestLogger{entry: rl.entry.WithField(key, value)}
}

// WithFields returns a derived logger with the given fields added.
// The shared logger is not mutated.
func (rl *RequestLogger) WithFields(fields logrus.Fields) *RequestLogger {
	return &RequestLogger{entry: rl.entry.WithFields(fields)}
}

// WithError returns a derived logger with the error field added.
// The shared logger is not mutated.
func (rl *RequestLogger) WithError(err error) *RequestLogger {
	return &RequestLogger{entry: rl.entry.WithError(err)}
}

func (rl *RequestLogger) Debug(args ...any) { rl.entry.Debug(args...) }
func (rl *RequestLogger) Info(args ...any)  { rl.entry.Info(args...) }
func (rl *RequestLogger) Warn(args ...any)  { rl.entry.Warn(args...) }
func (rl *RequestLogger) Error(args ...any) { rl.entry.Error(args...) }

func (rl *RequestLogger) Debugf(format string, args ...any) { rl.entry.Debugf(format, args...) }
func (rl *RequestLogger) Infof(format string, args ...any)  { rl.entry.Infof(format, args...) }
func (rl *RequestLogger) Warnf(format string, args ...any)  { rl.entry.Warnf(format, args...) }
func (rl *RequestLogger) Errorf(format string, args ...any) { rl.entry.Errorf(format, args...) }

// NewContext stores rl in ctx.
func NewContext(ctx context.Context, rl *RequestLogger) context.Context {
	return context.WithValue(ctx, contextKey{}, rl)
}

// FromContext retrieves the RequestLogger from ctx. If none is present it
// returns a logger backed by the global logrus standard logger, so background
// goroutines and startup code work without nil guards.
func FromContext(ctx context.Context) *RequestLogger {
	if rl, ok := ctx.Value(contextKey{}).(*RequestLogger); ok {
		return rl
	}
	return &RequestLogger{entry: logrus.NewEntry(logrus.StandardLogger())}
}
