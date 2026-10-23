/**
 * Render errors show a fallback instead of a white screen (issue #1086): the
 * root boundary's crash screen, which logs the error to the persisted log and
 * can share it in a diagnostics report, and the screen-level boundary, which
 * keeps the rest of the app usable.
 */

import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { Share } from 'react-native';
import ErrorBoundary from '../src/components/ErrorBoundary';
import CrashScreen from '../src/components/CrashScreen';
import { screenErrorLayout } from '../src/components/ScreenErrorBoundary';
import { initLogger, clearLogs, getPersistedLogs } from '../src/utils/logger';
import { lightColors } from '../src/theme/colors';
import { allowConsoleError } from './helpers/consoleGuard';

const mockGoBack = jest.fn();
const mockCanGoBack = jest.fn(() => true);

jest.mock('../src/theme/ThemeContext', () => ({
  useTheme: () => ({ colors: jest.requireActual('../src/theme/colors').lightColors, isDark: false }),
}));

jest.mock('../src/api/settings', () => ({
  getAboutInfo: jest.fn(() => Promise.resolve({ version: '0.9.0', commit: 'def5678', build_time: '2026-09-30T08:00:00Z', go_version: 'go1.25.0' })),
}));

jest.mock('../src/api/client', () => ({
  getBaseUrl: jest.fn(() => 'https://jot.example.com'),
}));

// Toggled per test, so "Try again" can re-render a subtree that now succeeds.
let shouldThrow = true;

function Thrower() {
  if (shouldThrow) {
    throw new Error('render exploded');
  }
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return <Text>recovered</Text>;
}

const origError = console.error;

beforeAll(() => {
  // The boundary's console.error must land in the persisted log; initLogger
  // wraps console on top of the test console guard.
  initLogger();
});

afterAll(() => {
  clearLogs();
  console.error = origError;
});

beforeEach(() => {
  shouldThrow = true;
  clearLogs();
  globalThis.mockFileSystem.reset();
  jest.clearAllMocks();
  mockCanGoBack.mockReturnValue(true);
  // React reports caught errors too; both it and the boundary log on purpose here.
  allowConsoleError('render exploded', 'error boundary');
  jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
});

function renderRoot() {
  return render(
    <ErrorBoundary name="root" fallback={(props) => <CrashScreen {...props} />}>
      <Thrower />
    </ErrorBoundary>,
  );
}

describe('root error boundary', () => {
  it('shows the crash screen instead of a white screen', async () => {
    const { findByTestId, getByText } = await renderRoot();

    expect(await findByTestId('crash-screen')).toBeTruthy();
    expect(getByText('Something went wrong')).toBeTruthy();
    expect(getByText('render exploded')).toBeTruthy();
  });

  it('logs the caught error to the persisted log', async () => {
    const { findByTestId } = await renderRoot();
    await findByTestId('crash-screen');

    const entry = getPersistedLogs().find((e) => e.msg.includes('root error boundary'));
    expect(entry).toBeDefined();
    expect(entry!.level).toBe('error');
    expect(entry!.msg).toContain('render exploded');
  });

  it('shares a diagnostics report carrying the error and component stack', async () => {
    const { findByTestId } = await renderRoot();

    await fireEvent.press(await findByTestId('crash-screen-share-diagnostics'));

    // Sharing waits on the best-effort server build info fetch first.
    await waitFor(() => expect(Share.share).toHaveBeenCalledTimes(1));
    const [{ message }] = (Share.share as jest.Mock).mock.calls[0];
    const report = JSON.parse(message);
    expect(report.crash.name).toBe('Error');
    expect(report.crash.message).toBe('render exploded');
    expect(report.crash.stack).toContain('render exploded');
    expect(report.crash.componentStack).toContain('Thrower');
    expect(report.server.url).toBe('https://jot.example.com');
    expect(report.app.version).toEqual(expect.any(String));
    expect(report.server.version).toBe('0.9.0');
    // No database outside the provider tree, so sync counts are unknown rather than zero.
    expect(report.sync.pendingQueueCount).toBeNull();
    expect(report.sync.headAttempts).toBeNull();
    expect(report.recentLogs.some((e: { msg: string }) => e.msg.includes('root error boundary'))).toBe(true);
  });

  it('re-renders the subtree on "Try again"', async () => {
    const { findByTestId, findByText, queryByTestId } = await renderRoot();
    await findByTestId('crash-screen');

    shouldThrow = false;
    await fireEvent.press(await findByTestId('crash-screen-try-again'));

    expect(await findByText('recovered')).toBeTruthy();
    expect(queryByTestId('crash-screen')).toBeNull();
  });
});

describe('screen error boundary', () => {
  function renderScreen() {
    return render(screenErrorLayout({
      route: { name: 'NoteEditor' },
      navigation: { goBack: mockGoBack, canGoBack: mockCanGoBack },
      children: <Thrower />,
    }));
  }

  it('shows a themed fallback that can go back', async () => {
    const { findByTestId, getByText } = await renderScreen();

    expect(await findByTestId('screen-error')).toBeTruthy();
    expect(getByText('This screen ran into an unexpected problem.')).toBeTruthy();
    expect((await findByTestId('screen-error')).props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ backgroundColor: lightColors.background })]),
    );

    await fireEvent.press(await findByTestId('screen-error-back'));
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('offers no back button when there is nowhere to go back to', async () => {
    mockCanGoBack.mockReturnValue(false);
    const { findByTestId, queryByTestId } = await renderScreen();

    await findByTestId('screen-error');
    expect(queryByTestId('screen-error-back')).toBeNull();
  });

  it('recovers on "Try again"', async () => {
    const { findByTestId, findByText } = await renderScreen();
    await findByTestId('screen-error');

    shouldThrow = false;
    await fireEvent.press(await findByTestId('screen-error-try-again'));

    expect(await findByText('recovered')).toBeTruthy();
  });

  it('recovers when the route is reused with new params', async () => {
    const navigation = { goBack: mockGoBack, canGoBack: mockCanGoBack };
    const { findByTestId, findByText, rerender } = await render(screenErrorLayout({
      route: { name: 'Notes', params: { labelId: 'a' } },
      navigation,
      children: <Thrower />,
    }));
    await findByTestId('screen-error');

    shouldThrow = false;
    await rerender(screenErrorLayout({
      route: { name: 'Notes', params: { labelId: 'b' } },
      navigation,
      children: <Thrower />,
    }));

    expect(await findByText('recovered')).toBeTruthy();
  });

  it('logs which screen caught the error', async () => {
    const { findByTestId } = await renderScreen();
    await findByTestId('screen-error');

    expect(getPersistedLogs().some((e) => e.msg.includes('NoteEditor error boundary'))).toBe(true);
  });
});
