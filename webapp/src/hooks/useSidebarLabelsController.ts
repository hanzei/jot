import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Label } from '@jot/shared';
import { labels as labelsApi, isAxiosError } from '@/utils/api';
import { useToast } from '@/hooks/useToast';

interface LoadOptions {
  preserveOnError?: boolean;
}

interface SidebarLabelsControllerOptions {
  onCreateSuccess?: (createdLabel: Label) => Promise<void> | void;
  onRenameSuccess?: (label: Label, newName: string) => Promise<void> | void;
  onDeleteSuccess?: (label: Label) => Promise<void> | void;
}

export const useSidebarLabelsController = ({
  onCreateSuccess,
  onRenameSuccess,
  onDeleteSuccess,
}: SidebarLabelsControllerOptions = {}) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [labels, setLabels] = useState<Label[]>([]);
  const [labelCounts, setLabelCounts] = useState<Record<string, number> | null>(null);

  const loadLabels = useCallback(async ({ preserveOnError = false }: LoadOptions = {}) => {
    try {
      const nextLabels = await labelsApi.getAll();
      setLabels(nextLabels);
      return nextLabels;
    } catch {
      if (!preserveOnError) {
        setLabels([]);
      }
      return null;
    }
  }, []);

  const loadLabelCounts = useCallback(async ({ preserveOnError = false }: LoadOptions = {}) => {
    try {
      const counts = await labelsApi.getCounts();
      setLabelCounts(counts);
      return counts;
    } catch {
      if (!preserveOnError) {
        setLabelCounts(null);
      }
      return null;
    }
  }, []);

  const handleCreateLabel = useCallback(async (name: string): Promise<boolean> => {
    try {
      const createdLabel = await labelsApi.create(name);
      setLabels((prev) => {
        if (prev.some((label) => label.id === createdLabel.id)) {
          return prev;
        }
        return [...prev, createdLabel];
      });
      if (onCreateSuccess) {
        try {
          await onCreateSuccess(createdLabel);
        } catch (callbackError) {
          // Keep mutation success semantics if a page-specific callback fails.
          console.error('Sidebar label create success callback failed:', callbackError);
        }
      }
      await Promise.all([
        loadLabels({ preserveOnError: true }),
        loadLabelCounts({ preserveOnError: true }),
      ]);
      showToast(t('labels.createSuccess'), 'success');
      return true;
    } catch (err: unknown) {
      if (isAxiosError(err)) {
        const msg = typeof err.response?.data === 'string' ? err.response.data.trim() : '';
        showToast(msg || t('labels.createError'), 'error');
      } else {
        showToast(t('labels.createError'), 'error');
      }
      return false;
    }
  }, [loadLabelCounts, loadLabels, onCreateSuccess, showToast, t]);

  const handleRenameLabel = useCallback(async (label: Label, newName: string): Promise<boolean> => {
    try {
      await labelsApi.rename(label.id, newName);
      if (onRenameSuccess) {
        try {
          await onRenameSuccess(label, newName);
        } catch (callbackError) {
          // Keep mutation success semantics if a page-specific callback fails.
          console.error('Sidebar label rename success callback failed:', callbackError);
        }
      }
      await Promise.all([
        loadLabels({ preserveOnError: true }),
        loadLabelCounts({ preserveOnError: true }),
      ]);
      showToast(t('labels.renameSuccess'), 'success');
      return true;
    } catch (err: unknown) {
      if (isAxiosError(err)) {
        const msg = typeof err.response?.data === 'string' ? err.response.data.trim() : '';
        showToast(msg || t('labels.renameError'), 'error');
      } else {
        showToast(t('labels.renameError'), 'error');
      }
      return false;
    }
  }, [loadLabelCounts, loadLabels, onRenameSuccess, showToast, t]);

  const handleDeleteLabel = useCallback(async (label: Label): Promise<boolean> => {
    try {
      await labelsApi.delete(label.id);
      if (onDeleteSuccess) {
        try {
          await onDeleteSuccess(label);
        } catch (callbackError) {
          // Keep mutation success semantics if a page-specific callback fails.
          console.error('Sidebar label delete success callback failed:', callbackError);
        }
      }
      await Promise.all([
        loadLabels({ preserveOnError: true }),
        loadLabelCounts({ preserveOnError: true }),
      ]);
      showToast(t('labels.deleteSuccess'), 'success');
      return true;
    } catch (err: unknown) {
      if (isAxiosError(err)) {
        const msg = typeof err.response?.data === 'string' ? err.response.data.trim() : '';
        showToast(msg || t('labels.deleteError'), 'error');
      } else {
        showToast(t('labels.deleteError'), 'error');
      }
      return false;
    }
  }, [loadLabelCounts, loadLabels, onDeleteSuccess, showToast, t]);

  return {
    labels,
    labelCounts,
    loadLabels,
    loadLabelCounts,
    handleCreateLabel,
    handleRenameLabel,
    handleDeleteLabel,
  };
};
