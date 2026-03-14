package database

import "testing"

const sqliteSharedCacheDSN = "file:test.db?cache=shared&_foreign_keys=1"

func TestSQLiteDSNWithForeignKeys(t *testing.T) {
	t.Run("appends pragma when query is absent", func(t *testing.T) {
		got := sqliteDSNWithForeignKeys("/tmp/test.db")
		want := "/tmp/test.db?_foreign_keys=1"
		if got != want {
			t.Fatalf("expected %q, got %q", want, got)
		}
	})

	t.Run("appends pragma when query exists", func(t *testing.T) {
		got := sqliteDSNWithForeignKeys("file:test.db?cache=shared")
		want := sqliteSharedCacheDSN
		if got != want {
			t.Fatalf("expected %q, got %q", want, got)
		}
	})

	t.Run("forces existing foreign keys flag to one", func(t *testing.T) {
		got := sqliteDSNWithForeignKeys("file:test.db?cache=shared&_foreign_keys=0")
		want := sqliteSharedCacheDSN
		if got != want {
			t.Fatalf("expected %q, got %q", want, got)
		}
	})

	t.Run("keeps one when already enabled", func(t *testing.T) {
		got := sqliteDSNWithForeignKeys(sqliteSharedCacheDSN)
		want := sqliteSharedCacheDSN
		if got != want {
			t.Fatalf("expected %q, got %q", want, got)
		}
	})
}
