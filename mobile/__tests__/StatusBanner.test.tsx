import { act, render } from '@testing-library/react-native';
import StatusBanner from '../src/components/StatusBanner';

describe('StatusBanner', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    ['offline', 'offline-banner', /You're offline/i],
    ['revalidation', 'status-banner', /Couldn't verify your session/i],
    ['sseReconnect', 'status-banner', /Connecting to server/i],
    ['syncError', 'status-banner', /Some changes haven't synced yet/i],
  ] as const)('renders the %s status', async (status, testID, text) => {
    const { getByTestId, getByText } = await render(<StatusBanner status={status} applyTopInset />);
    expect(getByTestId(testID)).toBeTruthy();
    expect(getByText(text)).toBeTruthy();
  });

  it('does not render without a status', async () => {
    const { toJSON } = await render(<StatusBanner status={null} applyTopInset={false} />);
    expect(toJSON()).toBeNull();
  });

  // One banner whose content changes: switching status swaps the text in
  // place instead of fading one banner out while another fades in.
  it('swaps the content in place when the status changes', async () => {
    const view = await render(<StatusBanner status="sseReconnect" applyTopInset />);
    await view.rerender(<StatusBanner status="syncError" applyTopInset />);
    expect(view.queryByText(/Connecting to server/i)).toBeNull();
    expect(view.getByText(/Some changes haven't synced yet/i)).toBeTruthy();
  });

  it('keeps showing the last status while it fades out, then unmounts', async () => {
    const view = await render(<StatusBanner status="offline" applyTopInset />);
    await view.rerender(<StatusBanner status={null} applyTopInset={false} />);
    expect(view.getByText(/You're offline/i)).toBeTruthy();

    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    expect(view.queryByText(/You're offline/i)).toBeNull();
  });
});
