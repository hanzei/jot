import { describe, it, expect, afterEach } from 'vitest';
import { applyTheme } from '../theme';

describe('applyTheme', () => {
  const root = document.documentElement;

  afterEach(() => {
    root.classList.remove('dark');
    root.style.colorScheme = '';
  });

  // index.css derives the body background and native UI from color-scheme, so
  // it has to follow the in-app preference, not the OS (stubbed to light here).
  it('pins color-scheme to an explicit preference over the system one', () => {
    applyTheme('dark');
    expect(root).toHaveClass('dark');
    expect(root.style.colorScheme).toBe('dark');

    applyTheme('light');
    expect(root).not.toHaveClass('dark');
    expect(root.style.colorScheme).toBe('light');
  });

  it('resolves the system preference to a concrete scheme', () => {
    applyTheme('system');
    expect(root).not.toHaveClass('dark');
    expect(root.style.colorScheme).toBe('light');
  });
});
