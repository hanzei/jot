import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { useOfflineContext } from '../src/store/OfflineContext';
import { useAuth } from '../src/store/AuthContext';
import SyncFailuresBanner from '../src/components/SyncFailuresBanner';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn(),
}));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;

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
};

jest.mock('../src/store/OfflineContext', () => ({
  useOfflineContext: jest.fn(),
}));

const mockUseOfflineContext = useOfflineContext as jest.MockedFunction<typeof useOfflineContext>;

describe('SyncFailuresBanner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseOfflineContext.mockReturnValue(baseContext);
    mockUseAuth.mockReturnValue({
      revalidationFailed: false,
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('renders the failure count and opens the review screen on tap', () => {
    mockUseOfflineContext.mockReturnValue({ ...baseContext, syncFailureCount: 2 });
    const { getByTestId, getByText } = render(<SyncFailuresBanner />);

    expect(getByText(/2 changes couldn't be saved/i)).toBeTruthy();
    fireEvent.press(getByTestId('sync-failures-banner-press'));
    expect(mockNavigate).toHaveBeenCalledWith('SyncFailures');
  });

  it('uses the singular form for a single failure', () => {
    mockUseOfflineContext.mockReturnValue({ ...baseContext, syncFailureCount: 1 });
    const { getByText } = render(<SyncFailuresBanner />);
    expect(getByText(/1 change couldn't be saved/i)).toBeTruthy();
  });

  it('dismisses without navigating when the close button is pressed', () => {
    mockUseOfflineContext.mockReturnValue({ ...baseContext, syncFailureCount: 3 });
    const { getByTestId } = render(<SyncFailuresBanner />);

    fireEvent.press(getByTestId('sync-failures-banner-dismiss'));
    expect(mockDismiss).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('does not render when there are no failures', () => {
    const { queryByTestId } = render(<SyncFailuresBanner />);
    expect(queryByTestId('sync-failures-banner-press')).toBeNull();
  });

  it('does not render once dismissed', () => {
    mockUseOfflineContext.mockReturnValue({
      ...baseContext,
      syncFailureCount: 2,
      syncFailuresBannerDismissed: true,
    });
    const { queryByTestId } = render(<SyncFailuresBanner />);
    expect(queryByTestId('sync-failures-banner-press')).toBeNull();
  });
});
