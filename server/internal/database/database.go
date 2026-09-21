package database

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"embed"
	"errors"
	"fmt"

	"github.com/golang-migrate/migrate/v4"
	migratedatabase "github.com/golang-migrate/migrate/v4/database"
	postgresmigrate "github.com/golang-migrate/migrate/v4/database/postgres"
	sqlitemigrate "github.com/golang-migrate/migrate/v4/database/sqlite"
	"github.com/golang-migrate/migrate/v4/source"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/lib/pq"
	log "github.com/sirupsen/logrus"
	_ "modernc.org/sqlite"
)

const (
	driverSQLite   = "sqlite"
	driverPostgres = "postgres"
)

//go:embed migrations/sqlite/*.sql
var sqliteMigrationsFS embed.FS

//go:embed migrations/postgres/*.sql
var postgresMigrationsFS embed.FS

// New opens the database, applies SQLite-specific settings when driverName is
// "sqlite", and runs all pending migrations via golang-migrate.
// driverName must be "sqlite" or "postgres"; dsn is the data source name.
func New(driverName, dsn string) (*sql.DB, error) {
	ctx := context.Background()

	db, err := open(driverName, dsn)
	if err != nil {
		return nil, err
	}

	if err := db.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("ping database: %w", err)
	}

	if driverName == driverSQLite {
		// Serialize all access through a single connection. SQLite supports only one
		// concurrent writer; a single connection eliminates SQLITE_BUSY errors.
		// The single connection is also what lets the connection-scoped
		// foreign_keys pragma set below hold for every later query.
		db.SetMaxOpenConns(1)

		if _, err := db.ExecContext(ctx, `PRAGMA journal_mode=WAL`); err != nil {
			return nil, fmt.Errorf("enable WAL mode: %w", err)
		}
		// foreign_keys is deliberately left OFF (SQLite's default) here so it is
		// off while migrations run. Migration 000011 rebuilds the `users` parent
		// table with DROP TABLE, which with enforcement on would cascade-delete
		// every user's notes; SQLite ignores a foreign_keys pragma issued inside
		// golang-migrate's per-migration transaction, so the only place to hold it
		// off is out here. Enforcement is turned on below, after migrations and the
		// post-migration backfill, once foreign_key_check has confirmed the schema
		// changes introduced no dangling references.
	}

	if err := runMigrations(db, driverName); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("run migrations: %w", err)
	}

	// Runs after the migrations that add labels.name_folded, because the value
	// it stores is computed by Go and no migration can express it. A no-op once
	// it has run; see its doc comment.
	if err := backfillLabelNameFolded(ctx, db, driverName); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("backfill folded label names: %w", err)
	}

	if driverName == driverSQLite {
		// Migrations ran with foreign_keys off (see above). Prove no dangling
		// references were introduced — chiefly by 000011's `users` rebuild — then
		// enable enforcement for the rest of the connection's life, which is what
		// makes ON DELETE CASCADE work in normal operation.
		if err := verifyForeignKeys(ctx, db); err != nil {
			_ = db.Close()
			return nil, err
		}
		if _, err := db.ExecContext(ctx, `PRAGMA foreign_keys = ON`); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("enable foreign key enforcement: %w", err)
		}
	}

	return db, nil
}

// verifyForeignKeys runs PRAGMA foreign_key_check and fails if it reports any
// violation. It is the gate that makes running migrations with enforcement off
// safe: a rebuild that orphaned a child row (a bug in a migration) surfaces
// here at startup rather than silently at the first cascade. It reports the
// first offending (table, rowid) so a failure is diagnosable.
func verifyForeignKeys(ctx context.Context, db *sql.DB) error {
	rows, err := db.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		return fmt.Errorf("run foreign_key_check: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var (
		violations int
		firstTable string
		firstRowID sql.NullInt64
	)
	for rows.Next() {
		// Columns: table, rowid, referenced table, fkid.
		var (
			table    string
			rowID    sql.NullInt64
			refTable string
			fkID     int
		)
		if scanErr := rows.Scan(&table, &rowID, &refTable, &fkID); scanErr != nil {
			return fmt.Errorf("scan foreign_key_check row: %w", scanErr)
		}
		if violations == 0 {
			firstTable, firstRowID = table, rowID
		}
		violations++
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate foreign_key_check rows: %w", err)
	}
	if violations > 0 {
		return fmt.Errorf("foreign_key_check found %d violation(s) after migrations; first in table %q rowid %v", violations, firstTable, firstRowID.Int64)
	}
	return nil
}

