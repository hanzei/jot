package database

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"strings"

	log "github.com/sirupsen/logrus"
	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

type DB struct {
	*sql.DB
}

const sqliteForeignKeysParam = "_pragma=foreign_keys(on)"

func New(dbPath string) (*DB, error) {
	ctx := context.Background()

	db, err := sql.Open("sqlite", sqliteDSN(dbPath))
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// Serialize all access through a single connection. SQLite supports only one
	// concurrent writer; using a single connection eliminates SQLITE_BUSY errors
	// without needing a busy timeout.
	db.SetMaxOpenConns(1)

	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	// Enable WAL journal mode for better read concurrency and to avoid holding
	// an exclusive lock on the database file (the default rollback journal does).
	if _, err := db.ExecContext(ctx, `PRAGMA journal_mode=WAL`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to enable WAL mode: %w", err)
	}

	d := &DB{DB: db}
	if err := d.verifyForeignKeysEnabled(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to verify foreign key enforcement before migrations: %w", err)
	}

	if err := d.runMigrations(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to run migrations: %w", err)
	}

	if err := d.verifyForeignKeysEnabled(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to verify foreign key enforcement after migrations: %w", err)
	}

	if err := d.verifyForeignKeyState(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to verify foreign key state after migrations: %w", err)
	}

	return d, nil
}

func sqliteDSN(dbPath string) string {
	if strings.Contains(dbPath, "?") {
		return dbPath + "&" + sqliteForeignKeysParam
	}
	return dbPath + "?" + sqliteForeignKeysParam
}

func (d *DB) verifyForeignKeysEnabled(ctx context.Context) error {
	conn, err := d.Conn(ctx)
	if err != nil {
		return fmt.Errorf("acquire database connection: %w", err)
	}
	defer func() { _ = conn.Close() }()

	if err := verifyForeignKeysEnabledOnConn(ctx, conn); err != nil {
		return err
	}
	return nil
}

func (d *DB) verifyForeignKeyState(ctx context.Context) error {
	conn, err := d.Conn(ctx)
	if err != nil {
		return fmt.Errorf("acquire database connection: %w", err)
	}
	defer func() { _ = conn.Close() }()

	if verifyErr := verifyForeignKeysEnabledOnConn(ctx, conn); verifyErr != nil {
		return verifyErr
	}

	rows, err := conn.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return fmt.Errorf("run PRAGMA foreign_key_check: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var violations []string
	for rows.Next() {
		var (
			table  string
			rowID  sql.NullInt64
			parent string
			fkID   int
		)
		if err := rows.Scan(&table, &rowID, &parent, &fkID); err != nil {
			return fmt.Errorf("scan PRAGMA foreign_key_check row: %w", err)
		}
		violations = append(violations, fmt.Sprintf("table=%s rowid=%s parent=%s fk=%d", table, formatRowID(rowID), parent, fkID))
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate PRAGMA foreign_key_check rows: %w", err)
	}
	if len(violations) > 0 {
		return fmt.Errorf("foreign key violations remain after migrations: %s", strings.Join(violations, "; "))
	}
	return nil
}

func verifyForeignKeysEnabledOnConn(ctx context.Context, conn *sql.Conn) error {
	var enabled int
	if err := conn.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&enabled); err != nil {
		return fmt.Errorf("query PRAGMA foreign_keys: %w", err)
	}
	if enabled != 1 {
		return fmt.Errorf("PRAGMA foreign_keys returned %d", enabled)
	}
	return nil
}

func formatRowID(rowID sql.NullInt64) string {
	if !rowID.Valid {
		return "NULL"
	}
	return fmt.Sprintf("%d", rowID.Int64)
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
