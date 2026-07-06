// Package telemetry initializes the OpenTelemetry SDK and registers global
// TracerProvider, MeterProvider, and LoggerProvider instances used throughout
// the server.
package telemetry

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/sirupsen/logrus"
	goruntime "go.opentelemetry.io/contrib/instrumentation/runtime"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	promexporter "go.opentelemetry.io/otel/exporters/prometheus"
	"go.opentelemetry.io/otel/exporters/stdout/stdoutlog"
	"go.opentelemetry.io/otel/exporters/stdout/stdouttrace"
	"go.opentelemetry.io/otel/log"
	"go.opentelemetry.io/otel/log/global"
	lognoop "go.opentelemetry.io/otel/log/noop"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
	tracenoop "go.opentelemetry.io/otel/trace/noop"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
)

// Config holds OpenTelemetry configuration values loaded from environment variables.
type Config struct {
	// Endpoint is the OTLP gRPC endpoint (e.g. "localhost:4317").
	// When empty, stdout exporters are used for traces and logs (useful for
	// development and debugging). Metrics are always exposed via /metrics
	// regardless of this setting.
	Endpoint string

	// ServiceName is the service name reported in all traces, metrics, and logs.
	// Defaults to "jot".
	ServiceName string

	// ServiceVersion is the application version reported in all traces, metrics,
	// and logs. Set from the build-time version string (e.g. "v1.2.3" or "dev").
	ServiceVersion string

	// Insecure controls whether OTLP gRPC connections skip TLS verification.
	// Set to true only for local collectors or development environments.
	// Defaults to false (TLS enabled).
	Insecure bool

	// TracesEnabled controls whether the trace pipeline is set up at all.
	// Defaults to false: many collectors are only configured with metrics/logs
	// pipelines, and exporting traces to one without a traces pipeline produces
	// a steady stream of "Unimplemented" export errors. When false, a noop
	// TracerProvider is registered instead so span creation stays a no-op.
	TracesEnabled bool

	// MetricsEnabled controls whether metrics are pushed to the configured
	// OTLP endpoint. Defaults to false. This only affects the OTLP periodic
	// reader; the Prometheus reader backing the /metrics handler is
	// unaffected and always registered whenever OTel is set up at all.
	MetricsEnabled bool

	// LogsEnabled controls whether the log pipeline is set up at all.
	// Defaults to false. When false, a noop LoggerProvider is registered
	// instead so log forwarding stays a no-op.
	LogsEnabled bool
}

