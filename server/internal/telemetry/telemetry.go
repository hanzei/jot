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

func setupOTLP(ctx context.Context, res *resource.Resource, endpoint string, insecure bool, promExp *promexporter.Exporter) (*sdktrace.TracerProvider, *metric.MeterProvider, *sdklog.LoggerProvider, []func(context.Context) error, error) {
	traceOpts := []otlptracegrpc.Option{otlptracegrpc.WithEndpoint(endpoint)}
	metricOpts := []otlpmetricgrpc.Option{otlpmetricgrpc.WithEndpoint(endpoint)}
	logOpts := []otlploggrpc.Option{otlploggrpc.WithEndpoint(endpoint)}
	if insecure {
		traceOpts = append(traceOpts, otlptracegrpc.WithInsecure())
		metricOpts = append(metricOpts, otlpmetricgrpc.WithInsecure())
		logOpts = append(logOpts, otlploggrpc.WithInsecure())
	}

	traceExporter, err := otlptracegrpc.New(ctx, traceOpts...)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("create OTLP trace exporter: %w", err)
	}

	metricExporter, err := otlpmetricgrpc.New(ctx, metricOpts...)
	if err != nil {
		_ = traceExporter.Shutdown(ctx)
		return nil, nil, nil, nil, fmt.Errorf("create OTLP metric exporter: %w", err)
	}

	logExporter, err := otlploggrpc.New(ctx, logOpts...)
	if err != nil {
		_ = traceExporter.Shutdown(ctx)
		_ = metricExporter.Shutdown(ctx)
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

	shutdowns := []func(context.Context) error{tp.Shutdown, mp.Shutdown, lp.Shutdown}
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
