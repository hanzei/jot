import { useEffect, useRef, useState } from 'react';
import {
  CheckIcon,
  EllipsisVerticalIcon,
  PlusIcon,
  PencilIcon,
  TagIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import { useTranslation } from 'react-i18next';
import type { Label } from '@jot/shared';
import ConfirmDialog from '@/components/ConfirmDialog';

interface SidebarLabelsProps {
  labels: Label[];
  selectedLabelId?: string | null;
  onSelect?: (labelId: string) => void;
  labelCounts?: Record<string, number> | null;
  onCreate?: (name: string) => Promise<boolean>;
  onRename?: (label: Label, newName: string) => Promise<boolean>;
  onDelete?: (label: Label) => Promise<boolean>;
}

const SidebarLabels = ({
  labels,
  selectedLabelId,
  onSelect,
  labelCounts,
  onCreate,
  onRename,
  onDelete,
}: SidebarLabelsProps) => {
  const { t } = useTranslation();
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [renamingLabelId, setRenamingLabelId] = useState<string | null>(null);
  const [creatingLabel, setCreatingLabel] = useState(false);
  const [newLabelName, setNewLabelName] = useState('');
  const [isCreatingLabel, setIsCreatingLabel] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Label | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingLabelId) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editingLabelId]);

  useEffect(() => {
    if (creatingLabel) {
      createInputRef.current?.focus();
      createInputRef.current?.select();
    }
  }, [creatingLabel]);

  if (labels.length === 0 && !onCreate) {
    return null;
  }

  const startRename = (label: Label) => {
    setCreatingLabel(false);
    setNewLabelName('');
    setEditingLabelId(label.id);
    setDraftName(label.name);
  };

  const cancelRename = () => {
    if (renamingLabelId) {
      return;
    }
    setEditingLabelId(null);
    setDraftName('');
  };

  const startCreate = () => {
    if (!onCreate) {
      return;
    }
    setEditingLabelId(null);
    setDraftName('');
    setCreatingLabel(true);
    setNewLabelName('');
  };

  const cancelCreate = () => {
    if (isCreatingLabel) {
      return;
    }
    setCreatingLabel(false);
    setNewLabelName('');
  };

  const submitCreate = async () => {
    const nextName = newLabelName.trim();
    if (!nextName || !onCreate || isCreatingLabel) {
      return;
    }

    setIsCreatingLabel(true);
    const success = await onCreate(nextName);
    setIsCreatingLabel(false);
    if (success) {
      setCreatingLabel(false);
      setNewLabelName('');
    }
  };

  const submitRename = async (label: Label) => {
    const nextName = draftName.trim();
    if (!nextName || renamingLabelId || !onRename) {
      return;
    }

    setRenamingLabelId(label.id);
    const success = await onRename(label, nextName);
    setRenamingLabelId(null);
    if (success) {
      setEditingLabelId(null);
      setDraftName('');
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || !onDelete || isDeleting) {
      return;
    }

    setIsDeleting(true);
    const success = await onDelete(deleteTarget);
    setIsDeleting(false);
    if (success) {
      setDeleteTarget(null);
    }
  };

  return (
    <>
      <div className="px-2 pb-2" data-testid="sidebar-labels">
      <ul className="space-y-0.5">
        {labels.map((label) => {
          const isActive = selectedLabelId === label.id;
          const className = `flex items-center gap-2 flex-1 min-w-0 text-left px-3 py-1.5 rounded-md text-sm ${
            isActive
              ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium'
              : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-700'
          }`;
          const isEditing = editingLabelId === label.id;
          const isRenaming = renamingLabelId === label.id;

          return (
            <li key={label.id} className="group">
              {isEditing ? (
                <div className="flex items-center gap-1 rounded-md px-2 py-1.5 bg-gray-100 dark:bg-slate-700">
                  <TagIcon className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-300" />
                  <input
                    ref={inputRef}
                    type="text"
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void submitRename(label);
                      } else if (event.key === 'Escape') {
                        event.preventDefault();
                        cancelRename();
                      }
                    }}
                    aria-label={t('labels.renameInputLabel', { name: label.name })}
                    placeholder={t('labels.renamePlaceholder')}
                    className="min-w-0 flex-1 bg-transparent text-sm text-gray-900 dark:text-white outline-none placeholder:text-gray-400 dark:placeholder:text-gray-500"
                    disabled={isRenaming}
                  />
                  <button
                    type="button"
                    onClick={() => void submitRename(label)}
                    disabled={!draftName.trim() || isRenaming}
                    aria-label={t('labels.renameSave')}
                    className="rounded p-1 text-green-600 hover:bg-green-50 disabled:opacity-50 dark:text-green-400 dark:hover:bg-green-900/20"
                  >
                    <CheckIcon className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={cancelRename}
                    disabled={isRenaming}
                    aria-label={t('labels.renameCancel')}
                    className="rounded p-1 text-gray-500 hover:bg-gray-200 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-slate-600"
                  >
                    <XMarkIcon className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onSelect?.(label.id)}
                    className={className}
                    aria-describedby={labelCounts ? `label-count-${label.id}` : undefined}
                    aria-pressed={isActive ? true : undefined}
                  >
                    <TagIcon className="h-4 w-4 shrink-0" />
                    <span className="truncate min-w-0">{label.name}</span>
                    {labelCounts && (
                      <span
                        id={`label-count-${label.id}`}
                        data-testid={`label-count-${label.id}`}
                        className={`ml-auto shrink-0 text-xs ${isActive ? 'text-blue-600 dark:text-blue-300' : 'text-gray-400 dark:text-gray-500'}`}
                      >
                        {labelCounts[label.id] ?? 0}
                      </span>
                    )}
                  </button>
                  {onRename && onDelete && (
                    <Menu as="div" className="relative shrink-0">
                      <MenuButton
                        aria-label={t('labels.menuOptions', { name: label.name })}
                        className="shrink-0 rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-slate-700 dark:hover:text-white"
                      >
                        <EllipsisVerticalIcon className="h-4 w-4" />
                      </MenuButton>
                      <MenuItems
                        className="absolute right-0 z-20 mt-1 w-40 rounded-md border border-gray-200 bg-white shadow-lg ring-1 ring-black/5 focus:outline-none dark:border-slate-600 dark:bg-slate-800"
                      >
                        <div className="py-1">
                          <MenuItem>
                            <button
                              type="button"
                              onClick={() => startRename(label)}
                              className="flex w-full items-center px-4 py-2 text-sm text-gray-700 data-[focus]:bg-gray-100 dark:text-gray-200 dark:data-[focus]:bg-slate-700"
                            >
                              <PencilIcon className="mr-2 h-4 w-4" />
                              {t('labels.rename')}
                            </button>
                          </MenuItem>
                          <MenuItem>
                            <button
                              type="button"
                              onClick={() => setDeleteTarget(label)}
                              className="flex w-full items-center px-4 py-2 text-sm text-red-600 data-[focus]:bg-gray-100 dark:text-red-400 dark:data-[focus]:bg-slate-700"
                            >
                              <TrashIcon className="mr-2 h-4 w-4" />
                              {t('labels.delete')}
                            </button>
                          </MenuItem>
                        </div>
                      </MenuItems>
                    </Menu>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {onCreate && (
        <div className="mt-2 border-t border-gray-200 pt-2 dark:border-slate-700">
          {creatingLabel ? (
            <div className="flex items-center gap-1 rounded-md px-2 py-1.5 bg-gray-100 dark:bg-slate-700">
              <TagIcon className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-300" />
              <input
                ref={createInputRef}
                type="text"
                value={newLabelName}
                onChange={(event) => setNewLabelName(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void submitCreate();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelCreate();
                  }
                }}
                aria-label={t('labels.createInputLabel')}
                placeholder={t('labels.newLabelPlaceholder')}
                className="min-w-0 flex-1 bg-transparent text-sm text-gray-900 dark:text-white outline-none placeholder:text-gray-400 dark:placeholder:text-gray-500"
                disabled={isCreatingLabel}
              />
              <button
                type="button"
                onClick={() => void submitCreate()}
                disabled={!newLabelName.trim() || isCreatingLabel}
                aria-label={t('labels.createSave')}
                className="rounded p-1 text-green-600 hover:bg-green-50 disabled:opacity-50 dark:text-green-400 dark:hover:bg-green-900/20"
              >
                <CheckIcon className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={cancelCreate}
                disabled={isCreatingLabel}
                aria-label={t('labels.createCancel')}
                className="rounded p-1 text-gray-500 hover:bg-gray-200 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-slate-600"
              >
                <XMarkIcon className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={startCreate}
              className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/20"
            >
              <PlusIcon className="h-4 w-4 shrink-0" />
              <span>{t('labels.newSidebar')}</span>
            </button>
          )}
        </div>
      )}
      </div>
      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('labels.deleteConfirmTitle')}
        message={deleteTarget ? t('labels.deleteConfirmMessage', { name: deleteTarget.name }) : ''}
        confirmLabel={t('labels.delete')}
        onConfirm={confirmDelete}
        onCancel={() => {
          if (!isDeleting) {
            setDeleteTarget(null);
          }
        }}
      />
    </>
  );
};

export default SidebarLabels;
