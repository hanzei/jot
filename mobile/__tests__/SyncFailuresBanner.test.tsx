import { render, fireEvent } from '@testing-library/react-native';
import { useOfflineContext } from '../src/store/OfflineContext';
import SyncFailuresBanner from '../src/components/SyncFailuresBanner';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

const mockDismiss = jest.fn();
const baseContext = {
  isConnected: true,
  syncError: false,
  pendingNoteIds: new Set<string>(),
  failedNoteIds: new Set<string>(),
  syncFailureCount: 0,
  syncFailuresBannerDismissed: false,
  dismissSyncFailuresBanner: mockDismiss,
  refreshSyncFailures: jest.fn(),
  lastSyncedAt: null,
  consecutiveFailureCount: 0,
};

jest.mock('../src/store/OfflineContext', () => ({
  useOfflineContext: jest.fn(),
}));

const mockUseOfflineContext = useOfflineContext as jest.MockedFunction<typeof useOfflineContext>;

describe('SyncFailuresBanner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseOfflineContext.mockReturnValue(baseContext);
  });

  it('renders the failure count and opens the review screen on tap', async () => {
    mockUseOfflineContext.mockReturnValue({ ...baseContext, syncFailureCount: 2 });
    const { getByTestId, getByText } = await render(<SyncFailuresBanner visible applyTopInset />);

    expect(getByText(/2 changes couldn't be saved/i)).toBeTruthy();
    await fireEvent.press(getByTestId('sync-failures-banner-press'));
    expect(mockNavigate).toHaveBeenCalledWith('SyncFailures');
  });

  it('uses the singular form for a single failure', async () => {
    mockUseOfflineContext.mockReturnValue({ ...baseContext, syncFailureCount: 1 });
    const { getByText } = await render(<SyncFailuresBanner visible applyTopInset />);
    expect(getByText(/1 change couldn't be saved/i)).toBeTruthy();
  });

  it('dismisses without navigating when the close button is pressed', async () => {
    mockUseOfflineContext.mockReturnValue({ ...baseContext, syncFailureCount: 3 });
    const { getByTestId } = await render(<SyncFailuresBanner visible applyTopInset />);

    await fireEvent.press(getByTestId('sync-failures-banner-dismiss'));
    expect(mockDismiss).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('does not render when not visible', async () => {
    mockUseOfflineContext.mockReturnValue({ ...baseContext, syncFailureCount: 2 });
    const { queryByTestId } = await render(<SyncFailuresBanner visible={false} applyTopInset={false} />);
    expect(queryByTestId('sync-failures-banner-press')).toBeNull();
  });
});
