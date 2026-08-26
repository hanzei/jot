import { render, act } from '@testing-library/react-native';
import { Text } from 'react-native';
import { SSEProvider, useSSEContext } from '../src/store/SSEContext';
import type { SSEStatusChangeCallback } from '../src/hooks/useSSE';

// Capture the status-change callback useSSE receives so the test can drive the
// SSE connection lifecycle that gates the reconnect banner.
let capturedStatusChange: SSEStatusChangeCallback | undefined;
jest.mock('../src/hooks/useSSE', () => ({
  useSSE: (
    _onNoteUpdated: unknown,
    onStatusChange: SSEStatusChangeCallback,
  ) => {
    capturedStatusChange = onStatusChange;
  },
}));

// Mirrors SSE_BANNER_DELAY_MS in SSEContext: a 'reconnecting' state must outlast
// this before the banner appears, so a quick self-healing retry stays silent.
const SSE_BANNER_DELAY_MS = 3000;

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

// Drive a status change and flush the resulting effect (which arms/clears the
// banner timer) before any subsequent timer advance.
async function emitStatus(status: Parameters<SSEStatusChangeCallback>[0]) {
  await act(() => {
    capturedStatusChange?.(status);
  });
}

async function advance(ms: number) {
  await act(() => {
    jest.advanceTimersByTime(ms);
  });
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

  it('never surfaces the banner for a slow initial connect, however long it takes', async () => {
    // The "closed for a while" cold start: a fresh connect reports 'connecting'
    // the whole time it wakes the radio / redoes the TLS handshake. No matter how
    // long that takes, it must not flash the "Connecting to server…" banner.
    const { getByText } = await renderProbe();

    await emitStatus('connecting');
    await advance(SSE_BANNER_DELAY_MS * 3);
    expect(getByText('idle')).toBeTruthy();

    // It eventually connects — still no banner, no flash.
    await emitStatus('connected');
    expect(getByText('idle')).toBeTruthy();
  });

  it('does not surface the banner for a reconnect that recovers before the delay', async () => {
    const { getByText } = await renderProbe();

    // A connection attempt fails and a retry is pending, but it recovers well
    // within the threshold.
    await emitStatus('reconnecting');
    await advance(SSE_BANNER_DELAY_MS - 1000);
    await emitStatus('connected');

    // Even after the original timer would have fired, the banner stays hidden.
    await advance(SSE_BANNER_DELAY_MS);

    expect(getByText('idle')).toBeTruthy();
  });

  it('surfaces the banner once a reconnect outlasts the delay', async () => {
    const { getByText } = await renderProbe();

    await emitStatus('reconnecting');
    await advance(SSE_BANNER_DELAY_MS);

    expect(getByText('reconnecting')).toBeTruthy();

    // Recovering clears the banner immediately.
    await emitStatus('connected');
    expect(getByText('idle')).toBeTruthy();
  });
});
