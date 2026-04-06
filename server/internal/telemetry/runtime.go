package telemetry

import (
	"context"
	"fmt"
	"runtime"

	"go.opentelemetry.io/otel/metric"
)

// startRuntimeMetrics registers asynchronous Go runtime observers with the
// provided MeterProvider. The callbacks are invoked by OTel readers on each
// collection cycle (Prometheus scrape or OTLP periodic push), so no
// background goroutine is needed and runtime.ReadMemStats is only called when
// metrics are actually being collected.
//
// Metrics exported:
//
//   - process.runtime.go.goroutines        – current goroutine count
//   - process.runtime.go.mem.heap_alloc    – bytes of allocated heap objects
//   - process.runtime.go.mem.heap_in_use   – bytes in in-use heap spans
//   - process.runtime.go.mem.heap_objects  – number of allocated heap objects
//   - process.runtime.go.mem.live_objects  – Mallocs minus Frees (live objects)
//   - process.runtime.go.gc.count          – cumulative completed GC cycles
//   - process.runtime.go.gc.pause_total_ns – cumulative GC stop-the-world ns
func startRuntimeMetrics(mp metric.MeterProvider) error {
	meter := mp.Meter("go.runtime")

	// --- goroutines (runtime.NumGoroutine returns int, safe for int64) ----

	goroutines, err := meter.Int64ObservableGauge(
		"process.runtime.go.goroutines",
		metric.WithDescription("Number of goroutines that currently exist."),
		metric.WithUnit("{goroutine}"),
	)
	if err != nil {
		return fmt.Errorf("create goroutines gauge: %w", err)
	}

	if _, err := meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		o.ObserveInt64(goroutines, int64(runtime.NumGoroutine()))
		return nil
	}, goroutines); err != nil {
		return fmt.Errorf("register goroutines callback: %w", err)
	}

	// --- memory stats -------------------------------------------------------
	//
	// Byte quantities use float64 to avoid G115 (uint64→int64 overflow lint).
	// Object counts and GC counters use int64; values are bounded in practice
	// (heap objects in the millions, GC cycles in the millions) and will not
	// overflow int64.
	//
	// All memory instruments share one callback so that runtime.ReadMemStats
	// (which briefly stops the world) is called exactly once per collection
	// cycle. The MemStats value is declared inside the callback so each
	// invocation gets its own stack-local copy, avoiding data races when
	// multiple readers collect concurrently.

	heapAlloc, err := meter.Float64ObservableGauge(
		"process.runtime.go.mem.heap_alloc",
		metric.WithDescription("Bytes of allocated heap objects."),
		metric.WithUnit("By"),
	)
	if err != nil {
		return fmt.Errorf("create heap_alloc gauge: %w", err)
	}

	heapInUse, err := meter.Float64ObservableGauge(
		"process.runtime.go.mem.heap_in_use",
		metric.WithDescription("Bytes in in-use heap spans."),
		metric.WithUnit("By"),
	)
	if err != nil {
		return fmt.Errorf("create heap_in_use gauge: %w", err)
	}

	heapObjects, err := meter.Int64ObservableGauge(
		"process.runtime.go.mem.heap_objects",
		metric.WithDescription("Number of allocated heap objects."),
		metric.WithUnit("{object}"),
	)
	if err != nil {
		return fmt.Errorf("create heap_objects gauge: %w", err)
	}

	liveObjects, err := meter.Int64ObservableGauge(
		"process.runtime.go.mem.live_objects",
		metric.WithDescription("Number of live objects (cumulative Mallocs minus cumulative Frees)."),
		metric.WithUnit("{object}"),
	)
	if err != nil {
		return fmt.Errorf("create live_objects gauge: %w", err)
	}

	// GC counters are monotonically increasing; ObservableCounter lets
	// Prometheus and OTLP backends compute per-interval rates.
	gcCount, err := meter.Int64ObservableCounter(
		"process.runtime.go.gc.count",
		metric.WithDescription("Number of completed GC cycles."),
		metric.WithUnit("{cycle}"),
	)
	if err != nil {
		return fmt.Errorf("create gc_count counter: %w", err)
	}

	gcPauseNs, err := meter.Int64ObservableCounter(
		"process.runtime.go.gc.pause_total_ns",
		metric.WithDescription("Cumulative nanoseconds spent in GC stop-the-world pauses."),
		metric.WithUnit("ns"),
	)
	if err != nil {
		return fmt.Errorf("create gc_pause_total_ns counter: %w", err)
	}

	if _, err := meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		var ms runtime.MemStats
		runtime.ReadMemStats(&ms)
		o.ObserveFloat64(heapAlloc, float64(ms.HeapAlloc))
		o.ObserveFloat64(heapInUse, float64(ms.HeapInuse))
		o.ObserveInt64(heapObjects, int64(ms.HeapObjects))          //nolint:gosec // bounded by available memory
		// The runtime guarantees Mallocs >= Frees; subtraction will not wrap.
		o.ObserveInt64(liveObjects, int64(ms.Mallocs-ms.Frees)) //nolint:gosec // bounded by live heap
		o.ObserveInt64(gcCount, int64(ms.NumGC))
		o.ObserveInt64(gcPauseNs, int64(ms.PauseTotalNs)) //nolint:gosec // bounded in practice
		return nil
	}, heapAlloc, heapInUse, heapObjects, liveObjects, gcCount, gcPauseNs); err != nil {
		return fmt.Errorf("register memory stats callback: %w", err)
	}

	return nil
}
