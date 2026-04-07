# Server Project Instructions

## Naming Conventions (Go)

- Packages: `internal/{auth,config,database,handlers,logutil,mcphandler,models,server,sse,telemetry}`
- Go types: PascalCase when exported (`UserStore`, `NoteStore`, `PATStore`); variables: camelCase (`noteStore`, `userID`)
- Database columns: snake_case (`note_type`, `user_id`)
- JSON fields: snake_case (`note_type`, `user_id`)
- Error wrapping: `fmt.Errorf("context: %w", err)`
- Use `any` instead of `interface{}`
- Use `errors.Is` instead of `==` when comparing errors
- Use `logrus` instead of the standard `log` package for all logging
- In HTTP handlers and middleware, use `logutil.FromContext(ctx)` (from `server/internal/logutil`) to obtain the request-scoped logger. It automatically carries `request_id`, `user_id` (when authenticated), `method`, and `path` on every log line.
- Reserve bare `logrus.*` calls for background goroutines and startup code that have no request context.
- Log messages should start with a capital letter (e.g., `"Server shutdown complete"`).
- In tests, use `t.Context()` instead of `context.Background()`

## Error Handling (Go)

- Errors that cross a function boundary should be wrapped with a short, lowercase description of the operation that failed: `return nil, fmt.Errorf("get note by id: %w", err)`.
- Prefer wrapping over bare `return err` or `return nil, err` when returning up the call stack — the added context makes log traces easier to follow.
- Do **not** re-wrap sentinel errors (`sql.ErrNoRows`, `ErrNoteNotFound`, etc.) that have already been identified with `errors.Is` and are being returned directly. Re-wrapping them adds a redundant message layer without useful context (`errors.Is` traverses the `%w` chain, so matching still works either way).
- Do not wrap errors inside `defer` functions or inside log statements.
