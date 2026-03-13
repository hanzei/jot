import { useState } from 'react';

export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() =>
    localStorage.getItem('sidebar-collapsed') === 'true'
  );
  const toggle = () => setCollapsed(c => {
    const next = !c;
    localStorage.setItem('sidebar-collapsed', String(next));
    return next;
  });
  const collapse = () => setCollapsed(true);
  return { collapsed, toggle, collapse };
}
