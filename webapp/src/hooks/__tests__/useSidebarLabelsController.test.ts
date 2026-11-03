import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { LabelWithCount } from '@jot/shared';
import { useSidebarLabelsController } from '../useSidebarLabelsController';
import { labels as labelsApi } from '@/utils/api';
import { createApiError } from '@/utils/__tests__/test-helpers';

vi.mock('@/utils/api', async () => {
  const actual = await vi.importActual<typeof import('@/utils/api')>('@/utils/api');
  return {
    ...actual,
    labels: {
      ...actual.labels,
      getAll: vi.fn(),
      create: vi.fn(),
      rename: vi.fn(),
      delete: vi.fn(),
    },
  };
});

const mockShowToast = vi.fn();
const mockShowErrorToast = vi.fn();
vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ showToast: mockShowToast, showErrorToast: mockShowErrorToast }),
}));

const makeLabel = (overrides: Partial<LabelWithCount> = {}): LabelWithCount => ({
  id: 'label1',
  name: 'Work',
  user_id: 'user1',
  created_at: '2023-01-01T00:00:00Z',
  updated_at: '2023-01-01T00:00:00Z',
  note_count: 0,
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

      let returned: LabelWithCount[] | null = [];
      await act(async () => {
        returned = await result.current.loadLabels();
      });

      expect(returned).toBeNull();
    });
  });

  describe('handleCreateLabel', () => {
    it('adds the created label, refreshes, and toasts success', async () => {
      const created = makeLabel({ id: 'new1', name: 'New' });
      vi.mocked(labelsApi.create).mockResolvedValue(created);
      vi.mocked(labelsApi.getAll).mockResolvedValue([created]);
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
      expect(mockShowErrorToast).toHaveBeenCalledWith(expect.any(String), expect.anything());
    });
  });

  describe('handleRenameLabel', () => {
    it('renames, refreshes, calls onRenameSuccess, and toasts success', async () => {
      const label = makeLabel();
      vi.mocked(labelsApi.rename).mockResolvedValue({ ...label, name: 'Renamed' });
      vi.mocked(labelsApi.getAll).mockResolvedValue([{ ...label, name: 'Renamed' }]);
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
      vi.mocked(labelsApi.rename).mockRejectedValue(createApiError(400, 'validation_failed', 'Name already in use'));
      const { result } = renderHook(() => useSidebarLabelsController());

      let ok = true;
      await act(async () => {
        ok = await result.current.handleRenameLabel(makeLabel(), 'Renamed');
      });

      expect(ok).toBe(false);
      expect(mockShowErrorToast).toHaveBeenCalledWith('Name already in use', expect.anything());
    });
  });

  describe('handleDeleteLabel', () => {
    it('deletes, refreshes, calls onDeleteSuccess, and toasts success', async () => {
      const label = makeLabel();
      vi.mocked(labelsApi.delete).mockResolvedValue(undefined);
      vi.mocked(labelsApi.getAll).mockResolvedValue([]);
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
      expect(mockShowErrorToast).toHaveBeenCalledWith(expect.any(String), expect.anything());
    });
  });

  it('exposes the per-label note_count from the label list', async () => {
    vi.mocked(labelsApi.getAll).mockResolvedValue([makeLabel({ note_count: 3 })]);
    const { result } = renderHook(() => useSidebarLabelsController());

    await act(async () => {
      await result.current.loadLabels();
    });

    await waitFor(() => {
      expect(result.current.labels.map((l) => l.note_count)).toEqual([3]);
    });
  });
});
