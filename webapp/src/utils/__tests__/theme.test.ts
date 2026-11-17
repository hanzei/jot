import { describe, it, expect, afterEach } from 'vitest';
import { applyTheme } from '../theme';

describe('applyTheme', () => {
  const root = document.documentElement;

  afterEach(() => {
    root.classList.remove('dark', 'light');
  });

  // index.css derives color-scheme (and from it the body background and native
  // UI) from these classes, so they have to follow the in-app preference, not
  // the OS (stubbed to light here).
  it('pins the scheme to an explicit preference over the system one', () => {
    applyTheme('dark');
    expect(root).toHaveClass('dark');
    expect(root).not.toHaveClass('light');

    applyTheme('light');
    expect(root).toHaveClass('light');
    expect(root).not.toHaveClass('dark');
  });

  it('resolves the system preference to a concrete scheme', () => {
    applyTheme('system');
    expect(root).toHaveClass('light');
    expect(root).not.toHaveClass('dark');
  });
});
