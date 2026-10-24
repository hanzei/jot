package models

import (
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
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
		wantStatus   codes.Code
		wantExpected string // error.expected attribute, "" for none
		wantEvents   int
	}{
		{name: "success", err: nil, wantStatus: codes.Ok},
		{name: "expected sentinel", err: ErrNoteNotFound, wantStatus: codes.Ok, wantExpected: ErrNoteNotFound.Error()},
		{
			name:         "wrapped expected sentinel",
			err:          fmt.Errorf("update note: %w", ErrNoteVersionConflict),
			wantStatus:   codes.Ok,
			wantExpected: "update note: " + ErrNoteVersionConflict.Error(),
		},
		{name: "unexpected error", err: errors.New("database is locked"), wantStatus: codes.Error, wantEvents: 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			recorder := tracetest.NewSpanRecorder()
			tracer := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder)).Tracer("test")

			op := func() (err error) {
				_, end := startSpan(t.Context(), tracer, "Store.Op", &err)
				defer end()
				return tt.err
			}
			_ = op()

			spans := recorder.Ended()
			require.Len(t, spans, 1)
			assert.Equal(t, tt.wantStatus, spans[0].Status().Code)
			assert.Len(t, spans[0].Events(), tt.wantEvents)
			var expected string
			for _, kv := range spans[0].Attributes() {
				if kv.Key == "error.expected" {
					expected = kv.Value.AsString()
				}
			}
			assert.Equal(t, tt.wantExpected, expected)
		})
	}

	t.Run("attributes", func(t *testing.T) {
		t.Parallel()
		recorder := tracetest.NewSpanRecorder()
		tracer := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder)).Tracer("test")
		var err error
		_, end := startSpan(t.Context(), tracer, "Store.Op", &err, attribute.String("note.id", "n1"))
		end()

		spans := recorder.Ended()
		require.Len(t, spans, 1)
		assert.Equal(t, "Store.Op", spans[0].Name())
		assert.Contains(t, spans[0].Attributes(), attribute.String("note.id", "n1"))
	})
}

// TestExpectedErrorsCoverSentinels fails when a package-level Err* sentinel is
// neither in expectedErrors nor listed here as a genuine failure, so a new
// sentinel cannot silently turn its routine 4xx into failed spans.
func TestExpectedErrorsCoverSentinels(t *testing.T) {
	t.Parallel()
	unexpected := map[string]bool{}

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
	entries, err := os.ReadDir(".")
	require.NoError(t, err)

	fset := token.NewFileSet()
	var specs []*ast.ValueSpec
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, e.Name(), nil, 0)
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
