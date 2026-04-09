import { createContext, useContext } from 'react';

interface SidebarContextValue {
  isExpanded: boolean;
  onMobileCollapse: () => void;
}

const SidebarContext = createContext<SidebarContextValue>({ isExpanded: true, onMobileCollapse: () => {} });

export const useSidebarExpanded = () => useContext(SidebarContext).isExpanded;
export const useSidebarMobileCollapse = () => useContext(SidebarContext).onMobileCollapse;
export default SidebarContext;
