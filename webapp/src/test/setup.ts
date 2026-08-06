import '@testing-library/jest-dom';
import i18n from '@/i18n';
import { beforeEach } from 'vitest';

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

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

// ResizeObserver is not available in jsdom. @headlessui/react v2 requires it.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// URL.createObjectURL/revokeObjectURL are not implemented in jsdom. Provide a
// no-op stub so components that preview local files (image upload tiles,
// export downloads) do not throw.
if (!globalThis.URL.createObjectURL) {
  globalThis.URL.createObjectURL = () => 'blob:mock-url';
}
if (!globalThis.URL.revokeObjectURL) {
  globalThis.URL.revokeObjectURL = () => {};
}

// window.matchMedia is not available in jsdom. Provide a stub so components
// that call applyTheme (which reads prefers-color-scheme) do not throw.
Object.defineProperty(globalThis, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});