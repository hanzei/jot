package database

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"

	_ "modernc.org/sqlite"
	log "github.com/sirupsen/logrus"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

type DB struct {
	*sql.DB
}

func New(dbPath string) (*DB, error) {
	ctx := context.Background()

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// Serialize all access through a single connection. SQLite supports only one
	// concurrent writer; using a single connection eliminates SQLITE_BUSY errors
	// without needing a busy timeout.
	db.SetMaxOpenConns(1)

	if err := db.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	// Enable WAL journal mode for better read concurrency and to avoid holding
	// an exclusive lock on the database file (the default rollback journal does).
	if _, err := db.ExecContext(ctx, `PRAGMA journal_mode=WAL`); err != nil {
		return nil, fmt.Errorf("failed to enable WAL mode: %w", err)
	}

	// Enforce foreign key constraints. SQLite disables FK enforcement by default;
	// this pragma enables it for the lifetime of the connection.
	if _, err := db.ExecContext(ctx, `PRAGMA foreign_keys = ON`); err != nil {
		return nil, fmt.Errorf("failed to enable foreign key enforcement: %w", err)
	}

	d := &DB{DB: db}
	if err := d.runMigrations(ctx); err != nil {
		return nil, fmt.Errorf("failed to run migrations: %w", err)
	}

	return d, nil
}

func (d *DB) runMigrations(ctx context.Context) error {
	if _, err := d.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS migrations (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		filename TEXT UNIQUE NOT NULL,
		applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)`); err != nil {
		return fmt.Errorf("failed to create migrations table: %w", err)
	}

	files, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		return fmt.Errorf("failed to read migrations directory: %w", err)
	}

	for _, file := range files {
		var count int
		err := d.QueryRowContext(ctx, "SELECT COUNT(*) FROM migrations WHERE filename = ?", file.Name()).Scan(&count)
		if err != nil {
			return fmt.Errorf("failed to check migration status: %w", err)
		}

		if count > 0 {
			continue
		}

		if err := d.applyMigration(ctx, file); err != nil {
			return err
		}

		log.WithField("filename", file.Name()).Info("Applied migration")
	}

	return nil
}

func (d *DB) applyMigration(ctx context.Context, file fs.DirEntry) error {
	content, err := migrationsFS.ReadFile("migrations/" + file.Name())
	if err != nil {
		return fmt.Errorf("failed to read migration file %s: %w", file.Name(), err)
	}

	// Foreign key enforcement must be disabled before the transaction when a
	// migration rebuilds tables (DROP + recreate), because SQLite would otherwise
	// cascade-delete child rows. It is a no-op inside a transaction, so it must
	// be set on the raw connection before BeginTx.
	if _, err = d.ExecContext(ctx, `PRAGMA foreign_keys = OFF`); err != nil {
		return fmt.Errorf("failed to disable foreign keys for migration %s: %w", file.Name(), err)
	}
	defer func() { _, _ = d.ExecContext(ctx, `PRAGMA foreign_keys = ON`) }()

	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}

	if _, err := tx.ExecContext(ctx, string(content)); err != nil {
		if rollbackErr := tx.Rollback(); rollbackErr != nil {
			return fmt.Errorf("failed to execute migration %s: %w, rollback failed: %w", file.Name(), err, rollbackErr)
		}
		return fmt.Errorf("failed to execute migration %s: %w", file.Name(), err)
	}

	if _, err := tx.ExecContext(ctx, "INSERT INTO migrations (filename) VALUES (?)", file.Name()); err != nil {
		if rollbackErr := tx.Rollback(); rollbackErr != nil {
			return fmt.Errorf("failed to record migration %s: %w, rollback failed: %w", file.Name(), err, rollbackErr)
		}
		return fmt.Errorf("failed to record migration %s: %w", file.Name(), err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit migration %s: %w", file.Name(), err)
	}

	return nil
}
