import { render } from '@testing-library/react-native';
import OfflineBanner from '../src/components/OfflineBanner';

describe('OfflineBanner', () => {
  it('renders the offline message when visible', async () => {
    const { getByText } = await render(<OfflineBanner visible applyTopInset />);
    expect(getByText(/You're offline/i)).toBeTruthy();
  });

  it('does not render when not visible', async () => {
    const { queryByText } = await render(<OfflineBanner visible={false} applyTopInset={false} />);
    expect(queryByText(/You're offline/i)).toBeNull();
  });
});
