// Command otelwrap generates the OpenTelemetry span wrappers for the stores in
// internal/models, so a store method is written once and its span cannot drift
// from it.
//
// A wrapper is any struct type in the package with an `inner *T` field and a
// `tracer` field. For every exported method on *T, otelwrap emits a method on
// the wrapper with the same signature that opens a "<Wrapper>.<Method>" span
// through startSpan and delegates to inner. Each such method must take a
// context.Context first and return an error last.
//
// Span attributes are declared in the wrapper type's doc comment, one directive
// per string parameter name; every method with a parameter of that name records
// it:
//
//	//otelwrap:attr noteID note.id
//
// It runs through go generate (`task gen-go`), and `task check-generated` fails
// when the committed output is stale.
package main

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"go/ast"
	"go/build"
	"go/format"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

const attrDirective = "//otelwrap:attr "

func main() {
	out := flag.String("out", "", "output file, relative to the package directory")
	flag.Parse()
	if err := run(*out); err != nil {
		fmt.Fprintf(os.Stderr, "otelwrap: %v\n", err)
		os.Exit(1)
	}
}

func run(out string) error {
	if out == "" {
		return errors.New("-out is required")
	}
	src, err := generate(".", out)
	if err != nil {
		return err
	}
	//nolint:gosec // G306: generated source is committed and as readable as every other file in the tree
	if err := os.WriteFile(out, src, 0o644); err != nil {
		return fmt.Errorf("write output: %w", err)
	}
	return nil
}

// wrapper is one store type to generate methods for.
type wrapper struct {
	name  string
	inner string
	attrs map[string]string // parameter name -> span attribute key
}

// method is an exported method of an inner store, with the imports of the
// file that declares it so its signature's package references can be resolved.
type method struct {
	decl    *ast.FuncDecl
	imports map[string]string // package name -> import path
}

// pkgInfo is what generate needs from the parsed package.
type pkgInfo struct {
	name     string
	wrappers []wrapper
	methods  map[string][]method // receiver type name -> methods
}

type generator struct {
	fset    *token.FileSet
	imports map[string]string // import path -> package name, for the output
	buf     bytes.Buffer
}

// generate parses the non-test Go files in dir, skipping the previous output,
// and returns the formatted source of the wrapper methods.
func generate(dir, out string) ([]byte, error) {
	fset := token.NewFileSet()
	pkg, err := parsePackage(fset, dir, filepath.Base(out))
	if err != nil {
		return nil, err
	}
	if len(pkg.wrappers) == 0 {
		return nil, fmt.Errorf("no wrapper types found in %s", dir)
	}

	slices.SortFunc(pkg.wrappers, func(a, b wrapper) int { return strings.Compare(a.name, b.name) })
	g := &generator{fset: fset, imports: map[string]string{}}
	for _, w := range pkg.wrappers {
		ms := pkg.methods[w.inner]
		if len(ms) == 0 {
			return nil, fmt.Errorf("%s wraps %s, which has no exported methods", w.name, w.inner)
		}
		slices.SortFunc(ms, func(a, b method) int { return strings.Compare(a.decl.Name.Name, b.decl.Name.Name) })
		for _, m := range ms {
			if err := g.writeMethod(w, m); err != nil {
				return nil, fmt.Errorf("%s.%s: %w", w.inner, m.decl.Name.Name, err)
			}
		}
		if unused := unusedAttrs(w, ms); len(unused) > 0 {
			return nil, fmt.Errorf("%s: %s%s matches no parameter of %s", w.name, attrDirective, strings.Join(unused, ", "), w.inner)
		}
	}
	return g.file(pkg.name)
}

// unusedAttrs returns the parameter names w has attribute directives for that
// no method in ms takes, so a typo or a renamed parameter fails generation
// instead of silently dropping the attribute.
func unusedAttrs(w wrapper, ms []method) []string {
	seen := map[string]bool{}
	for _, m := range ms {
		for _, field := range m.decl.Type.Params.List {
			for _, n := range field.Names {
				seen[n.Name] = true
			}
		}
	}
	var unused []string
	for name := range w.attrs {
		if !seen[name] {
			unused = append(unused, name)
		}
	}
	slices.Sort(unused)
	return unused
}

func parsePackage(fset *token.FileSet, dir, skip string) (*pkgInfo, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read package dir: %w", err)
	}
	pkg := &pkgInfo{methods: map[string][]method{}}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") || name == skip {
			continue
		}
		// Skip files the build would (//go:build ignore, _windows.go, ...), so
		// their methods are not wrapped twice or wrapped when not compiled.
		match, err := build.Default.MatchFile(dir, name)
		if err != nil {
			return nil, fmt.Errorf("match build constraints of %s: %w", name, err)
		}
		if !match {
			continue
		}
		f, err := parser.ParseFile(fset, filepath.Join(dir, name), nil, parser.ParseComments)
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", name, err)
		}
		if err := pkg.add(f); err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
	}
	return pkg, nil
}

