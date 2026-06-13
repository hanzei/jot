import React from 'react';
import { render } from '@testing-library/react-native';
import { useOfflineContext } from '../src/store/OfflineContext';
import SyncErrorBanner from '../src/components/SyncErrorBanner';

jest.mock('../src/store/OfflineContext', () => ({
  useOfflineContext: jest.fn(() => ({ isConnected: true, syncError: false })),
}));

const mockUseOfflineContext = useOfflineContext as jest.MockedFunction<typeof useOfflineContext>;

describe('SyncErrorBanner', () => {
  beforeEach(() => {
    mockUseOfflineContext.mockReturnValue({ isConnected: true, syncError: false });
  });

  it('renders the sync-error message when online and sync has failed', () => {
    mockUseOfflineContext.mockReturnValue({ isConnected: true, syncError: true });
    const { getByText } = render(<SyncErrorBanner />);
    expect(getByText(/haven't synced/i)).toBeTruthy();
  });

  it('does not render when there is no sync error', () => {
    const { queryByText } = render(<SyncErrorBanner />);
    expect(queryByText(/haven't synced/i)).toBeNull();
  });

  it('does not render while offline (the offline banner takes over)', () => {
    mockUseOfflineContext.mockReturnValue({ isConnected: false, syncError: true });
    const { queryByText } = render(<SyncErrorBanner />);
    expect(queryByText(/haven't synced/i)).toBeNull();
  });
});
