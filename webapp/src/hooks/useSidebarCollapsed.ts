import { useState } from 'react';

export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    const stored = localStorage.getItem('sidebar-collapsed');
    return stored === null ? true : stored === 'true';
  });
  const toggle = () => setCollapsed(c => {
    const next = !c;
    localStorage.setItem('sidebar-collapsed', String(next));
    return next;
  });
  const collapse = () => setCollapsed(() => {
    localStorage.setItem('sidebar-collapsed', 'true');
    return true;
  });
  return { collapsed, toggle, collapse };
}
