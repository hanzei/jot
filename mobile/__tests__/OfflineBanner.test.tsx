import React from 'react';
import { render } from '@testing-library/react-native';
import { useNetworkStatus } from '../src/hooks/useNetworkStatus';
import OfflineBanner from '../src/components/OfflineBanner';

jest.mock('../src/hooks/useNetworkStatus', () => ({
  useNetworkStatus: jest.fn(() => ({ isConnected: false })),
}));

const mockUseNetworkStatus = useNetworkStatus as jest.MockedFunction<typeof useNetworkStatus>;

describe('OfflineBanner', () => {
  beforeEach(() => {
    mockUseNetworkStatus.mockReturnValue({ isConnected: false });
  });

  it('renders the offline message when disconnected', () => {
    const { getByText } = render(<OfflineBanner />);
    expect(getByText(/You're offline/i)).toBeTruthy();
  });

  it('does not render when connected', () => {
    mockUseNetworkStatus.mockReturnValue({ isConnected: true });
    const { queryByText } = render(<OfflineBanner />);
    expect(queryByText(/You're offline/i)).toBeNull();
  });
});
