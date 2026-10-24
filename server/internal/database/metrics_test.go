package database

import (
	"testing"
	"time"

	"github.com/hanzei/jot/server/internal/database/dsntest"
	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	promexporter "go.opentelemetry.io/otel/exporters/prometheus"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
)

// TestRegisterPoolMetrics checks the pool metrics as /metrics serves them:
// through the same Prometheus exporter, so the assertions pin the exported
// names the shipped Grafana dashboard queries.
func TestRegisterPoolMetrics(t *testing.T) {
	t.Parallel()

	db, err := New("sqlite", dsntest.IsolatedDSN(t, "sqlite"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	registry := prometheus.NewRegistry()
	exporter, err := promexporter.New(promexporter.WithRegisterer(registry))
	require.NoError(t, err)
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(exporter))
	t.Cleanup(func() { _ = provider.Shutdown(t.Context()) })

	reg, err := RegisterPoolMetrics(provider.Meter("test"), db, "sqlite")
	require.NoError(t, err)
	t.Cleanup(func() { _ = reg.Unregister() })

	// Hold SQLite's only connection so a second caller has to queue for it.
	conn, err := db.Conn(t.Context())
	require.NoError(t, err)
	queried := make(chan error, 1)
	go func() {
		_, err := db.ExecContext(t.Context(), "SELECT 1")
		queried <- err
	}()
	require.Eventually(t, func() bool { return db.Stats().WaitCount > 0 }, 5*time.Second, time.Millisecond)

	families := gather(t, registry)
	assert.InDelta(t, 1, gaugeValue(t, families, "db_client_connection_count", "used"), 0)
	assert.InDelta(t, 1, gaugeValue(t, families, "db_client_connection_max", ""), 0)
	assert.InDelta(t, 1, counterValue(t, families, "db_client_connection_waits_total"), 0)

	time.Sleep(10 * time.Millisecond)
	require.NoError(t, conn.Close())
	require.NoError(t, <-queried)

	families = gather(t, registry)
	assert.InDelta(t, 0, gaugeValue(t, families, "db_client_connection_count", "used"), 0)
	assert.InDelta(t, 1, gaugeValue(t, families, "db_client_connection_count", "idle"), 0)
	assert.GreaterOrEqual(t, counterValue(t, families, "db_client_connection_wait_duration_seconds_total"), 0.01)
}

func gather(t *testing.T, registry *prometheus.Registry) map[string]*dto.MetricFamily {
	t.Helper()
	families, err := registry.Gather()
	require.NoError(t, err)
	byName := make(map[string]*dto.MetricFamily, len(families))
	for _, f := range families {
		byName[f.GetName()] = f
	}
	return byName
}

// findMetric returns the series of family name whose connection-state label
// is state ("" for a series without one), checking that every series carries
// the pool name.
func findMetric(t *testing.T, families map[string]*dto.MetricFamily, name, state string) *dto.Metric {
	t.Helper()
	family, ok := families[name]
	require.True(t, ok, "metric family %s not exported", name)
	for _, m := range family.GetMetric() {
		labels := map[string]string{}
		for _, l := range m.GetLabel() {
			labels[l.GetName()] = l.GetValue()
		}
		assert.Equal(t, "sqlite", labels["db_client_connection_pool_name"], "%s pool name", name)
		if labels["db_client_connection_state"] == state {
			return m
		}
	}
	require.Failf(t, "series not found", "%s{db_client_connection_state=%q}", name, state)
	return nil
}

func gaugeValue(t *testing.T, families map[string]*dto.MetricFamily, name, state string) float64 {
	t.Helper()
	return findMetric(t, families, name, state).GetGauge().GetValue()
}

func counterValue(t *testing.T, families map[string]*dto.MetricFamily, name string) float64 {
	t.Helper()
	return findMetric(t, families, name, "").GetCounter().GetValue()
}
