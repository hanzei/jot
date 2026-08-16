import { render } from '@testing-library/react-native';
import SyncErrorBanner from '../src/components/SyncErrorBanner';

describe('SyncErrorBanner', () => {
  it('renders the sync-error message when visible', async () => {
    const { getByText } = await render(<SyncErrorBanner visible applyTopInset />);
    expect(getByText(/haven't synced/i)).toBeTruthy();
  });

  it('does not render when not visible', async () => {
    const { queryByText } = await render(<SyncErrorBanner visible={false} applyTopInset={false} />);
    expect(queryByText(/haven't synced/i)).toBeNull();
  });
});
