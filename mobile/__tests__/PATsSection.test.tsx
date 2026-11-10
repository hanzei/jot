import { render, screen } from '@testing-library/react-native';
import type { PersonalAccessToken } from '@jot/shared';
import PATsSection from '../src/screens/settings/PATsSection';
import { jot } from '../src/api/jot';

jest.mock('../src/api/jot', () => ({
  jot: {
    pats: {
      list: jest.fn(),
    },
  },
}));

jest.mock('../src/api/client', () => ({
  subscribeToClientActiveServerChanges: jest.fn(() => () => {}),
}));

jest.mock('../src/store/serverAccounts', () => ({
  getActiveServer: jest.fn(async () => ({ serverUrl: 'https://jot.example.com' })),
}));

const mockListPATs = jest.mocked(jot.pats.list);

function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

function pat(id: string, lastUsedAt: string | null): PersonalAccessToken {
  return { id, name: `token ${id}`, created_at: '2026-01-05T12:00:00Z', last_used_at: lastUsedAt };
}

describe('PATsSection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows when each token was last used, to the day', async () => {
    mockListPATs.mockResolvedValue([
      pat('never', null),
      pat('today', daysAgo(0)),
      pat('yesterday', daysAgo(1)),
      pat('recent', daysAgo(5)),
      pat('old', '2025-03-04T12:00:00Z'),
    ]);

    await render(<PATsSection />);

    expect(await screen.findByTestId('pat-last-used-never')).toHaveTextContent('No recorded use');
    expect(screen.getByTestId('pat-last-used-today')).toHaveTextContent('Last used today');
    expect(screen.getByTestId('pat-last-used-yesterday')).toHaveTextContent('Last used yesterday');
    expect(screen.getByTestId('pat-last-used-recent')).toHaveTextContent('Last used 5 days ago');
    expect(screen.getByTestId('pat-last-used-old')).toHaveTextContent(/^Last used .*2025/);
    expect(screen.getAllByText(/^Created .*2026/)).toHaveLength(5);
  });
});
