import React from 'react';
import { render } from '@testing-library/react-native';
import { useOfflineContext } from '../src/store/OfflineContext';
import SyncErrorBanner from '../src/components/SyncErrorBanner';

const baseContext = {
  isConnected: true,
  syncError: false,
  pendingNoteIds: new Set<string>(),
  failedNoteIds: new Set<string>(),
  syncFailureCount: 0,
  syncFailuresBannerDismissed: false,
  dismissSyncFailuresBanner: jest.fn(),
  refreshSyncFailures: jest.fn(),
};

jest.mock('../src/store/OfflineContext', () => ({
  useOfflineContext: jest.fn(),
}));

const mockUseOfflineContext = useOfflineContext as jest.MockedFunction<typeof useOfflineContext>;

describe('SyncErrorBanner', () => {
  beforeEach(() => {
    mockUseOfflineContext.mockReturnValue(baseContext);
  });

  it('renders the sync-error message when online and sync has failed', () => {
    mockUseOfflineContext.mockReturnValue({ ...baseContext, syncError: true });
    const { getByText } = render(<SyncErrorBanner />);
    expect(getByText(/haven't synced/i)).toBeTruthy();
  });

  it('does not render when there is no sync error', () => {
    const { queryByText } = render(<SyncErrorBanner />);
    expect(queryByText(/haven't synced/i)).toBeNull();
  });

  it('does not render while offline (the offline banner takes over)', () => {
    mockUseOfflineContext.mockReturnValue({ ...baseContext, isConnected: false, syncError: true });
    const { queryByText } = render(<SyncErrorBanner />);
    expect(queryByText(/haven't synced/i)).toBeNull();
  });
});
