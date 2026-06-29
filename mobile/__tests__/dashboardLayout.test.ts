import * as SecureStore from 'expo-secure-store';
import {
  getDashboardLayout,
  setDashboardLayout,
  DEFAULT_DASHBOARD_LAYOUT,
} from '../src/utils/dashboardLayout';

const mockGet = SecureStore.getItemAsync as jest.Mock;
const mockSet = SecureStore.setItemAsync as jest.Mock;

describe('dashboardLayout', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('defaults to list when nothing is stored', async () => {
    mockGet.mockResolvedValueOnce(null);
    await expect(getDashboardLayout()).resolves.toBe(DEFAULT_DASHBOARD_LAYOUT);
  });

  it('returns a stored grid preference', async () => {
    mockGet.mockResolvedValueOnce('grid');
    await expect(getDashboardLayout()).resolves.toBe('grid');
  });

  it('falls back to the default for an unknown stored value', async () => {
    mockGet.mockResolvedValueOnce('weird');
    await expect(getDashboardLayout()).resolves.toBe('list');
  });

  it('returns the default if reading throws', async () => {
    mockGet.mockRejectedValueOnce(new Error('boom'));
    await expect(getDashboardLayout()).resolves.toBe('list');
  });

  it('persists the selected layout', async () => {
    await setDashboardLayout('grid');
    expect(mockSet).toHaveBeenCalledWith('jot_dashboard_layout', 'grid');
  });

  it('swallows write failures', async () => {
    mockSet.mockRejectedValueOnce(new Error('boom'));
    await expect(setDashboardLayout('grid')).resolves.toBeUndefined();
  });
});
