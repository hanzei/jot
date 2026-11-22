import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import PendingLogoutNotice from '../PendingLogoutNotice';

vi.mock('@/utils/logout', () => ({ endServerSession: vi.fn() }));

describe('PendingLogoutNotice', () => {
  it('offers a retry', () => {
    render(<PendingLogoutNotice onEnded={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('blocks the retry while a sign-in is being submitted', () => {
    render(<PendingLogoutNotice onEnded={vi.fn()} disabled />);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
  });
});
