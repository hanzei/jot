package database

import (
	"context"
	"database/sql"
	"fmt"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	semconv "go.opentelemetry.io/otel/semconv/v1.40.0"
)

// RegisterPoolMetrics registers observable instruments that read db.Stats()
// on every collection. The caller must Unregister the result before closing
// db, or the meter keeps calling Stats on a closed pool.
//
// The connection count and maximum use the OTel semantic-convention names.
// Semconv's wait metric is a per-wait histogram, which database/sql's
// cumulative totals cannot feed, so the two wait counters are Jot's own,
// named alongside it.
//
// On SQLite the pool holds a single connection (see New), so the wait
// counters are the signal for one slow operation stalling every other
// request: they climb whenever a caller queues behind the connection.
func RegisterPoolMetrics(meter metric.Meter, db *sql.DB, poolName string) (metric.Registration, error) {
	count, err := meter.Int64ObservableUpDownCounter(
		"db.client.connection.count",
		metric.WithUnit("{connection}"),
		metric.WithDescription("Number of connections currently in the pool, by state"),
	)
	if err != nil {
		return nil, fmt.Errorf("create db.client.connection.count instrument: %w", err)
	}

	maxConns, err := meter.Int64ObservableUpDownCounter(
		"db.client.connection.max",
		metric.WithUnit("{connection}"),
		metric.WithDescription("Maximum number of open connections allowed; 0 means unlimited"),
	)
	if err != nil {
		return nil, fmt.Errorf("create db.client.connection.max instrument: %w", err)
	}

	waits, err := meter.Int64ObservableCounter(
		"db.client.connection.waits",
		metric.WithUnit("{wait}"),
		metric.WithDescription("Total times a caller had to wait for a free connection"),
	)
	if err != nil {
		return nil, fmt.Errorf("create db.client.connection.waits instrument: %w", err)
	}

	waitDuration, err := meter.Float64ObservableCounter(
		"db.client.connection.wait.duration",
		metric.WithUnit("s"),
		metric.WithDescription("Total time callers spent waiting for a free connection"),
	)
	if err != nil {
		return nil, fmt.Errorf("create db.client.connection.wait.duration instrument: %w", err)
	}

	pool := semconv.DBClientConnectionPoolName(poolName)
	poolOnly := metric.WithAttributeSet(attribute.NewSet(pool))
	idle := metric.WithAttributeSet(attribute.NewSet(pool, semconv.DBClientConnectionStateIdle))
	used := metric.WithAttributeSet(attribute.NewSet(pool, semconv.DBClientConnectionStateUsed))

	reg, err := meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		stats := db.Stats()
		o.ObserveInt64(count, int64(stats.Idle), idle)
		o.ObserveInt64(count, int64(stats.InUse), used)
		o.ObserveInt64(maxConns, int64(stats.MaxOpenConnections), poolOnly)
		o.ObserveInt64(waits, stats.WaitCount, poolOnly)
		o.ObserveFloat64(waitDuration, stats.WaitDuration.Seconds(), poolOnly)
		return nil
	}, count, maxConns, waits, waitDuration)
	if err != nil {
		return nil, fmt.Errorf("register connection pool metrics callback: %w", err)
	}
	return reg, nil
}