// Setup initializes the OpenTelemetry SDK according to cfg and registers the
// resulting TracerProvider, MeterProvider, and LoggerProvider as globals. The
// returned shutdown function must be called (typically via defer) to flush and
// stop exporters.
//
// There is no single on/off switch: Setup runs whenever at least one of
// TracesEnabled, MetricsEnabled, or LogsEnabled is true. The Prometheus metric
// reader is always registered with prometheus.DefaultRegisterer in that case,
// so the /metrics handler (mounted separately by the server) will serve OTel
// custom metrics alongside the default Go runtime metrics, regardless of
// MetricsEnabled.
//
// When all three are false, noop providers are already the default globals;
// nothing to do.
func Setup(ctx context.Context, cfg Config) (shutdown func(context.Context) error, err error) {
	if !cfg.TracesEnabled && !cfg.MetricsEnabled && !cfg.LogsEnabled {
		// Noop providers are already the default globals; nothing to do.
		return func(_ context.Context) error { return nil }, nil
	}

	res, err := resource.New(ctx,
		resource.WithProcess(),
		resource.WithHost(),
		resource.WithTelemetrySDK(),
		// WithFromEnv reads standard OTel resource attributes from
		// OTEL_RESOURCE_ATTRIBUTES (e.g. "deployment.environment=production"),
		// which lets a single Jot binary/image be told apart in shared
		// dashboards (like grafana/dashboard.json) when multiple instances
		// (prod, test, staging, ...) report to the same backend.
		resource.WithFromEnv(),
		resource.WithAttributes(
			semconv.ServiceName(cfg.ServiceName),
			semconv.ServiceVersion(cfg.ServiceVersion),
		),
	)
	if err != nil {
		if !errors.Is(err, resource.ErrPartialResource) && !errors.Is(err, resource.ErrSchemaURLConflict) {
			return nil, fmt.Errorf("create OTel resource: %w", err)
		}
		// ErrPartialResource and ErrSchemaURLConflict are non-fatal: the resource
		// is still usable; a detector simply couldn't populate some attributes or
		// produced a conflicting schema URL.
		logrus.WithError(err).Warn("OTel resource is partial; some attributes may be missing")
	}

	// runtimeProducer supplies the goroutine scheduling-latency histogram
	// (go.schedule.duration, queried by the shipped dashboard as
	// go_schedule_duration_seconds) out of band. goruntime.Start below only
	// registers the regular async instruments (goroutine count, memory
	// stats); without this producer attached to a reader, scheduling latency
	// is silently never collected.
	runtimeProducer := goruntime.NewProducer()

	// Prometheus exporter: registers with prometheus.DefaultRegisterer so that
	// the /metrics handler serves OTel custom metrics alongside Go runtime stats.
	//
	// WithResourceAsConstantLabels attaches deployment.environment (and
	// service.name) as a label on every exported metric, not just the
	// separate target_info series the exporter emits by default. The shipped
	// Grafana dashboard (grafana/dashboard.json) filters and groups on the
	// resulting deployment_environment label to tell prod and test instances
	// apart when they report to the same Prometheus.
	promExp, err := promexporter.New(
		promexporter.WithResourceAsConstantLabels(
			attribute.NewAllowKeysFilter(semconv.ServiceNameKey, semconv.DeploymentEnvironmentKey),
		),
		promexporter.WithProducer(runtimeProducer),
	)
	if err != nil {
		return nil, fmt.Errorf("create Prometheus exporter: %w", err)
	}

	var (
		tp        trace.TracerProvider
		mp        *metric.MeterProvider
		lp        log.LoggerProvider
		shutdowns []func(context.Context) error
	)

	if cfg.Endpoint != "" {
		tp, mp, lp, shutdowns, err = setupOTLP(ctx, res, cfg.Endpoint, cfg.Insecure, cfg.TracesEnabled, cfg.MetricsEnabled, cfg.LogsEnabled, promExp, runtimeProducer)
	} else {
		tp, mp, lp, shutdowns, err = setupStdout(ctx, res, cfg.TracesEnabled, cfg.LogsEnabled, promExp)
	}
	if err != nil {
		return nil, fmt.Errorf("setup OTel providers: %w", err)
	}

	// Use a dedicated logger without hooks to avoid a re-entrancy loop:
	// the global logrus logger has an otellogrus hook that routes entries back
	// into the OTel pipeline, so using it here would cause OTel export errors
	// to trigger further OTel exports indefinitely.
	otelErrLogger := logrus.New()
	otelErrLogger.SetFormatter(logrus.StandardLogger().Formatter)
	otelErrLogger.SetOutput(logrus.StandardLogger().Out)
	otelErrLogger.SetLevel(logrus.StandardLogger().GetLevel())
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(err error) {
		otelErrLogger.WithError(err).Warn("OpenTelemetry export error")
	}))
	otel.SetTracerProvider(tp)
	otel.SetMeterProvider(mp)
	global.SetLoggerProvider(lp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	if err := goruntime.Start(goruntime.WithMeterProvider(mp)); err != nil {
		for _, fn := range shutdowns {
			_ = fn(ctx)
		}
		return nil, fmt.Errorf("start runtime metrics: %w", err)
	}

	return func(ctx context.Context) error {
		var firstErr error
		for _, fn := range shutdowns {
			if e := fn(ctx); e != nil && firstErr == nil {
				firstErr = e
			}
		}
		return firstErr
	}, nil
}

// initTracerProvider returns a noop TracerProvider when tracesEnabled is
// false, otherwise builds a real one from the exporter produced by newExporter.
func initTracerProvider(tracesEnabled bool, res *resource.Resource, newExporter func() (sdktrace.SpanExporter, error)) (trace.TracerProvider, []func(context.Context) error, error) {
	if !tracesEnabled {
		return tracenoop.NewTracerProvider(), nil, nil
	}
	exporter, err := newExporter()
	if err != nil {
		return nil, nil, err
	}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
	)
	return tp, []func(context.Context) error{tp.Shutdown}, nil
}

// initLoggerProvider returns a noop LoggerProvider when logsEnabled is
// false, otherwise builds a real one from the exporter produced by newExporter.
func initLoggerProvider(logsEnabled bool, res *resource.Resource, newExporter func() (sdklog.Exporter, error)) (log.LoggerProvider, []func(context.Context) error, error) {
	if !logsEnabled {
		return lognoop.NewLoggerProvider(), nil, nil
	}
	exporter, err := newExporter()
	if err != nil {
		return nil, nil, err
	}
	lp := sdklog.NewLoggerProvider(
		sdklog.WithProcessor(sdklog.NewBatchProcessor(exporter)),
		sdklog.WithResource(res),
	)
	return lp, []func(context.Context) error{lp.Shutdown}, nil
}

