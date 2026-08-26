#!/usr/bin/env bash
#
# check-migrations.sh — verify the two embedded migration trees stay in step.
#
# Every schema change ships as two files, one per dialect, because each dialect
# has its own //go:embed tree (server/internal/database/database.go). A
# dialect-only migration still passes `task test-server` locally — the Postgres
# store tests skip without TEST_POSTGRES_DSN — so nothing but this check stands
# between writing one file and a CI failure that names the wrong thing.
#
# Run it directly, or via `task check-migrations`. The `migrations` job in
# .github/workflows/server-ci.yml runs this same script, so local and CI cannot
# drift.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT

readonly MIGRATIONS_DIR="$REPO_ROOT/server/internal/database/migrations"
readonly DIALECTS=(sqlite postgres)

failures=0

fail() {
  printf '\n[check-migrations] FAIL: %s\n' "$1" >&2
  shift
  [ $# -gt 0 ] && printf '%s\n' "$@" >&2
  failures=$((failures + 1))
}

# Only top-level *.sql, matching the //go:embed scope in database.go — anything
# nested is not embedded, so a difference there is not a migration mismatch.
list_migrations() {
  find "$MIGRATIONS_DIR/$1/" -maxdepth 1 -type f -name '*.sql' -exec basename {} \; | sort
}

for dialect in "${DIALECTS[@]}"; do
  if [ ! -d "$MIGRATIONS_DIR/$dialect" ]; then
    fail "no migration directory for '$dialect' at $MIGRATIONS_DIR/$dialect"
    continue
  fi
done

if [ "$failures" -gt 0 ]; then
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Migration numbers are unique within each dialect
#
# golang-migrate refuses to run a tree with two migrations at the same version,
# which is easy to produce when two branches both take the next free number.
# ---------------------------------------------------------------------------

for dialect in "${DIALECTS[@]}"; do
  dupes="$(list_migrations "$dialect" | grep -oE '^[0-9]+' | sort | uniq -d)"
  if [ -n "$dupes" ]; then
    fail "duplicate migration numbers in $dialect:" \
      "$(printf '  %s\n' $dupes)" \
      "" \
      "Renumber one of them to the next free version — golang-migrate will not" \
      "run a tree with two migrations at the same version."
  fi
done

# ---------------------------------------------------------------------------
# 2. The two dialects describe the same set of migrations
# ---------------------------------------------------------------------------

sqlite_list="$(list_migrations sqlite)"
postgres_list="$(list_migrations postgres)"

if [ "$sqlite_list" != "$postgres_list" ]; then
  diff_output="$(diff -u <(printf '%s\n' "$sqlite_list") <(printf '%s\n' "$postgres_list") \
    --label sqlite --label postgres)"
  fail "sqlite and postgres migration sets differ:" \
    "$diff_output" \
    "" \
    "Every migration needs a matching file with the same name in both" \
    "  $MIGRATIONS_DIR/sqlite/" \
    "  $MIGRATIONS_DIR/postgres/" \
    "A migration only one backend needs still gets an explanatory placeholder" \
    "file in the other, so the numbering stays aligned."
fi

if [ "$failures" -gt 0 ]; then
  exit 1
fi

echo "[check-migrations] OK — $(printf '%s\n' "$sqlite_list" | wc -l | tr -d ' ') migrations, sqlite and postgres in sync"
