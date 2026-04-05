// Package telemetry initialises the OpenTelemetry SDK and registers global
// TracerProvider and MeterProvider instances used throughout the server.
package telemetry

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/sirupsen/logrus"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/exporters/stdout/stdoutmetric"
	"go.opentelemetry.io/otel/exporters/stdout/stdouttrace"
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
	// When empty and Enabled is true, stdout exporters are used instead
	// (useful for development and debugging).
	Endpoint string

	// ServiceName is the service name reported in all traces and metrics.
	// Defaults to "jot".
	ServiceName string
}

// Setup initialises the OpenTelemetry SDK according to cfg and registers the
// resulting TracerProvider and MeterProvider as globals. The returned shutdown
// function must be called (typically via defer) to flush and stop exporters.
//
// When cfg.Enabled is false, noop providers are registered so all
// instrumentation calls compile and run without effect.
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

	var (
		tp       *sdktrace.TracerProvider
		mp       *metric.MeterProvider
		shutdowns []func(context.Context) error
	)

	if cfg.Endpoint != "" {
		tp, mp, shutdowns, err = setupOTLP(ctx, res, cfg.Endpoint)
	} else {
		tp, mp, shutdowns, err = setupStdout(ctx, res)
	}
	if err != nil {
		return nil, err
	}

	otel.SetTracerProvider(tp)
	otel.SetMeterProvider(mp)

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

func setupOTLP(ctx context.Context, res *resource.Resource, endpoint string) (*sdktrace.TracerProvider, *metric.MeterProvider, []func(context.Context) error, error) {
	traceExporter, err := otlptracegrpc.New(ctx,
		otlptracegrpc.WithEndpoint(endpoint),
		otlptracegrpc.WithInsecure(),
	)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("create OTLP trace exporter: %w", err)
	}

	metricExporter, err := otlpmetricgrpc.New(ctx,
		otlpmetricgrpc.WithEndpoint(endpoint),
		otlpmetricgrpc.WithInsecure(),
	)
	if err != nil {
		_ = traceExporter.Shutdown(ctx)
		return nil, nil, nil, fmt.Errorf("create OTLP metric exporter: %w", err)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(traceExporter),
		sdktrace.WithResource(res),
	)
	mp := metric.NewMeterProvider(
		metric.WithReader(metric.NewPeriodicReader(metricExporter)),
		metric.WithResource(res),
	)

	shutdowns := []func(context.Context) error{tp.Shutdown, mp.Shutdown}
	return tp, mp, shutdowns, nil
}

func setupStdout(ctx context.Context, res *resource.Resource) (*sdktrace.TracerProvider, *metric.MeterProvider, []func(context.Context) error, error) {
	traceExporter, err := stdouttrace.New(stdouttrace.WithWriter(os.Stdout))
	if err != nil {
		return nil, nil, nil, fmt.Errorf("create stdout trace exporter: %w", err)
	}

	metricExporter, err := stdoutmetric.New(stdoutmetric.WithWriter(os.Stdout))
	if err != nil {
		_ = traceExporter.Shutdown(ctx)
		return nil, nil, nil, fmt.Errorf("create stdout metric exporter: %w", err)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(traceExporter),
		sdktrace.WithResource(res),
	)
	mp := metric.NewMeterProvider(
		metric.WithReader(metric.NewPeriodicReader(metricExporter)),
		metric.WithResource(res),
	)

	shutdowns := []func(context.Context) error{tp.Shutdown, mp.Shutdown}
	return tp, mp, shutdowns, nil
}