func setupOTLP(ctx context.Context, res *resource.Resource, endpoint string, insecureConn bool, tracesEnabled, metricsEnabled, logsEnabled bool, promExp *promexporter.Exporter, runtimeProducer metric.Producer) (trace.TracerProvider, *metric.MeterProvider, log.LoggerProvider, []func(context.Context) error, error) {
	var creds credentials.TransportCredentials
	if insecureConn {
		creds = insecure.NewCredentials()
	} else {
		creds = credentials.NewTLS(nil)
	}

	conn, err := grpc.NewClient(endpoint, grpc.WithTransportCredentials(creds))
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("create OTLP gRPC connection: %w", err)
	}

	tp, shutdowns, err := initTracerProvider(tracesEnabled, res, func() (sdktrace.SpanExporter, error) {
		return otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
	})
	if err != nil {
		_ = conn.Close()
		return nil, nil, nil, nil, fmt.Errorf("create OTLP trace exporter: %w", err)
	}

	// Both readers are registered when metricsEnabled: Prometheus for
	// pull-based scraping at /metrics, and OTLP for push-based export to the
	// configured collector. When disabled, only the Prometheus reader is used.
	metricOpts := []metric.Option{metric.WithReader(promExp), metric.WithResource(res)}
	if metricsEnabled {
		metricExporter, metricErr := otlpmetricgrpc.New(ctx, otlpmetricgrpc.WithGRPCConn(conn))
		if metricErr != nil {
			for _, fn := range shutdowns {
				_ = fn(ctx)
			}
			_ = conn.Close()
			return nil, nil, nil, nil, fmt.Errorf("create OTLP metric exporter: %w", metricErr)
		}
		metricOpts = append(metricOpts, metric.WithReader(metric.NewPeriodicReader(metricExporter, metric.WithProducer(runtimeProducer))))
	}
	mp := metric.NewMeterProvider(metricOpts...)

	lp, logShutdowns, err := initLoggerProvider(logsEnabled, res, func() (sdklog.Exporter, error) {
		return otlploggrpc.New(ctx, otlploggrpc.WithGRPCConn(conn))
	})
	if err != nil {
		for _, fn := range shutdowns {
			_ = fn(ctx)
		}
		_ = mp.Shutdown(ctx)
		_ = conn.Close()
		return nil, nil, nil, nil, fmt.Errorf("create OTLP log exporter: %w", err)
	}
	shutdowns = append(shutdowns, logShutdowns...)

	// conn.Close is last: exporters must flush before the connection closes.
	shutdowns = append(shutdowns,
		mp.Shutdown,
		func(_ context.Context) error { return conn.Close() },
	)
	return tp, mp, lp, shutdowns, nil
}

func setupStdout(ctx context.Context, res *resource.Resource, tracesEnabled, logsEnabled bool, promExp *promexporter.Exporter) (trace.TracerProvider, *metric.MeterProvider, log.LoggerProvider, []func(context.Context) error, error) {
	tp, shutdowns, err := initTracerProvider(tracesEnabled, res, func() (sdktrace.SpanExporter, error) {
		return stdouttrace.New(stdouttrace.WithWriter(os.Stdout))
	})
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("create stdout trace exporter: %w", err)
	}

	lp, logShutdowns, err := initLoggerProvider(logsEnabled, res, func() (sdklog.Exporter, error) {
		return stdoutlog.New(stdoutlog.WithWriter(os.Stdout))
	})
	if err != nil {
		for _, fn := range shutdowns {
			_ = fn(ctx)
		}
		return nil, nil, nil, nil, fmt.Errorf("create stdout log exporter: %w", err)
	}
	shutdowns = append(shutdowns, logShutdowns...)

	// Prometheus is the only metric reader in dev mode; there is no OTLP endpoint
	// to push to, and stdout metric export would duplicate /metrics output.
	mp := metric.NewMeterProvider(
		metric.WithReader(promExp),
		metric.WithResource(res),
	)

	shutdowns = append(shutdowns, mp.Shutdown)
	return tp, mp, lp, shutdowns, nil
}
