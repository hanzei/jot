import { fireEvent, render } from '@testing-library/react-native';
import UserAvatar from '../src/components/UserAvatar';

jest.mock('../src/hooks/useActiveServerBaseUrl', () => ({
  useActiveServerBaseUrl: () => 'http://server',
}));

// The real hook resolves the on-device cache asynchronously; the tests drive
// that transition explicitly by controlling what it returns per render.
const mockUseProfileIcon = jest.fn<string | null, unknown[]>();
jest.mock('../src/hooks/useProfileIcon', () => ({
  useProfileIcon: (...args: unknown[]) => mockUseProfileIcon(...args),
}));

const NETWORK_URL = 'http://server/api/v1/users/u1/profile-icon';

const props = {
  userId: 'u1',
  username: 'bob',
  hasProfileIcon: true,
  iconVersion: 'v1',
} as const;

beforeEach(() => {
  jest.clearAllMocks();
  mockUseProfileIcon.mockReturnValue(null);
});

describe('UserAvatar', () => {
  it('renders the network URL until the local cache resolves', async () => {
    const { getByLabelText } = await render(<UserAvatar {...props} />);
    expect(getByLabelText('bob profile picture').props.source).toEqual({ uri: NETWORK_URL });
  });

  it('falls back to initials when the image fails to load', async () => {
    const { getByLabelText, queryByText } = await render(<UserAvatar {...props} />);

    await fireEvent(getByLabelText('bob profile picture'), 'error');

    expect(queryByText('B')).toBeTruthy();
  });

  it('renders the cached file that arrives after the network URL failed', async () => {
    const { getByLabelText, queryByText, rerender } = await render(<UserAvatar {...props} />);

    // The network URL fails — offline, or the server 500s — so initials show.
    await fireEvent(getByLabelText('bob profile picture'), 'error');
    expect(queryByText('B')).toBeTruthy();

    // useProfileIcon then resolves a cached file for the *same* avatar identity.
    // The failure was recorded against the URI that failed, not the identity, so
    // this one is not suppressed by it.
    mockUseProfileIcon.mockReturnValue('file:///cache/u1-v1.png');
    await rerender(<UserAvatar {...props} />);

    expect(getByLabelText('bob profile picture').props.source).toEqual({ uri: 'file:///cache/u1-v1.png' });
  });

  it('keeps showing initials while the failed URI is still the one being rendered', async () => {
    const { getByLabelText, queryByText, rerender } = await render(<UserAvatar {...props} />);

    await fireEvent(getByLabelText('bob profile picture'), 'error');
    await rerender(<UserAvatar {...props} />);

    expect(queryByText('B')).toBeTruthy();
  });

  it('retries on a new avatar identity', async () => {
    const { getByLabelText, queryByText, rerender } = await render(<UserAvatar {...props} />);

    await fireEvent(getByLabelText('bob profile picture'), 'error');
    expect(queryByText('B')).toBeTruthy();

    // A new icon version is a new identity; the recorded failure no longer applies.
    await rerender(<UserAvatar {...props} iconVersion="v2" />);

    expect(getByLabelText('bob profile picture').props.source).toEqual({ uri: NETWORK_URL });
  });
});
