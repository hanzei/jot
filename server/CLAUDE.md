# Server Project Instructions

Do not hand-align a `//	@Param` annotation block; `task fmt` (swaggo) owns those
columns.

## Conventions (Go)

- Use `any`, not `interface{}`.
- Log with `logrus`, never the standard `log` package. In handlers and
  middleware use `logutil.FromContext(ctx)`, which carries request ID, user,
  method, and path; bare `logrus.*` is only for startup code and background
  goroutines. Log messages start with a capital letter.
- `ctx context.Context` is the first parameter of anything that does I/O, calls
  another service, or may need cancelling. In tests use `t.Context()`.
- Prefer table-driven tests with `t.Run` subtests. No `_` in top-level test
  names: `TestCreateNote` + `t.Run("success", …)`, not `TestCreateNote_Success`.

## Error Handling (Go)

- Wrap errors crossing a function boundary with a short, lowercase description
  of the failed operation — `fmt.Errorf("get note by id: %w", err)` — rather
  than a bare `return err`.
- Do **not** re-wrap a sentinel (`sql.ErrNoRows`, `ErrNoteNotFound`, …) that has
  already been matched with `errors.Is` and is being returned as-is.
- Do not wrap errors inside `defer` functions or log statements.