// open returns a connection pool for driverName. PostgreSQL goes through
// utcConnector so every session runs in UTC (see its doc comment); SQLite has
// no session time zone and needs no special handling.
func open(driverName, dsn string) (*sql.DB, error) {
	if driverName != driverPostgres {
		db, err := sql.Open(driverName, dsn)
		if err != nil {
			return nil, fmt.Errorf("open database: %w", err)
		}
		return db, nil
	}

	connector, err := pq.NewConnector(dsn)
	if err != nil {
		return nil, fmt.Errorf("create postgres connector: %w", err)
	}
	return sql.OpenDB(utcConnector{Connector: connector}), nil
}

// utcConnector pins every PostgreSQL session it opens to UTC.
//
// Timestamp columns are TIMESTAMP WITHOUT TIME ZONE, so whatever wall-clock
// value a session writes is stored verbatim. The application always writes UTC
// (see models.Now), but DB-side defaults such as DEFAULT CURRENT_TIMESTAMP
// resolve against the session's time zone, which PostgreSQL takes from the
// server or database configuration. Without this, a server running in, say,
// Europe/Berlin would store local wall clock in those columns while the
// application compared them against UTC cutoffs — trash purges and session
// expiries would drift by the UTC offset. SQLite's CURRENT_TIMESTAMP is always
// UTC, so pinning the session here makes both backends agree.
type utcConnector struct {
	driver.Connector
}

func (c utcConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.Connector.Connect(ctx)
	if err != nil {
		return nil, fmt.Errorf("open postgres connection: %w", err)
	}

	execer, ok := conn.(driver.ExecerContext)
	if !ok {
		_ = conn.Close()
		return nil, errors.New("postgres connection does not implement driver.ExecerContext")
	}
	if _, err := execer.ExecContext(ctx, `SET TIME ZONE 'UTC'`, nil); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("pin postgres session to UTC: %w", err)
	}

	return conn, nil
}

func runMigrations(db *sql.DB, driverName string) error {
	var (
		src      source.Driver
		dbDriver migratedatabase.Driver
		err      error
	)

	switch driverName {
	case driverSQLite:
		src, err = iofs.New(sqliteMigrationsFS, "migrations/sqlite")
		if err != nil {
			return fmt.Errorf("create sqlite migration source: %w", err)
		}
		dbDriver, err = sqlitemigrate.WithInstance(db, &sqlitemigrate.Config{})
		if err != nil {
			return fmt.Errorf("create sqlite migration driver: %w", err)
		}
	case driverPostgres:
		src, err = iofs.New(postgresMigrationsFS, "migrations/postgres")
		if err != nil {
			return fmt.Errorf("create postgres migration source: %w", err)
		}
		// postgresmigrate.WithInstance checks out a dedicated *sql.Conn for its
		// session-scoped advisory lock and only releases it when the driver is
		// closed — but closing the driver would also close db, which the caller
		// still needs. Check out and release the connection ourselves instead,
		// via WithConnection, so it doesn't leak for the rest of db's lifetime.
		var conn *sql.Conn
		conn, err = db.Conn(context.Background())
		if err != nil {
			return fmt.Errorf("checkout postgres migration connection: %w", err)
		}
		defer func() { _ = conn.Close() }()
		dbDriver, err = postgresmigrate.WithConnection(context.Background(), conn, &postgresmigrate.Config{})
		if err != nil {
			return fmt.Errorf("create postgres migration driver: %w", err)
		}
	default:
		return fmt.Errorf("unsupported database driver: %s", driverName)
	}

	m, err := migrate.NewWithInstance("iofs", src, driverName, dbDriver)
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
