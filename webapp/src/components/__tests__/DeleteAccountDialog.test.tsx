import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import DeleteAccountDialog from '../DeleteAccountDialog';
import { users } from '@/utils/api';
import i18n from '@/i18n';
import { createApiError } from '@/utils/__tests__/test-helpers';

vi.mock('@/utils/api', () => ({
  users: {
    deleteMe: vi.fn(),
  },
}));

const renderDialog = (props: Partial<Parameters<typeof DeleteAccountDialog>[0]> = {}) => {
  const onCancel = vi.fn();
  const onDeleted = vi.fn();
  render(
    <DeleteAccountDialog
      open
      hasPassword
      username="alice"
      ssoLinked={false}
      onCancel={onCancel}
      onDeleted={onDeleted}
      {...props}
    />
  );
  return { onCancel, onDeleted };
};

const confirmButton = () => screen.getByRole('button', { name: 'Delete my account' });

describe('DeleteAccountDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage('en');
  });

  it('explains what is deleted and what stays', () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Delete your account?' })).toBeInTheDocument();
    expect(screen.getByText('Your notes, images, labels, sessions and access tokens are deleted.')).toBeInTheDocument();
    expect(screen.getByText('Notes other people shared with you stay with their owners.')).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
  });

  it('shows the SSO note only for an SSO-linked account', () => {
    const { unmount } = render(
      <DeleteAccountDialog open hasPassword username="alice" ssoLinked onCancel={vi.fn()} onDeleted={vi.fn()} />
    );
    expect(screen.getByText('Signing in with SSO again creates a new, empty account.')).toBeInTheDocument();
    unmount();
    renderDialog({ ssoLinked: false });
    expect(screen.queryByText('Signing in with SSO again creates a new, empty account.')).not.toBeInTheDocument();
  });

  it('asks for the current password when the account has one', async () => {
    const user = userEvent.setup();
    vi.mocked(users.deleteMe).mockResolvedValue(undefined);
    const { onDeleted } = renderDialog({ hasPassword: true });

    const field = screen.getByLabelText('Current Password');
    expect(field).toHaveAttribute('type', 'password');
    expect(confirmButton()).toBeDisabled();

    await user.type(field, 'secret-pass');
    expect(confirmButton()).toBeEnabled();
    await user.click(confirmButton());

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(users.deleteMe).toHaveBeenCalledWith({ current_password: 'secret-pass' });
  });

  it('asks for the username when the account has no password', async () => {
    const user = userEvent.setup();
    vi.mocked(users.deleteMe).mockResolvedValue(undefined);
    const { onDeleted } = renderDialog({ hasPassword: false, username: 'alice' });

    expect(screen.queryByLabelText('Current Password')).not.toBeInTheDocument();
    const field = screen.getByLabelText('Type your username (alice) to confirm');
    expect(field).toHaveAttribute('type', 'text');

    await user.type(field, '   ');
    expect(confirmButton()).toBeDisabled();
    await user.clear(field);
    await user.type(field, ' Alice ');
    await user.click(confirmButton());

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(users.deleteMe).toHaveBeenCalledWith({ username: 'Alice' });
  });

  it('shows a pending state while the request runs', async () => {
    const user = userEvent.setup();
    let resolve: () => void = () => {};
    vi.mocked(users.deleteMe).mockReturnValue(new Promise<void>((r) => { resolve = r; }));
    const { onDeleted } = renderDialog();

    await user.type(screen.getByLabelText('Current Password'), 'pw');
    await user.click(confirmButton());

    const pending = screen.getByRole('button', { name: 'Deleting…' });
    expect(pending).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    resolve();
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
  });

  it('shows incorrect_password on the field', async () => {
    const user = userEvent.setup();
    vi.mocked(users.deleteMe).mockRejectedValue(createApiError(403, 'incorrect_password', 'incorrect password'));
    const { onDeleted } = renderDialog();

    const field = screen.getByLabelText('Current Password');
    await user.type(field, 'wrong');
    await user.click(confirmButton());

    const error = await screen.findByText('Current password is incorrect.');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAttribute('aria-describedby', error.id);
    expect(onDeleted).not.toHaveBeenCalled();
    expect(confirmButton()).toBeEnabled();

    // Editing the field clears the stale error.
    await user.type(field, 'x');
    expect(screen.queryByText('Current password is incorrect.')).not.toBeInTheDocument();
  });

  it('shows incorrect_username on the field', async () => {
    const user = userEvent.setup();
    vi.mocked(users.deleteMe).mockRejectedValue(createApiError(403, 'incorrect_username', 'incorrect username'));
    renderDialog({ hasPassword: false });

    const field = screen.getByLabelText('Type your username (alice) to confirm');
    await user.type(field, 'bob');
    await user.click(confirmButton());

    expect(await screen.findByText('The username does not match.')).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });

  it('explains last_admin instead of showing a generic error', async () => {
    const user = userEvent.setup();
    vi.mocked(users.deleteMe).mockRejectedValue(createApiError(409, 'last_admin', 'the last admin cannot be deleted'));
    const { onDeleted } = renderDialog();

    await user.type(screen.getByLabelText('Current Password'), 'pw');
    await user.click(confirmButton());

    expect(await screen.findByText('You are the only admin')).toBeInTheDocument();
    expect(screen.getByText('Promote another user to admin before you delete your account.')).toBeInTheDocument();
    expect(screen.getByLabelText('Current Password')).not.toHaveAttribute('aria-invalid');
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('shows other errors with the existing error display', async () => {
    const user = userEvent.setup();
    vi.mocked(users.deleteMe).mockRejectedValue(createApiError(400, 'bad_request', 'current_password is required'));
    renderDialog();

    await user.type(screen.getByLabelText('Current Password'), 'pw');
    await user.click(confirmButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('current_password is required');
  });

  it('falls back to a generic message for a network error', async () => {
    const user = userEvent.setup();
    vi.mocked(users.deleteMe).mockRejectedValue(new Error('Network Error'));
    renderDialog();

    await user.type(screen.getByLabelText('Current Password'), 'pw');
    await user.click(confirmButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to delete your account.');
  });

  it('cancels without calling the API', async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(users.deleteMe).not.toHaveBeenCalled();
  });
});
