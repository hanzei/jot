import '@testing-library/jest-dom'

// EventSource is not available in jsdom. Provide a no-op mock so components
// that use useSSE do not throw during tests.
class MockEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_url: string, _opts?: EventSourceInit) {}
}

Object.defineProperty(globalThis, 'EventSource', {
  value: MockEventSource,
  writable: true,
});