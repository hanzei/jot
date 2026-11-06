import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Label, LabelWithCount } from '@jot/shared';
import { labels as labelsApi } from '@/utils/api';
import { useToast } from '@/hooks/useToast';
import { apiErrorMessage } from '@/utils/apiError';

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
  const { showToast, showErrorToast } = useToast();
  const [labels, setLabels] = useState<LabelWithCount[]>([]);

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

  const handleCreateLabel = useCallback(async (name: string): Promise<boolean> => {
    try {
      const createdLabel = await labelsApi.create(name);
      setLabels((prev) => {
        if (prev.some((label) => label.id === createdLabel.id)) {
          return prev;
        }
        return [...prev, { ...createdLabel, note_count: 0 }];
      });
      if (onCreateSuccess) {
        try {
          await onCreateSuccess(createdLabel);
        } catch (callbackError) {
          // Keep mutation success semantics if a page-specific callback fails.
          console.error('Sidebar label create success callback failed:', callbackError);
        }
      }
      await loadLabels({ preserveOnError: true });
      showToast(t('labels.createSuccess'), 'success');
      return true;
    } catch (err: unknown) {
      showErrorToast(apiErrorMessage(err, t, 'labels.createError'), err);
      return false;
    }
  }, [loadLabels, onCreateSuccess, showToast, showErrorToast, t]);

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
      await loadLabels({ preserveOnError: true });
      showToast(t('labels.renameSuccess'), 'success');
      return true;
    } catch (err: unknown) {
      showErrorToast(apiErrorMessage(err, t, 'labels.renameError'), err);
      return false;
    }
  }, [loadLabels, onRenameSuccess, showToast, showErrorToast, t]);

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
      await loadLabels({ preserveOnError: true });
      showToast(t('labels.deleteSuccess'), 'success');
      return true;
    } catch (err: unknown) {
      showErrorToast(apiErrorMessage(err, t, 'labels.deleteError'), err);
      return false;
    }
  }, [loadLabels, onDeleteSuccess, showToast, showErrorToast, t]);

  return {
    labels,
    loadLabels,
    handleCreateLabel,
    handleRenameLabel,
    handleDeleteLabel,
  };
};
