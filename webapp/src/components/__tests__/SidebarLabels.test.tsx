import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { LabelWithCount } from '@jot/shared';
import SidebarLabels from '../SidebarLabels';

const label: LabelWithCount = {
  id: 'l1',
  user_id: 'user1',
  name: 'Work',
  note_count: 1,
  created_at: '2023-01-01T00:00:00Z',
  updated_at: '2023-01-01T00:00:00Z',
};

// The keystroke that confirms an IME candidate: Chrome/Firefox flag it with
// isComposing, Safari delivers it after compositionend so only keyCode 229 does.
const imeConfirmations = [{ isComposing: true }, { keyCode: 229 }];

describe('SidebarLabels', () => {
  it('does not create a label on an Enter that confirms an IME composition', () => {
    const onCreate = vi.fn().mockResolvedValue(true);
    render(<SidebarLabels labels={[label]} onCreate={onCreate} />);

    fireEvent.click(screen.getByText('New Label'));
    const input = screen.getByRole('textbox', { name: 'New label name' });
    fireEvent.change(input, { target: { value: 'しごと' } });

    for (const init of imeConfirmations) {
      fireEvent.keyDown(input, { key: 'Enter', ...init });
    }
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    expect(onCreate).not.toHaveBeenCalled();
    expect(input).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCreate).toHaveBeenCalledWith('しごと');
  });

  it('does not rename a label on an Enter that confirms an IME composition', () => {
    const onRename = vi.fn().mockResolvedValue(true);
    // The label menu only renders when both rename and delete are wired up.
    render(<SidebarLabels labels={[label]} onRename={onRename} onDelete={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Label options for Work' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Rename label Work' });
    fireEvent.change(input, { target: { value: 'しごと' } });

    for (const init of imeConfirmations) {
      fireEvent.keyDown(input, { key: 'Enter', ...init });
    }
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    expect(onRename).not.toHaveBeenCalled();
    expect(input).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith(expect.objectContaining({ id: 'l1' }), 'しごと');
  });
});
