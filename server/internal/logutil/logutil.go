package logutil

import (
	"context"

	"github.com/sirupsen/logrus"
)

type contextKey struct{}

// RequestLogger is a mutable logger holder stored in request context.
// Storing it as a pointer means inner middleware can enrich it and the
// outer request-logger middleware sees the updated entry after next returns.
type RequestLogger struct {
	entry *logrus.Entry
}

// NewRequestLogger wraps an existing entry.
func NewRequestLogger(entry *logrus.Entry) *RequestLogger {
	return &RequestLogger{entry: entry}
}

// WithField enriches the logger in-place and returns rl for chaining.
func (rl *RequestLogger) WithField(key string, value any) *RequestLogger {
	rl.entry = rl.entry.WithField(key, value)
	return rl
}

// WithFields enriches the logger in-place and returns rl for chaining.
func (rl *RequestLogger) WithFields(fields logrus.Fields) *RequestLogger {
	rl.entry = rl.entry.WithFields(fields)
	return rl
}

// WithError enriches the logger in-place and returns rl for chaining.
func (rl *RequestLogger) WithError(err error) *RequestLogger {
	rl.entry = rl.entry.WithError(err)
	return rl
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
