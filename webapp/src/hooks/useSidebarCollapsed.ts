import { useState } from 'react';

const readCollapsedPreference = () => {
  try {
    const stored = localStorage.getItem('sidebar-collapsed');
    return stored === null ? true : stored === 'true';
  } catch {
    return true;
  }
};

const writeCollapsedPreference = (collapsed: boolean) => {
  try {
    localStorage.setItem('sidebar-collapsed', String(collapsed));
  } catch {
    // Non-critical: fallback to in-memory state when storage is unavailable.
  }
};

export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(readCollapsedPreference);
  const toggle = () => setCollapsed(c => {
    const next = !c;
    writeCollapsedPreference(next);
    return next;
  });
  const collapse = () => setCollapsed(() => {
    writeCollapsedPreference(true);
    return true;
  });
  return { collapsed, toggle, collapse };
}
