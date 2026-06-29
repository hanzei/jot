import * as SecureStore from 'expo-secure-store';

/**
 * Dashboard layout is a device-only preference (not synced via user settings):
 * - 'list' renders one note per row (the classic layout).
 * - 'grid' renders a two-column staggered masonry of notes.
 */
export type DashboardLayout = 'list' | 'grid';

export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayout = 'list';

const DASHBOARD_LAYOUT_KEY = 'jot_dashboard_layout';

const isDashboardLayout = (value: unknown): value is DashboardLayout =>
  value === 'list' || value === 'grid';

export async function getDashboardLayout(): Promise<DashboardLayout> {
  try {
    const raw = await SecureStore.getItemAsync(DASHBOARD_LAYOUT_KEY);
    return isDashboardLayout(raw) ? raw : DEFAULT_DASHBOARD_LAYOUT;
  } catch {
    return DEFAULT_DASHBOARD_LAYOUT;
  }
}

export async function setDashboardLayout(layout: DashboardLayout): Promise<void> {
  try {
    await SecureStore.setItemAsync(DASHBOARD_LAYOUT_KEY, layout);
  } catch {
    // Storage failure — skip persistence; the in-session layout is already
    // updated by the caller, so the toggle still works for this session.
  }
}
