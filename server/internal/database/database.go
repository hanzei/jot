package database

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"

	"github.com/golang-migrate/migrate/v4"
	migratedatabase "github.com/golang-migrate/migrate/v4/database"
	postgresmigrate "github.com/golang-migrate/migrate/v4/database/postgres"
	sqlitemigrate "github.com/golang-migrate/migrate/v4/database/sqlite"
	"github.com/golang-migrate/migrate/v4/source"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	_ "github.com/lib/pq"
	log "github.com/sirupsen/logrus"
	_ "modernc.org/sqlite"
)

//go:embed migrations/sqlite/*.sql
var sqliteMigrationsFS embed.FS

//go:embed migrations/postgres/*.sql
var postgresMigrationsFS embed.FS

// New opens the database, applies SQLite-specific settings when driver is
// "sqlite", and runs all pending migrations via golang-migrate.
// driver must be "sqlite" or "postgres"; dsn is the data source name.
func New(driver, dsn string) (*sql.DB, error) {
	ctx := context.Background()

	db, err := sql.Open(driver, dsn)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}

	if err := db.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("ping database: %w", err)
	}

	if driver == "sqlite" {
		// Serialize all access through a single connection. SQLite supports only one
		// concurrent writer; a single connection eliminates SQLITE_BUSY errors.
		db.SetMaxOpenConns(1)

		if _, err := db.ExecContext(ctx, `PRAGMA journal_mode=WAL`); err != nil {
			return nil, fmt.Errorf("enable WAL mode: %w", err)
		}
		if _, err := db.ExecContext(ctx, `PRAGMA foreign_keys = ON`); err != nil {
			return nil, fmt.Errorf("enable foreign key enforcement: %w", err)
		}
	}

	if err := runMigrations(db, driver); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("run migrations: %w", err)
	}

	return db, nil
}

func runMigrations(db *sql.DB, driver string) error {
	var (
		src      source.Driver
		dbDriver migratedatabase.Driver
		err      error
	)

	switch driver {
	case "sqlite":
		src, err = iofs.New(sqliteMigrationsFS, "migrations/sqlite")
		if err != nil {
			return fmt.Errorf("create sqlite migration source: %w", err)
		}
		dbDriver, err = sqlitemigrate.WithInstance(db, &sqlitemigrate.Config{})
		if err != nil {
			return fmt.Errorf("create sqlite migration driver: %w", err)
		}
	case "postgres":
		src, err = iofs.New(postgresMigrationsFS, "migrations/postgres")
		if err != nil {
			return fmt.Errorf("create postgres migration source: %w", err)
		}
		dbDriver, err = postgresmigrate.WithInstance(db, &postgresmigrate.Config{})
		if err != nil {
			return fmt.Errorf("create postgres migration driver: %w", err)
		}
	default:
		return fmt.Errorf("unsupported database driver: %s", driver)
	}

	m, err := migrate.NewWithInstance("iofs", src, driver, dbDriver)
	if err != nil {
		return fmt.Errorf("create migrate instance: %w", err)
	}

	if err := m.Up(); err != nil {
		if errors.Is(err, migrate.ErrNoChange) {
			return nil
		}
		return fmt.Errorf("apply migrations: %w", err)
	}

	version, _, _ := m.Version()
	log.WithField("version", version).Info("Migrations applied successfully")
	return nil
}
