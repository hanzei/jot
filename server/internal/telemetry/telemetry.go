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
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	promexporter "go.opentelemetry.io/otel/exporters/prometheus"
	"go.opentelemetry.io/otel/exporters/stdout/stdoutlog"
	"go.opentelemetry.io/otel/exporters/stdout/stdouttrace"
	"go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
)

// Config holds OpenTelemetry configuration values loaded from environment variables.
type Config struct {
	// Enabled controls whether OTel instrumentation is active.
	// When false, noop providers are registered and all instrumentation
	// calls are no-ops with zero overhead.
	Enabled bool

	// Endpoint is the OTLP gRPC endpoint (e.g. "localhost:4317").
	// When empty and Enabled is true, stdout exporters are used for
	// traces and logs (useful for development and debugging).
	// Metrics are always exposed via /metrics regardless of this setting.
	Endpoint string

	// ServiceName is the service name reported in all traces, metrics, and logs.
	// Defaults to "jot".
	ServiceName string

	// Insecure controls whether OTLP gRPC connections skip TLS verification.
	// Set to true only for local collectors or development environments.
	// Defaults to false (TLS enabled).
	Insecure bool
}

// Setup initializes the OpenTelemetry SDK according to cfg and registers the
// resulting TracerProvider, MeterProvider, and LoggerProvider as globals. The
// returned shutdown function must be called (typically via defer) to flush and
// stop exporters.
//
// The Prometheus metric reader is always registered with prometheus.DefaultRegisterer
// when cfg.Enabled is true, so the /metrics handler (mounted separately by the
// server) will serve OTel custom metrics alongside the default Go runtime metrics.
//
// When cfg.Enabled is false, noop providers are already the default globals;
// nothing to do.
func Setup(ctx context.Context, cfg Config) (shutdown func(context.Context) error, err error) {
	if !cfg.Enabled {
		// Noop providers are already the default globals; nothing to do.
		return func(_ context.Context) error { return nil }, nil
	}

	res, err := resource.New(ctx,
		resource.WithProcess(),
		resource.WithHost(),
		resource.WithTelemetrySDK(),
		resource.WithAttributes(semconv.ServiceName(cfg.ServiceName)),
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

	// Prometheus exporter: registers with prometheus.DefaultRegisterer so that
	// the /metrics handler serves OTel custom metrics alongside Go runtime stats.
	promExp, err := promexporter.New()
	if err != nil {
		return nil, fmt.Errorf("create Prometheus exporter: %w", err)
	}

	var (
		tp        *sdktrace.TracerProvider
		mp        *metric.MeterProvider
		lp        *sdklog.LoggerProvider
		shutdowns []func(context.Context) error
	)

	if cfg.Endpoint != "" {
		tp, mp, lp, shutdowns, err = setupOTLP(ctx, res, cfg.Endpoint, cfg.Insecure, promExp)
	} else {
		tp, mp, lp, shutdowns, err = setupStdout(ctx, res, promExp)
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

func setupOTLP(ctx context.Context, res *resource.Resource, endpoint string, insecureConn bool, promExp *promexporter.Exporter) (*sdktrace.TracerProvider, *metric.MeterProvider, *sdklog.LoggerProvider, []func(context.Context) error, error) {
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

	traceExporter, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
	if err != nil {
		_ = conn.Close()
		return nil, nil, nil, nil, fmt.Errorf("create OTLP trace exporter: %w", err)
	}

	metricExporter, err := otlpmetricgrpc.New(ctx, otlpmetricgrpc.WithGRPCConn(conn))
	if err != nil {
		_ = traceExporter.Shutdown(ctx)
		_ = conn.Close()
		return nil, nil, nil, nil, fmt.Errorf("create OTLP metric exporter: %w", err)
	}

	logExporter, err := otlploggrpc.New(ctx, otlploggrpc.WithGRPCConn(conn))
	if err != nil {
		_ = traceExporter.Shutdown(ctx)
		_ = metricExporter.Shutdown(ctx)
		_ = conn.Close()
		return nil, nil, nil, nil, fmt.Errorf("create OTLP log exporter: %w", err)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(traceExporter),
		sdktrace.WithResource(res),
	)
	// Both readers are registered: Prometheus for pull-based scraping at /metrics,
	// and OTLP for push-based export to the configured collector.
	mp := metric.NewMeterProvider(
		metric.WithReader(promExp),
		metric.WithReader(metric.NewPeriodicReader(metricExporter)),
		metric.WithResource(res),
	)
	lp := sdklog.NewLoggerProvider(
		sdklog.WithProcessor(sdklog.NewBatchProcessor(logExporter)),
		sdklog.WithResource(res),
	)

	// conn.Close is last: exporters must flush before the connection closes.
	shutdowns := []func(context.Context) error{
		tp.Shutdown,
		mp.Shutdown,
		lp.Shutdown,
		func(_ context.Context) error { return conn.Close() },
	}
	return tp, mp, lp, shutdowns, nil
}

func setupStdout(ctx context.Context, res *resource.Resource, promExp *promexporter.Exporter) (*sdktrace.TracerProvider, *metric.MeterProvider, *sdklog.LoggerProvider, []func(context.Context) error, error) {
	traceExporter, err := stdouttrace.New(stdouttrace.WithWriter(os.Stdout))
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("create stdout trace exporter: %w", err)
	}

	logExporter, err := stdoutlog.New(stdoutlog.WithWriter(os.Stdout))
	if err != nil {
		_ = traceExporter.Shutdown(ctx)
		return nil, nil, nil, nil, fmt.Errorf("create stdout log exporter: %w", err)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(traceExporter),
		sdktrace.WithResource(res),
	)
	// Prometheus is the only metric reader in dev mode; there is no OTLP endpoint
	// to push to, and stdout metric export would duplicate /metrics output.
	mp := metric.NewMeterProvider(
		metric.WithReader(promExp),
		metric.WithResource(res),
	)
	lp := sdklog.NewLoggerProvider(
		sdklog.WithProcessor(sdklog.NewBatchProcessor(logExporter)),
		sdklog.WithResource(res),
	)

	shutdowns := []func(context.Context) error{tp.Shutdown, mp.Shutdown, lp.Shutdown}
	return tp, mp, lp, shutdowns, nil
}
