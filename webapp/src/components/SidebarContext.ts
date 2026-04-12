import { createContext, useContext } from 'react';

export const SidebarContext = createContext(true);
export const useSidebarExpanded = () => useContext(SidebarContext);