// add records the wrapper types and exported pointer-receiver methods in f.
func (p *pkgInfo) add(f *ast.File) error {
	p.name = f.Name.Name
	imports, err := fileImports(f)
	if err != nil {
		return err
	}
	for _, decl := range f.Decls {
		switch d := decl.(type) {
		case *ast.GenDecl:
			ws, err := findWrappers(d)
			if err != nil {
				return err
			}
			p.wrappers = append(p.wrappers, ws...)
		case *ast.FuncDecl:
			if recv := receiverType(d); recv != "" && d.Name.IsExported() {
				p.methods[recv] = append(p.methods[recv], method{decl: d, imports: imports})
			}
		}
	}
	return nil
}

func fileImports(f *ast.File) (map[string]string, error) {
	imports := map[string]string{}
	for _, imp := range f.Imports {
		p, err := strconv.Unquote(imp.Path.Value)
		if err != nil {
			return nil, fmt.Errorf("unquote import path: %w", err)
		}
		n := importName(p)
		if imp.Name != nil {
			n = imp.Name.Name
		}
		imports[n] = p
	}
	return imports, nil
}

// importName returns the package name an unaliased import of p is referred to
// by, following the module conventions where that differs from the last path
// element: a major-version suffix (example.com/jwt/v5 is jwt) and a gopkg.in
// version (gopkg.in/yaml.v3 is yaml).
func importName(p string) string {
	n := path.Base(p)
	if dir := path.Dir(p); dir != "." && len(n) > 1 && n[0] == 'v' && isDigits(n[1:]) {
		n = path.Base(dir)
	}
	if before, after, ok := strings.Cut(n, ".v"); ok && isDigits(after) {
		n = before
	}
	return n
}

func isDigits(s string) bool {
	return s != "" && strings.Trim(s, "0123456789") == ""
}

// findWrappers returns the wrapper types declared in d, with the attributes
// configured on each.
func findWrappers(d *ast.GenDecl) ([]wrapper, error) {
	if d.Tok != token.TYPE {
		return nil, nil
	}
	var out []wrapper
	for _, spec := range d.Specs {
		ts, ok := spec.(*ast.TypeSpec)
		if !ok {
			continue
		}
		inner := wrappedType(ts)
		if inner == "" {
			continue
		}
		doc := ts.Doc
		if doc == nil && len(d.Specs) == 1 {
			doc = d.Doc
		}
		attrs, err := attrDirectives(doc)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", ts.Name.Name, err)
		}
		out = append(out, wrapper{name: ts.Name.Name, inner: inner, attrs: attrs})
	}
	return out, nil
}

// wrappedType returns T if ts is a struct with an `inner *T` field and a
// `tracer` field, or "" otherwise.
func wrappedType(ts *ast.TypeSpec) string {
	st, ok := ts.Type.(*ast.StructType)
	if !ok {
		return ""
	}
	var inner string
	hasTracer := false
	for _, field := range st.Fields.List {
		for _, n := range field.Names {
			switch n.Name {
			case "inner":
				inner = pointerTo(field.Type)
			case "tracer":
				hasTracer = true
			}
		}
	}
	if !hasTracer {
		return ""
	}
	return inner
}

// pointerTo returns T for the type expression *T, or "" otherwise.
func pointerTo(expr ast.Expr) string {
	star, ok := expr.(*ast.StarExpr)
	if !ok {
		return ""
	}
	id, ok := star.X.(*ast.Ident)
	if !ok {
		return ""
	}
	return id.Name
}

func attrDirectives(doc *ast.CommentGroup) (map[string]string, error) {
	attrs := map[string]string{}
	if doc == nil {
		return attrs, nil
	}
	for _, c := range doc.List {
		rest, ok := strings.CutPrefix(c.Text, attrDirective)
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) != 2 {
			return nil, fmt.Errorf("want %q, got %q", attrDirective+"<param> <attribute>", c.Text)
		}
		attrs[fields[0]] = fields[1]
	}
	return attrs, nil
}

// receiverType returns T for a method declared on *T, or "" otherwise.
func receiverType(d *ast.FuncDecl) string {
	if d.Recv == nil || len(d.Recv.List) != 1 {
		return ""
	}
	return pointerTo(d.Recv.List[0].Type)
}

// signature is a method's parameters, rendered for the wrapper.
type signature struct {
	ctx    string   // name of the context parameter
	params []string // "name type"
	args   []string // arguments for the call to inner
	attrs  []string // attribute.String(...) expressions
}

func (g *generator) writeMethod(w wrapper, m method) error {
	if m.decl.Type.TypeParams != nil {
		return errors.New("generic methods are not supported")
	}
	sig, err := g.params(w, m)
	if err != nil {
		return err
	}
	results, err := g.results(m)
	if err != nil {
		return err
	}

	name := m.decl.Name.Name
	fmt.Fprintf(&g.buf, "\nfunc (s *%s) %s(%s) (%s) {\n", w.name, name, strings.Join(sig.params, ", "), strings.Join(results, ", "))
	fmt.Fprintf(&g.buf, "\t%s, end := startSpan(%s, s.tracer, %q, &err", sig.ctx, sig.ctx, w.name+"."+name)
	if len(sig.attrs) > 0 {
		g.imports["go.opentelemetry.io/otel/attribute"] = "attribute"
		g.buf.WriteString(",\n")
		for _, a := range sig.attrs {
			fmt.Fprintf(&g.buf, "\t\t%s,\n", a)
		}
		g.buf.WriteString("\t)\n")
	} else {
		g.buf.WriteString(")\n")
	}
	g.buf.WriteString("\tdefer end()\n")
	fmt.Fprintf(&g.buf, "\treturn s.inner.%s(%s)\n}\n", name, strings.Join(sig.args, ", "))
	return nil
}

