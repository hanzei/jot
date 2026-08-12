import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Label } from '@jot/shared';
import { useSidebarLabelsController } from '../useSidebarLabelsController';
import { labels as labelsApi } from '@/utils/api';

vi.mock('@/utils/api', async () => {
  const actual = await vi.importActual<typeof import('@/utils/api')>('@/utils/api');
  return {
    ...actual,
    labels: {
      ...actual.labels,
      getAll: vi.fn(),
      getCounts: vi.fn(),
      create: vi.fn(),
      rename: vi.fn(),
      delete: vi.fn(),
    },
  };
});

const mockShowToast = vi.fn();
vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));

const makeLabel = (overrides: Partial<Label> = {}): Label => ({
  id: 'label1',
  name: 'Work',
  user_id: 'user1',
  created_at: '2023-01-01T00:00:00Z',
  updated_at: '2023-01-01T00:00:00Z',
  ...overrides,
});

describe('useSidebarLabelsController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loadLabels', () => {
    it('populates labels on success', async () => {
      const label = makeLabel();
      vi.mocked(labelsApi.getAll).mockResolvedValue([label]);
      const { result } = renderHook(() => useSidebarLabelsController());

      await act(async () => {
        await result.current.loadLabels();
      });

      expect(result.current.labels).toEqual([label]);
    });

    it('clears labels on error by default', async () => {
      vi.mocked(labelsApi.getAll)
        .mockResolvedValueOnce([makeLabel()])
        .mockRejectedValueOnce(new Error('network'));
      const { result } = renderHook(() => useSidebarLabelsController());

      await act(async () => {
        await result.current.loadLabels();
      });
      expect(result.current.labels).toHaveLength(1);

      await act(async () => {
        await result.current.loadLabels();
      });
      expect(result.current.labels).toEqual([]);
    });

    it('preserves prior labels on error when preserveOnError is set', async () => {
      const label = makeLabel();
      vi.mocked(labelsApi.getAll)
        .mockResolvedValueOnce([label])
        .mockRejectedValueOnce(new Error('network'));
      const { result } = renderHook(() => useSidebarLabelsController());

      await act(async () => {
        await result.current.loadLabels();
      });
      await act(async () => {
        await result.current.loadLabels({ preserveOnError: true });
      });

      expect(result.current.labels).toEqual([label]);
    });

    it('returns null on error', async () => {
      vi.mocked(labelsApi.getAll).mockRejectedValue(new Error('network'));
      const { result } = renderHook(() => useSidebarLabelsController());

      let returned: Label[] | null = [];
      await act(async () => {
        returned = await result.current.loadLabels();
      });

      expect(returned).toBeNull();
    });
  });

  describe('loadLabelCounts', () => {
    it('populates counts on success', async () => {
      vi.mocked(labelsApi.getCounts).mockResolvedValue({ label1: 3 });
      const { result } = renderHook(() => useSidebarLabelsController());

      await act(async () => {
        await result.current.loadLabelCounts();
      });

      expect(result.current.labelCounts).toEqual({ label1: 3 });
    });

    it('resets counts to null on error by default', async () => {
      vi.mocked(labelsApi.getCounts)
        .mockResolvedValueOnce({ label1: 3 })
        .mockRejectedValueOnce(new Error('network'));
      const { result } = renderHook(() => useSidebarLabelsController());

      await act(async () => {
        await result.current.loadLabelCounts();
      });
      await act(async () => {
        await result.current.loadLabelCounts();
      });

      expect(result.current.labelCounts).toBeNull();
    });

    it('preserves prior counts on error when preserveOnError is set', async () => {
      vi.mocked(labelsApi.getCounts)
        .mockResolvedValueOnce({ label1: 3 })
        .mockRejectedValueOnce(new Error('network'));
      const { result } = renderHook(() => useSidebarLabelsController());

      await act(async () => {
        await result.current.loadLabelCounts();
      });
      await act(async () => {
        await result.current.loadLabelCounts({ preserveOnError: true });
      });

      expect(result.current.labelCounts).toEqual({ label1: 3 });
    });
  });

  describe('handleCreateLabel', () => {
    it('adds the created label, refreshes, and toasts success', async () => {
      const created = makeLabel({ id: 'new1', name: 'New' });
      vi.mocked(labelsApi.create).mockResolvedValue(created);
      vi.mocked(labelsApi.getAll).mockResolvedValue([created]);
      vi.mocked(labelsApi.getCounts).mockResolvedValue({});
      const { result } = renderHook(() => useSidebarLabelsController());

      let ok = false;
      await act(async () => {
        ok = await result.current.handleCreateLabel('New');
      });

      expect(ok).toBe(true);
      expect(result.current.labels).toEqual([created]);
      expect(mockShowToast).toHaveBeenCalledWith(expect.any(String), 'success');
    });

    it('calls onCreateSuccess with the created label', async () => {
      const created = makeLabel({ id: 'new1', name: 'New' });
      vi.mocked(labelsApi.create).mockResolvedValue(created);
      vi.mocked(labelsApi.getAll).mockResolvedValue([]);
      vi.mocked(labelsApi.getCounts).mockResolvedValue({});
      const onCreateSuccess = vi.fn();
      const { result } = renderHook(() => useSidebarLabelsController({ onCreateSuccess }));

      await act(async () => {
        await result.current.handleCreateLabel('New');
      });

      expect(onCreateSuccess).toHaveBeenCalledWith(created);
    });

    it('does not fail the create when onCreateSuccess itself throws', async () => {
      const created = makeLabel({ id: 'new1', name: 'New' });
      vi.mocked(labelsApi.create).mockResolvedValue(created);
      vi.mocked(labelsApi.getAll).mockResolvedValue([created]);
      vi.mocked(labelsApi.getCounts).mockResolvedValue({});
      const onCreateSuccess = vi.fn().mockRejectedValue(new Error('callback failed'));
      const { result } = renderHook(() => useSidebarLabelsController({ onCreateSuccess }));

      let ok = false;
      await act(async () => {
        ok = await result.current.handleCreateLabel('New');
      });

      expect(ok).toBe(true);
    });

    it('toasts an error and returns false on failure', async () => {
      vi.mocked(labelsApi.create).mockRejectedValue(new Error('server error'));
      const { result } = renderHook(() => useSidebarLabelsController());

      let ok = true;
      await act(async () => {
        ok = await result.current.handleCreateLabel('New');
      });

      expect(ok).toBe(false);
      expect(mockShowToast).toHaveBeenCalledWith(expect.any(String), 'error');
    });
  });

  describe('handleRenameLabel', () => {
    it('renames, refreshes, calls onRenameSuccess, and toasts success', async () => {
      const label = makeLabel();
      vi.mocked(labelsApi.rename).mockResolvedValue({ ...label, name: 'Renamed' });
      vi.mocked(labelsApi.getAll).mockResolvedValue([{ ...label, name: 'Renamed' }]);
      vi.mocked(labelsApi.getCounts).mockResolvedValue({});
      const onRenameSuccess = vi.fn();
      const { result } = renderHook(() => useSidebarLabelsController({ onRenameSuccess }));

      let ok = false;
      await act(async () => {
        ok = await result.current.handleRenameLabel(label, 'Renamed');
      });

      expect(ok).toBe(true);
      expect(onRenameSuccess).toHaveBeenCalledWith(label, 'Renamed');
      expect(mockShowToast).toHaveBeenCalledWith(expect.any(String), 'success');
    });

    it('surfaces the server error message when the request fails', async () => {
      vi.mocked(labelsApi.rename).mockRejectedValue({
        isAxiosError: true,
        response: { data: 'Name already in use' },
      });
      const { result } = renderHook(() => useSidebarLabelsController());

      let ok = true;
      await act(async () => {
        ok = await result.current.handleRenameLabel(makeLabel(), 'Renamed');
      });

      expect(ok).toBe(false);
      expect(mockShowToast).toHaveBeenCalledWith('Name already in use', 'error');
    });
  });

  describe('handleDeleteLabel', () => {
    it('deletes, refreshes, calls onDeleteSuccess, and toasts success', async () => {
      const label = makeLabel();
      vi.mocked(labelsApi.delete).mockResolvedValue(undefined);
      vi.mocked(labelsApi.getAll).mockResolvedValue([]);
      vi.mocked(labelsApi.getCounts).mockResolvedValue({});
      const onDeleteSuccess = vi.fn();
      const { result } = renderHook(() => useSidebarLabelsController({ onDeleteSuccess }));

      let ok = false;
      await act(async () => {
        ok = await result.current.handleDeleteLabel(label);
      });

      expect(ok).toBe(true);
      expect(onDeleteSuccess).toHaveBeenCalledWith(label);
      expect(mockShowToast).toHaveBeenCalledWith(expect.any(String), 'success');
    });

    it('toasts an error and returns false on failure', async () => {
      vi.mocked(labelsApi.delete).mockRejectedValue(new Error('server error'));
      const { result } = renderHook(() => useSidebarLabelsController());

      let ok = true;
      await act(async () => {
        ok = await result.current.handleDeleteLabel(makeLabel());
      });

      expect(ok).toBe(false);
      expect(mockShowToast).toHaveBeenCalledWith(expect.any(String), 'error');
    });
  });

  it('reflects concurrent loadLabels/loadLabelCounts calls once both settle', async () => {
    vi.mocked(labelsApi.getAll).mockResolvedValue([makeLabel()]);
    vi.mocked(labelsApi.getCounts).mockResolvedValue({ label1: 1 });
    const { result } = renderHook(() => useSidebarLabelsController());

    act(() => {
      void result.current.loadLabels();
      void result.current.loadLabelCounts();
    });

    await waitFor(() => {
      expect(result.current.labels).toHaveLength(1);
      expect(result.current.labelCounts).toEqual({ label1: 1 });
    });
  });
});
