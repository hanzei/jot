package models

import (
	"errors"
	"fmt"
	"go/ast"
	"go/build"
	"go/parser"
	"go/token"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestStartSpan(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		err          error
		attrs        []attribute.KeyValue
		wantStatus   codes.Code
		wantExpected string // error.expected attribute, "" for none
	}{
		{name: "success", attrs: []attribute.KeyValue{attribute.String("note.id", "n1")}, wantStatus: codes.Ok},
		{name: "expected sentinel", err: ErrNoteNotFound, wantStatus: codes.Ok, wantExpected: ErrNoteNotFound.Error()},
		{
			name:         "wrapped expected sentinel",
			err:          fmt.Errorf("update note: %w", ErrNoteVersionConflict),
			wantStatus:   codes.Ok,
			wantExpected: "update note: " + ErrNoteVersionConflict.Error(),
		},
		{name: "unexpected error", err: errors.New("database is locked"), wantStatus: codes.Error},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			recorder := tracetest.NewSpanRecorder()
			tracer := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder)).Tracer("test")

			op := func() (err error) {
				_, end := startSpan(t.Context(), tracer, "Store.Op", &err, tt.attrs...)
				defer end()
				return tt.err
			}
			_ = op()

			spans := recorder.Ended()
			require.Len(t, spans, 1)
			span := spans[0]
			assert.Equal(t, "Store.Op", span.Name())
			assert.Equal(t, tt.wantStatus, span.Status().Code)
			// Only a failed span records the error as an exception event.
			assert.Equal(t, tt.wantStatus == codes.Error, len(span.Events()) == 1)
			for _, kv := range tt.attrs {
				assert.Contains(t, span.Attributes(), kv)
			}
			set := attribute.NewSet(span.Attributes()...)
			expected, _ := set.Value("error.expected")
			assert.Equal(t, tt.wantExpected, expected.AsString())
		})
	}
}

// TestExpectedErrorsCoverSentinels fails when a package-level Err* sentinel is
// neither in expectedErrors nor listed here as a genuine failure, so a new
// sentinel cannot silently turn its routine 4xx into failed spans.
func TestExpectedErrorsCoverSentinels(t *testing.T) {
	t.Parallel()
	unexpected := map[string]bool{
		// Every write surface validates the note type before calling the store,
		// so reaching the store's guard is a bug that surfaces as a 500.
		"ErrInvalidNoteType": true,
	}

	declared := map[string]bool{}
	listed := map[string]bool{}
	for _, vs := range packageVars(t) {
		for i, n := range vs.Names {
			if strings.HasPrefix(n.Name, "Err") {
				declared[n.Name] = true
			}
			if n.Name != "expectedErrors" {
				continue
			}
			lit, ok := vs.Values[i].(*ast.CompositeLit)
			require.True(t, ok)
			for _, elt := range lit.Elts {
				if id, ok := elt.(*ast.Ident); ok {
					listed[id.Name] = true
				}
			}
		}
	}

	require.NotEmpty(t, listed, "expectedErrors not found")
	for name := range declared {
		assert.True(t, listed[name] || unexpected[name],
			"%s is not in expectedErrors (spans.go); add it there, or to this test's unexpected set if it is a real failure", name)
	}
}

// packageVars returns the package-level var specs of the non-test files in
// this package.
func packageVars(t *testing.T) []*ast.ValueSpec {
	t.Helper()
	bp, err := build.Default.ImportDir(".", 0)
	require.NoError(t, err)

	fset := token.NewFileSet()
	var specs []*ast.ValueSpec
	for _, name := range bp.GoFiles {
		f, err := parser.ParseFile(fset, name, nil, 0)
		require.NoError(t, err)
		for _, decl := range f.Decls {
			gd, ok := decl.(*ast.GenDecl)
			if !ok || gd.Tok != token.VAR {
				continue
			}
			for _, spec := range gd.Specs {
				if vs, ok := spec.(*ast.ValueSpec); ok {
					specs = append(specs, vs)
				}
			}
		}
	}
	return specs
}