func (g *generator) params(w wrapper, m method) (signature, error) {
	var sig signature
	for _, field := range m.decl.Type.Params.List {
		typ, err := g.typeString(field.Type, m.imports)
		if err != nil {
			return sig, err
		}
		_, variadic := field.Type.(*ast.Ellipsis)
		names := field.Names
		if len(names) == 0 {
			names = []*ast.Ident{{Name: "_"}}
		}
		for _, n := range names {
			if err := sig.add(n.Name, typ, variadic, w.attrs); err != nil {
				return sig, err
			}
		}
	}
	if sig.ctx == "" {
		return sig, errors.New("first parameter must be a context.Context")
	}
	return sig, nil
}

func (sig *signature) add(name, typ string, variadic bool, attrs map[string]string) error {
	if name == "_" {
		name = "p" + strconv.Itoa(len(sig.params))
	}
	switch name {
	case "s", "end", "err":
		return fmt.Errorf("parameter %q collides with a name the wrapper uses", name)
	}
	if len(sig.params) == 0 {
		if typ != "context.Context" {
			return errors.New("first parameter must be a context.Context")
		}
		sig.ctx = name
	}
	sig.params = append(sig.params, name+" "+typ)
	if variadic {
		sig.args = append(sig.args, name+"...")
	} else {
		sig.args = append(sig.args, name)
	}
	if key, ok := attrs[name]; ok {
		if typ != "string" {
			return fmt.Errorf("parameter %s has span attribute %s but is %s, not string", name, key, typ)
		}
		sig.attrs = append(sig.attrs, fmt.Sprintf("attribute.String(%q, %s)", key, name))
	}
	return nil
}

// results renders m's results as the wrapper's named results: all blank but
// the trailing error, which startSpan records.
func (g *generator) results(m method) ([]string, error) {
	var types []string
	if m.decl.Type.Results != nil {
		for _, field := range m.decl.Type.Results.List {
			typ, err := g.typeString(field.Type, m.imports)
			if err != nil {
				return nil, err
			}
			for range max(1, len(field.Names)) {
				types = append(types, typ)
			}
		}
	}
	if len(types) == 0 || types[len(types)-1] != "error" {
		return nil, errors.New("last result must be an error")
	}
	named := make([]string, len(types))
	for i, typ := range types[:len(types)-1] {
		named[i] = "_ " + typ
	}
	named[len(named)-1] = "err error"
	return named, nil
}

// typeString renders a type expression as source and records the imports its
// package-qualified identifiers need.
func (g *generator) typeString(expr ast.Expr, imports map[string]string) (string, error) {
	var err error
	ast.Inspect(expr, func(n ast.Node) bool {
		sel, ok := n.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		if id, ok := sel.X.(*ast.Ident); ok {
			p, found := imports[id.Name]
			if !found {
				err = fmt.Errorf("no import for package %s", id.Name)
				return false
			}
			g.imports[p] = id.Name
		}
		return false
	})
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := printer.Fprint(&buf, g.fset, expr); err != nil {
		return "", fmt.Errorf("print type: %w", err)
	}
	return buf.String(), nil
}

// file assembles and formats the output file.
func (g *generator) file(pkg string) ([]byte, error) {
	var file bytes.Buffer
	file.WriteString("// Code generated by otelwrap; DO NOT EDIT.\n\n")
	fmt.Fprintf(&file, "package %s\n\nimport (\n", pkg)
	paths := make([]string, 0, len(g.imports))
	for p := range g.imports {
		paths = append(paths, p)
	}
	// Standard library first, then a blank line and everything else, as
	// goimports groups them.
	isStd := func(p string) bool { return !strings.Contains(strings.Split(p, "/")[0], ".") }
	slices.SortFunc(paths, func(a, b string) int {
		if isStd(a) != isStd(b) {
			if isStd(a) {
				return -1
			}
			return 1
		}
		return strings.Compare(a, b)
	})
	for i, p := range paths {
		if i > 0 && isStd(paths[i-1]) && !isStd(p) {
			file.WriteString("\n")
		}
		if n := g.imports[p]; n != importName(p) {
			fmt.Fprintf(&file, "\t%s %q\n", n, p)
		} else {
			fmt.Fprintf(&file, "\t%q\n", p)
		}
	}
	file.WriteString(")\n")
	file.Write(g.buf.Bytes())
	src, err := format.Source(file.Bytes())
	if err != nil {
		return nil, fmt.Errorf("format output: %w", err)
	}
	return src, nil
}
