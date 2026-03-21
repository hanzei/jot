package database

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"strings"

	_ "github.com/mattn/go-sqlite3"
	log "github.com/sirupsen/logrus"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

type DB struct {
	*sql.DB
}

const sqliteForeignKeysParam = "_foreign_keys=on"

func New(dbPath string) (*DB, error) {
	db, err := sql.Open("sqlite3", sqliteDSN(dbPath))
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	d := &DB{DB: db}
	if err := d.verifyForeignKeysEnabled(context.Background()); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to verify foreign key enforcement before migrations: %w", err)
	}

	if err := d.runMigrations(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to run migrations: %w", err)
	}

	if err := d.verifyForeignKeysEnabled(context.Background()); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to verify foreign key enforcement after migrations: %w", err)
	}

	if err := d.verifyForeignKeyState(context.Background()); err != nil {
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

	if err := verifyForeignKeysEnabledOnConn(ctx, conn); err != nil {
		return err
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

func (d *DB) runMigrations() error {
	if _, err := d.Exec(`CREATE TABLE IF NOT EXISTS migrations (
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
		err := d.QueryRow("SELECT COUNT(*) FROM migrations WHERE filename = ?", file.Name()).Scan(&count)
		if err != nil {
			return fmt.Errorf("failed to check migration status: %w", err)
		}

		if count > 0 {
			continue
		}

		content, err := migrationsFS.ReadFile("migrations/" + file.Name())
		if err != nil {
			return fmt.Errorf("failed to read migration file %s: %w", file.Name(), err)
		}

		tx, err := d.Begin()
		if err != nil {
			return fmt.Errorf("failed to begin transaction: %w", err)
		}

		if _, err := tx.Exec(string(content)); err != nil {
			if rollbackErr := tx.Rollback(); rollbackErr != nil {
				return fmt.Errorf("failed to execute migration %s: %w, rollback failed: %w", file.Name(), err, rollbackErr)
			}
			return fmt.Errorf("failed to execute migration %s: %w", file.Name(), err)
		}

		if _, err := tx.Exec("INSERT INTO migrations (filename) VALUES (?)", file.Name()); err != nil {
			if rollbackErr := tx.Rollback(); rollbackErr != nil {
				return fmt.Errorf("failed to record migration %s: %w, rollback failed: %w", file.Name(), err, rollbackErr)
			}
			return fmt.Errorf("failed to record migration %s: %w", file.Name(), err)
		}

		if err := tx.Commit(); err != nil {
			return fmt.Errorf("failed to commit migration %s: %w", file.Name(), err)
		}

		log.WithField("filename", file.Name()).Info("Applied migration")
	}

	return nil
}
