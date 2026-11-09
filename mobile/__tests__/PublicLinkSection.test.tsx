/**
 * The share screen's public link section (#1135/#1214): its states (none,
 * active, expired, offline, feature off), the create / change-expiry / revoke
 * flows as online-only one-shot requests that never touch the sync queue, and
 * the URL it hands out. The database layer runs for real, so the cached note
 * is checked to take the server's answer.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Share } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { PublicLink, ServerConfig, User } from '@jot/shared';
import PublicLinkSection from '../src/screens/share/PublicLinkSection';
import { jot } from '../src/api/jot';
import { useServerConfig } from '../src/hooks/useServerConfig';
import { useActiveServerBaseUrl } from '../src/hooks/useActiveServerBaseUrl';
import { useNetworkStatus } from '../src/hooks/useNetworkStatus';
import { useConfirm } from '../src/hooks/useConfirm';
import { markServerReachable, markServerUnreachable } from '../src/api/serverReachability';
import { getLocalNote, markNotePendingCreate, saveNote } from '../src/db/noteQueries';
import { makeTextNote } from './helpers/fixtures';
import { apiErrorBody } from './helpers/apiError';

jest.mock('../src/api/jot', () => ({
  jot: {
    notes: {
      setPublicLink: jest.fn(),
      deletePublicLink: jest.fn(),
    },
  },
}));

jest.mock('../src/hooks/useServerConfig', () => ({
  useServerConfig: jest.fn(),
}));

jest.mock('../src/hooks/useActiveServerBaseUrl', () => ({
  useActiveServerBaseUrl: jest.fn(),
}));

jest.mock('../src/hooks/useNetworkStatus', () => ({
  useNetworkStatus: jest.fn(),
}));

jest.mock('../src/hooks/useConfirm', () => ({
  useConfirm: jest.fn(),
}));

const mockSetPublicLink = jest.mocked(jot.notes.setPublicLink);
const mockDeletePublicLink = jest.mocked(jot.notes.deletePublicLink);
const mockUseServerConfig = jest.mocked(useServerConfig);
const mockUseActiveServerBaseUrl = jest.mocked(useActiveServerBaseUrl);
const mockUseNetworkStatus = jest.mocked(useNetworkStatus);
const mockUseConfirm = jest.mocked(useConfirm);

const NOTE_ID = 'note-1';
const ME = 'user-me';
const TOKEN = 'q3XvT0b9Lr2Kp8WmZcE1yN4hUa7sDfGj6oBtYiR5lMw';

const baseConfig: ServerConfig = {
  registration_enabled: true,
  password_min_length: 8,
  upload_max_bytes: 10_000_000,
  public_links_enabled: true,
  public_url: null,
};

const alice: User = {
  id: 'user-alice',
  username: 'alice',
  first_name: 'Alice',
  last_name: 'Smith',
  role: 'user',
  has_profile_icon: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function makeLink(overrides: Partial<PublicLink> = {}): PublicLink {
  return { token: TOKEN, created_by: ME, created_at: '2026-11-01T00:00:00Z', expires_at: null, ...overrides };
}

const inDays = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

let confirmFn: jest.Mock;

async function renderSection(publicLink: PublicLink | null | undefined) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (link: PublicLink | null | undefined) => (
    <QueryClientProvider client={queryClient}>
      <PublicLinkSection
        noteId={NOTE_ID}
        publicLink={link}
        currentUserId={ME}
        usersById={new Map([[alice.id, alice]])}
      />
    </QueryClientProvider>
  );
  const result = await render(ui(publicLink));
  return { ...result, rerenderWith: (link: PublicLink | null) => result.rerender(ui(link)) };
}

async function queueSize(): Promise<number> {
  const row = await globalThis.testDb.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM sync_queue');
  return row?.n ?? 0;
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockUseServerConfig.mockReturnValue(baseConfig);
  mockUseActiveServerBaseUrl.mockReturnValue('http://192.168.1.20:8080');
  mockUseNetworkStatus.mockReturnValue({ isConnected: true });
  confirmFn = jest.fn().mockResolvedValue(true);
  mockUseConfirm.mockReturnValue({ confirm: confirmFn });
  markServerReachable();
  await saveNote(globalThis.testDb, makeTextNote({ id: NOTE_ID }));
});

describe('PublicLinkSection states', () => {
  it('renders nothing when public links are switched off', async () => {
    mockUseServerConfig.mockReturnValue({ ...baseConfig, public_links_enabled: false });

    await renderSection(makeLink());

    expect(screen.queryByTestId('public-link-section')).toBeNull();
  });

  it('renders nothing for a server that predates public links', async () => {
    mockUseServerConfig.mockReturnValue({ registration_enabled: true, password_min_length: 8, upload_max_bytes: 10_000_000 });

    await renderSection(null);

    expect(screen.queryByTestId('public-link-section')).toBeNull();
  });

  it('offers to create a link, defaulting to no expiry, when there is none', async () => {
    await renderSection(null);

    expect(screen.getByText('Public link')).toBeTruthy();
    expect(screen.queryByTestId('public-link-url')).toBeNull();
    expect(screen.queryByTestId('public-link-revoke')).toBeNull();
    expect(screen.getByTestId('public-link-submit')).toHaveTextContent('Create link');
    expect(screen.getByTestId('public-link-expiry-never')).toBeChecked();
    expect(screen.getByTestId('public-link-submit')).not.toBeDisabled();
  });

  it('shows an active link with its expiry and creator, and change and revoke', async () => {
    await renderSection(makeLink({ expires_at: inDays(5), created_by: alice.id }));

    expect(screen.getByTestId('public-link-url')).toHaveTextContent(`http://192.168.1.20:8080/share/${TOKEN}`);
    expect(screen.getByTestId('public-link-details')).toHaveTextContent(/^Expires .+ · Created by Alice Smith$/);
    expect(screen.getByTestId('public-link-submit')).toHaveTextContent('Change expiry');
    expect(screen.getByTestId('public-link-revoke')).toBeTruthy();
  });

  it('names the current user, and a deleted creator as a former collaborator', async () => {
    const { rerenderWith } = await renderSection(makeLink());
    expect(screen.getByTestId('public-link-details')).toHaveTextContent('Never expires · Created by you');

    await rerenderWith(makeLink({ created_by: null }));
    expect(screen.getByTestId('public-link-details')).toHaveTextContent('Never expires · Created by a former collaborator');
  });

  it('starts changing the expiry with no choice made, so a timed link cannot silently become permanent', async () => {
    await renderSection(makeLink({ expires_at: inDays(5) }));

    for (const choice of ['never', '7d', '30d', '3m']) {
      expect(screen.getByTestId(`public-link-expiry-${choice}`)).not.toBeChecked();
    }
    expect(screen.getByTestId('public-link-submit')).toBeDisabled();

    await fireEvent.press(screen.getByTestId('public-link-submit'));
    expect(mockSetPublicLink).not.toHaveBeenCalled();
  });

  it('shows an expired link as no link', async () => {
    await renderSection(makeLink({ expires_at: '2020-01-01T00:00:00Z' }));

    expect(screen.queryByTestId('public-link-url')).toBeNull();
    expect(screen.getByTestId('public-link-submit')).toHaveTextContent('Create link');
  });

  it('explains that a connection is needed while offline, and offers no changes', async () => {
    mockUseNetworkStatus.mockReturnValue({ isConnected: false });

    await renderSection(makeLink());

    expect(screen.getByTestId('public-link-offline')).toHaveTextContent('Public links need a connection to your server.');
    expect(screen.getByTestId('public-link-revoke')).toBeDisabled();
    expect(screen.getByTestId('public-link-expiry-7d')).toBeDisabled();
    await fireEvent.press(screen.getByTestId('public-link-revoke'));
    expect(confirmFn).not.toHaveBeenCalled();
    expect(mockDeletePublicLink).not.toHaveBeenCalled();
    expect(await queueSize()).toBe(0);
  });

  it('treats a known-unreachable server like offline', async () => {
    markServerUnreachable();

    await renderSection(null);

    expect(screen.getByTestId('public-link-offline')).toBeTruthy();
    expect(screen.getByTestId('public-link-submit')).toBeDisabled();
  });
});

describe('PublicLinkSection URL', () => {
  it('builds the shared link on the connected server URL when public_url is unset', async () => {
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    await renderSection(makeLink());

    await fireEvent.press(screen.getByTestId('public-link-share'));

    expect(shareSpy).toHaveBeenCalledWith({ message: `http://192.168.1.20:8080/share/${TOKEN}` });
  });

  it('builds the shared link on public_url when the operator set one', async () => {
    mockUseServerConfig.mockReturnValue({ ...baseConfig, public_url: 'https://jot.example.com' });
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    await renderSection(makeLink());

    expect(screen.getByTestId('public-link-url')).toHaveTextContent(`https://jot.example.com/share/${TOKEN}`);
    await fireEvent.press(screen.getByTestId('public-link-share'));

    expect(shareSpy).toHaveBeenCalledWith({ message: `https://jot.example.com/share/${TOKEN}` });
  });
});

describe('PublicLinkSection flows', () => {
  it('creates a link with the chosen expiry and caches it on the note, without queuing', async () => {
    const created = makeLink({ expires_at: inDays(7) });
    mockSetPublicLink.mockResolvedValue(created);
    const before = Date.now();
    await renderSection(null);

    await fireEvent.press(screen.getByTestId('public-link-expiry-7d'));
    await fireEvent.press(screen.getByTestId('public-link-submit'));

    await waitFor(() => expect(mockSetPublicLink).toHaveBeenCalledTimes(1));
    const [noteId, body] = mockSetPublicLink.mock.calls[0]!;
    expect(noteId).toBe(NOTE_ID);
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(body.expires_at!).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + sevenDays);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + sevenDays);
    await waitFor(async () => expect((await getLocalNote(globalThis.testDb, NOTE_ID))?.public_link).toEqual(created));
    expect(await queueSize()).toBe(0);
  });

  it('creates a link that never expires by default', async () => {
    mockSetPublicLink.mockResolvedValue(makeLink());
    await renderSection(null);

    await fireEvent.press(screen.getByTestId('public-link-submit'));

    await waitFor(() => expect(mockSetPublicLink).toHaveBeenCalledWith(NOTE_ID, { expires_at: null }));
  });

  it('changes the expiry of an active link once a new one is chosen', async () => {
    const updated = makeLink({ expires_at: null });
    mockSetPublicLink.mockResolvedValue(updated);
    await renderSection(makeLink({ expires_at: inDays(5) }));

    await fireEvent.press(screen.getByTestId('public-link-expiry-never'));
    await fireEvent.press(screen.getByTestId('public-link-submit'));

    await waitFor(() => expect(mockSetPublicLink).toHaveBeenCalledWith(NOTE_ID, { expires_at: null }));
    await waitFor(async () => expect((await getLocalNote(globalThis.testDb, NOTE_ID))?.public_link).toEqual(updated));
    expect(await queueSize()).toBe(0);
  });

  it('revokes after a confirmation saying the link stops working for everyone', async () => {
    mockDeletePublicLink.mockResolvedValue(undefined);
    await saveNote(globalThis.testDb, makeTextNote({ id: NOTE_ID, public_link: makeLink() }));
    const { rerenderWith } = await renderSection(makeLink());

    await fireEvent.press(screen.getByTestId('public-link-revoke'));

    await waitFor(() => expect(mockDeletePublicLink).toHaveBeenCalledWith(NOTE_ID));
    expect(confirmFn).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Revoke public link?',
      message: expect.stringContaining('stop working for everyone who has it'),
      destructive: true,
    }));
    await waitFor(async () => expect((await getLocalNote(globalThis.testDb, NOTE_ID))?.public_link).toBeNull());
    expect(await queueSize()).toBe(0);

    // The screen re-reads the cached note; with no link it offers Create again.
    await rerenderWith(null);
    expect(screen.getByTestId('public-link-submit')).toHaveTextContent('Create link');
  });

  it('does not revoke when the confirmation is declined', async () => {
    confirmFn.mockResolvedValue(false);
    await renderSection(makeLink());

    await fireEvent.press(screen.getByTestId('public-link-revoke'));

    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    expect(mockDeletePublicLink).not.toHaveBeenCalled();
  });

  it('explains a 403 when the operator switched public links off', async () => {
    mockSetPublicLink.mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, data: apiErrorBody('public_links_disabled', 'public links are disabled on this server') },
    });
    await renderSection(null);

    await fireEvent.press(screen.getByTestId('public-link-submit'));

    await waitFor(() => expect(screen.getByTestId('public-link-error')).toHaveTextContent('Public links are switched off on this server.'));
    expect((await getLocalNote(globalThis.testDb, NOTE_ID))?.public_link).toBeNull();
    expect(await queueSize()).toBe(0);
  });

  it('reports a failed request without queuing it', async () => {
    mockDeletePublicLink.mockRejectedValue(new Error('Network Error'));
    await renderSection(makeLink());

    await fireEvent.press(screen.getByTestId('public-link-revoke'));

    await waitFor(() => expect(screen.getByTestId('public-link-error')).toHaveTextContent("Couldn't update the public link. Please try again."));
    expect(await queueSize()).toBe(0);
  });

  it('does not ask the server about a note whose create is still queued', async () => {
    await markNotePendingCreate(globalThis.testDb, NOTE_ID);
    await renderSection(null);

    await fireEvent.press(screen.getByTestId('public-link-submit'));

    await waitFor(() => expect(screen.getByTestId('public-link-error')).toHaveTextContent(/hasn't reached the server yet/));
    expect(mockSetPublicLink).not.toHaveBeenCalled();
  });
});
