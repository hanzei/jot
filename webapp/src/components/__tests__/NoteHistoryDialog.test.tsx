import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NoteRevision, NoteRevisionSummary, User } from '@jot/shared';
import { createApiError } from '@/utils/__tests__/test-helpers';
import type { CurrentNoteContent } from '@/utils/revisionDiff';

const mockListRevisions = vi.hoisted(() => vi.fn());
const mockGetRevision = vi.hoisted(() => vi.fn());

vi.mock('@/utils/api', () => ({
  notes: {
    listRevisions: mockListRevisions,
    getRevision: mockGetRevision,
  },
}));

import NoteHistoryDialog from '../NoteHistoryDialog';

const alice: User = {
  id: 'user2',
  username: 'alice',
  first_name: 'Alice',
  last_name: 'Smith',
  role: 'user',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  has_profile_icon: false,
};

const summary = (id: string, overrides: Partial<NoteRevisionSummary> = {}): NoteRevisionSummary => ({
  id,
  note_id: 'note1',
  note_type: 'text',
  title: '',
  actor_id: null,
  edited_at: '2026-10-01T10:00:00Z',
  created_at: '2026-10-01T10:05:00Z',
  ...overrides,
});

const full = (s: NoteRevisionSummary, overrides: Partial<NoteRevision> = {}): NoteRevision => ({
  ...s, content: '', items: [], ...overrides,
});

const current: CurrentNoteContent = { noteType: 'text', title: '', content: 'current text', items: [] };

const renderDialog = (props: Partial<Parameters<typeof NoteHistoryDialog>[0]> = {}) => {
  const onClose = vi.fn();
  const onRestore = vi.fn().mockResolvedValue(undefined);
  render(
    <NoteHistoryDialog
      noteId="note1"
      current={current}
      usersById={new Map([[alice.id, alice]])}
      onClose={onClose}
      onRestore={onRestore}
      {...props}
    />,
  );
  return { onClose, onRestore };
};

describe('NoteHistoryDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists revisions with their author and previews the newest one', async () => {
    const newest = summary('rev2', { actor_id: alice.id, edited_at: '2026-10-02T10:00:00Z' });
    const older = summary('rev1', { actor_id: 'deleted-user' });
    mockListRevisions.mockResolvedValue([newest, older]);
    mockGetRevision.mockResolvedValue(full(newest, { content: '**older text**' }));

    renderDialog();

    const entries = await screen.findAllByTestId('note-history-entry');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent('Alice Smith');
    expect(entries[0]).toHaveAttribute('aria-pressed', 'true');
    // An author the client does not know is left out rather than guessed.
    expect(entries[1]).not.toHaveTextContent('deleted-user');

    const preview = await screen.findByTestId('note-history-preview');
    expect(preview.querySelector('strong')).toHaveTextContent('older text');
    expect(mockGetRevision).toHaveBeenCalledWith('note1', 'rev2');
  });

  it('shows how the selected version differs from the current note', async () => {
    const rev = summary('rev1');
    mockListRevisions.mockResolvedValue([rev]);
    mockGetRevision.mockResolvedValue(full(rev, { content: 'old text' }));

    renderDialog();
    await screen.findByTestId('note-history-preview');
    await userEvent.click(screen.getByRole('button', { name: 'Compare with current' }));

    const diff = screen.getByTestId('note-history-diff');
    expect(diff.querySelector('[data-diff="removed"]')).toHaveTextContent('old text');
    expect(diff.querySelector('[data-diff="added"]')).toHaveTextContent('current text');
  });

  it('says when a version was another note type', async () => {
    const rev = summary('rev1', { note_type: 'list', title: 'Groceries' });
    mockListRevisions.mockResolvedValue([rev]);
    mockGetRevision.mockResolvedValue(full(rev, {
      items: [{ id: 'i1', text: 'milk', completed: true, position: 0, parent_id: null, assigned_to: '' }],
    }));

    renderDialog();
    const preview = await screen.findByTestId('note-history-preview');
    expect(within(preview).getByRole('heading', { name: 'Groceries' })).toBeInTheDocument();
    expect(within(preview).getByRole('img', { name: 'Checked' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Compare with current' }));
    expect(screen.getByTestId('note-history-diff')).toHaveTextContent('This version was a list.');
  });

  it('restores the selected version', async () => {
    const rev = summary('rev1');
    mockListRevisions.mockResolvedValue([rev]);
    mockGetRevision.mockResolvedValue(full(rev, { content: 'old text' }));

    const { onRestore } = renderDialog();
    await screen.findByTestId('note-history-preview');
    await userEvent.click(screen.getByTestId('note-history-restore'));

    expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ id: 'rev1' }));
  });

  it('reports a conflicting restore and stays open', async () => {
    const rev = summary('rev1');
    mockListRevisions.mockResolvedValue([rev]);
    mockGetRevision.mockResolvedValue(full(rev, { content: 'old text' }));
    const onRestore = vi.fn().mockRejectedValue(createApiError(409, 'conflict', 'note was modified by another write'));

    renderDialog({ onRestore });
    await screen.findByTestId('note-history-preview');
    await userEvent.click(screen.getByTestId('note-history-restore'));

    expect(await screen.findByTestId('note-history-error')).toHaveTextContent('The note changed while you were looking at its history.');
    expect(screen.getByTestId('note-history-dialog')).toBeInTheDocument();
  });

  it('explains an empty history', async () => {
    mockListRevisions.mockResolvedValue([]);
    renderDialog();
    expect(await screen.findByTestId('note-history-empty')).toHaveTextContent('No earlier versions yet.');
    expect(mockGetRevision).not.toHaveBeenCalled();
  });

  it('offers a retry when the history fails to load', async () => {
    mockListRevisions.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce([]);
    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByTestId('note-history-empty')).toBeInTheDocument());
  });

  it('closes on Escape', async () => {
    mockListRevisions.mockResolvedValue([]);
    const { onClose } = renderDialog();
    await screen.findByTestId('note-history-empty');
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
