package telemetry

import (
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
)

// TestSetupExposesDeploymentEnvironmentLabel verifies that resource
// attributes set via the standard OTEL_RESOURCE_ATTRIBUTES environment
// variable (e.g. "deployment.environment=test") end up as a label on every
// exported Prometheus metric, not just the separate target_info series. The
// shipped Grafana dashboard (grafana/dashboard.json) relies on this label to
// tell prod and test instances of the same Jot binary apart.
func TestSetupExposesDeploymentEnvironmentLabel(t *testing.T) {
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "deployment.environment=test-env")

	shutdown, err := Setup(t.Context(), Config{
		ServiceName:    "jot-telemetry-test",
		MetricsEnabled: true,
	})
	require.NoError(t, err)
	t.Cleanup(func() {
		require.NoError(t, shutdown(t.Context()))
	})

	counter, err := otel.Meter("jot-telemetry-test").Int64Counter("telemetry_test_counter")
	require.NoError(t, err)
	counter.Add(t.Context(), 1)

	families, err := prometheus.DefaultGatherer.Gather()
	require.NoError(t, err)

	var found bool
	for _, family := range families {
		if family.GetName() != "telemetry_test_counter_total" {
			continue
		}
		for _, metric := range family.GetMetric() {
			for _, label := range metric.GetLabel() {
				if label.GetName() == "deployment_environment" && label.GetValue() == "test-env" {
					found = true
				}
			}
		}
	}
	require.True(t, found, "expected telemetry_test_counter_total to carry a deployment_environment=test-env label")
}
