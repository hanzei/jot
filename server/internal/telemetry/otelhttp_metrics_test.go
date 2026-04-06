package telemetry_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	promexporter "go.opentelemetry.io/otel/exporters/prometheus"
	"go.opentelemetry.io/otel/sdk/metric"
)

// TestOTelHTTPMetricsRecorded verifies that the otelhttp middleware records
// http.server.request.duration, http.server.request.body.size, and
// http.server.response.body.size observations that are visible in the
// Prometheus output after at least one request completes.
//
// The OTel Prometheus exporter suppresses histograms that have zero DataPoints,
// so these metrics only appear after the first HTTP handler returns through the
// otelhttp middleware.
func TestOTelHTTPMetricsRecorded(t *testing.T) {
	// Use an isolated Prometheus registry so this test does not interfere with
	// the default registry used by the server (and vice-versa).
	reg := prometheus.NewRegistry()

	promExp, err := promexporter.New(promexporter.WithRegisterer(reg))
	require.NoError(t, err, "create Prometheus exporter")

	mp := metric.NewMeterProvider(metric.WithReader(promExp))
	t.Cleanup(func() { _ = mp.Shutdown(context.Background()) })

	// Wire up a minimal HTTP handler through the otelhttp middleware, using
	// the test-local MeterProvider so we do not touch the process-global.
	handler := otelhttp.NewHandler(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("ok"))
		}),
		"test",
		otelhttp.WithMeterProvider(mp),
	)

	// Perform a request so RecordMetrics is called.
	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)

	// Gather from the isolated registry and render to text, the same format
	// Prometheus scrapes.
	metricsRec := httptest.NewRecorder()
	promhttp.HandlerFor(reg, promhttp.HandlerOpts{}).ServeHTTP(metricsRec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	body := metricsRec.Body.String()

	t.Logf("Prometheus /metrics output:\n%s", body)

	// All three OTel HTTP server histograms must appear with at least one
	// observation (bucket + count + sum lines).
	for _, metricName := range []string{
		"http_server_request_duration_seconds",
		"http_server_request_body_size_bytes",
		"http_server_response_body_size_bytes",
	} {
		assert.Contains(t, body, metricName+"_bucket",
			"expected %s_bucket to appear in /metrics output", metricName)
		assert.Contains(t, body, metricName+"_count",
			"expected %s_count to appear in /metrics output", metricName)
	}
}
