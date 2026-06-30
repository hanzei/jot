import React from 'react';
import { render, act } from '@testing-library/react-native';
import { Text } from 'react-native';
import { SSEProvider, useSSEContext } from '../src/store/SSEContext';
import type { SSEStatusChangeCallback } from '../src/hooks/useSSE';

// Capture the status-change callback useSSE receives so the test can drive the
// SSE connected/disconnected transitions that gate the reconnect banner.
let capturedStatusChange: SSEStatusChangeCallback | undefined;
jest.mock('../src/hooks/useSSE', () => ({
  useSSE: (
    _onNoteUpdated: unknown,
    onStatusChange: SSEStatusChangeCallback,
  ) => {
    capturedStatusChange = onStatusChange;
  },
}));

// Mirrors SSE_BANNER_DELAY_MS in SSEContext: the banner must stay hidden for a
// brief, self-healing reconnect and only appear once the outage outlasts this.
const SSE_BANNER_DELAY_MS = 5000;

function Probe() {
  const { sseReconnecting } = useSSEContext();
  return <Text>{sseReconnecting ? 'reconnecting' : 'idle'}</Text>;
}

function renderProbe() {
  return render(
    <SSEProvider>
      <Probe />
    </SSEProvider>,
  );
}

describe('SSEProvider reconnect banner gating', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    capturedStatusChange = undefined;
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('does not surface the banner for a reconnect that completes before the delay', () => {
    const { getByText } = renderProbe();

    // Connection drops, then re-establishes well within the threshold.
    act(() => {
      capturedStatusChange?.(false);
      jest.advanceTimersByTime(SSE_BANNER_DELAY_MS - 1000);
      capturedStatusChange?.(true);
    });

    // Even after the original timer would have fired, the banner stays hidden.
    act(() => {
      jest.advanceTimersByTime(SSE_BANNER_DELAY_MS);
    });

    expect(getByText('idle')).toBeTruthy();
  });

  it('surfaces the banner once the outage outlasts the delay', () => {
    const { getByText } = renderProbe();

    act(() => {
      capturedStatusChange?.(false);
      jest.advanceTimersByTime(SSE_BANNER_DELAY_MS);
    });

    expect(getByText('reconnecting')).toBeTruthy();

    // Recovering clears the banner immediately.
    act(() => {
      capturedStatusChange?.(true);
    });

    expect(getByText('idle')).toBeTruthy();
  });
});
