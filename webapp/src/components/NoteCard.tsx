import { useState } from 'react';
import {
  EllipsisVerticalIcon,
  TrashIcon,
  ArchiveBoxIcon,
  ArchiveBoxXMarkIcon,
  ShareIcon,
  ArrowUturnLeftIcon,
  DocumentDuplicateIcon,
} from '@heroicons/react/24/outline';
import { Menu, MenuButton, MenuItems, MenuItem } from '@headlessui/react';
import { useTranslation } from 'react-i18next';
import { VALIDATION, type Note, type User } from '@jot/shared';
import { notes } from '@/utils/api';
import LetterAvatar from '@/components/LetterAvatar';
import LinkText from '@/components/LinkText';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useToast } from '@/hooks/useToast';
import { buildShareAvatars } from '@/utils/shareAvatars';

interface NoteCardProps {
  note: Note;
  onEdit: (note: Note) => void;
  onDelete: (noteId: string) => void;
  onDuplicate?: (noteId: string) => Promise<void> | void;
  onShare?: (note: Note) => void;
  onRestore?: (noteId: string) => void;
  onPermanentlyDelete?: (noteId: string) => void;
  currentUserId?: string;
  usersById?: Map<string, User>;
  inBin?: boolean;
  onRefresh?: () => void;
}

export default function NoteCard({ note, onEdit, onDelete, onDuplicate, onShare, onRestore, onPermanentlyDelete, currentUserId, usersById, inBin = false, onRefresh }: NoteCardProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [isUpdating, setIsUpdating] = useState(false);
  const [confirmState, setConfirmState] = useState<{
    open: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
  }>({ open: false, title: '', message: '', confirmLabel: '', onConfirm: () => {} });

  const isOwner = note.user_id === currentUserId;

  const getColorClass = (color: string) => {
    const colorMap: Record<string, string> = {
      '#ffffff': '',
      '#f28b82': 'coral',
      '#fbbc04': 'yellow',
      '#ccff90': 'lime',
      '#a7ffeb': 'teal',
      '#aecbfa': 'periwinkle',
      '#d7aefb': 'lavender',
      '#fdcfe8': 'pink',
      '#e6c9a8': 'sand',
      '#e8eaed': 'gray',
    };
    return colorMap[color] || '';
  };

  const handleToggleArchive = async () => {
    setIsUpdating(true);
    try {
      const willArchive = !note.archived;
      await notes.update(note.id, {
        title: note.title,
        content: note.content,
        pinned: note.pinned,
        archived: willArchive,
        color: note.color,
        checked_items_collapsed: note.checked_items_collapsed,
      });
      onRefresh?.();
      showToast(
        willArchive ? t('dashboard.noteArchived') : t('dashboard.noteUnarchived'),
        'success'
      );
    } catch (error) {
      console.error('Failed to toggle archive:', error);
      showToast(t('note.failedArchive'), 'error');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleTogglePin = async () => {
    setIsUpdating(true);
    try {
      const willPin = !note.pinned;
      await notes.update(note.id, {
        title: note.title,
        content: note.content,
        pinned: willPin,
        archived: note.archived,
        color: note.color,
        checked_items_collapsed: note.checked_items_collapsed,
      });
      onRefresh?.();
      showToast(
        willPin ? t('dashboard.notePinned') : t('dashboard.noteUnpinned'),
        'success'
      );
    } catch (error) {
      console.error('Failed to toggle pin:', error);
      showToast(t('note.failedPin'), 'error');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDelete = () => {
    setConfirmState({
      open: true,
      title: t('note.deleteConfirmTitle'),
      message: t('note.deleteConfirm'),
      confirmLabel: t('note.delete'),
      onConfirm: () => onDelete(note.id),
    });
  };

  const handleRestore = () => {
    onRestore?.(note.id);
  };

  const handleDuplicate = async () => {
    if (!onDuplicate) return;

    setIsUpdating(true);
    try {
      await onDuplicate(note.id);
    } catch (error) {
      console.error('Failed to duplicate note:', error);
      showToast(t('note.failedDuplicate'), 'error');
    } finally {
      setIsUpdating(false);
    }
  };

  const handlePermanentlyDelete = () => {
    setConfirmState({
      open: true,
      title: t('note.deleteForeverTitle'),
      message: t('note.deleteForeverConfirm'),
      confirmLabel: t('note.deleteForever'),
      onConfirm: () => onPermanentlyDelete?.(note.id),
    });
  };

  return (
    <div
      data-testid="note-card"
      data-note-card="true"
      tabIndex={0}
      aria-label={note.title || t('share.untitledNote')}
      className={`note-card ${getColorClass(note.color)} p-4 relative group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 ${isUpdating ? 'opacity-50' : ''
        }`}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (!inBin && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onEdit(note);
        }
      }}
    >
      {note.pinned && (
        <div className="absolute top-2 right-8">
          <svg data-testid="pin-icon" className="h-3 w-3 text-blue-500" fill="currentColor" viewBox="0 0 24 24">
            <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
          </svg>
        </div>
      )}

      {/* Menu */}
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
      <Menu>
        <MenuButton aria-label={t('note.menuOptions')} className="p-1 rounded-full hover:bg-gray-200 transition-colors">
          <EllipsisVerticalIcon className="h-4 w-4 text-gray-600" />
        </MenuButton>
        <MenuItems className="absolute right-0 mt-1 w-48 bg-white dark:bg-slate-800 rounded-md shadow-lg ring-1 ring-black dark:ring-slate-600 ring-opacity-5 focus:outline-none z-10 border border-gray-200 dark:border-slate-600">
          <div className="py-1">
            {inBin ? (
              <>
                {onRestore && (
                  <MenuItem>
                    <button
                      onClick={handleRestore}
                      className="flex items-center w-full px-4 py-2 text-sm text-gray-700 dark:text-gray-200 data-[focus]:bg-gray-100 dark:data-[focus]:bg-slate-700"
                    >
                      <ArrowUturnLeftIcon className="h-4 w-4 mr-2" />
                      {t('note.restore')}
                    </button>
                  </MenuItem>
                )}
                {onPermanentlyDelete && (
                  <MenuItem>
                    <button
                      onClick={handlePermanentlyDelete}
                      className="flex items-center w-full px-4 py-2 text-sm text-red-600 dark:text-red-400 data-[focus]:bg-gray-100 dark:data-[focus]:bg-slate-700"
                    >
                      <TrashIcon className="h-4 w-4 mr-2" />
                      {t('note.deleteForever')}
                    </button>
                  </MenuItem>
                )}
              </>
            ) : (
              <>
                {isOwner && onShare && (
                  <MenuItem>
                    <button
                      onClick={() => onShare(note)}
                      className="flex items-center w-full px-4 py-2 text-sm text-gray-700 dark:text-gray-200 data-[focus]:bg-gray-100 dark:data-[focus]:bg-slate-700"
                    >
                      <ShareIcon className="h-4 w-4 mr-2" />
                      {t('note.share')}
                    </button>
                  </MenuItem>
                )}
                <MenuItem>
                  <button
                    onClick={handleTogglePin}
                    className="flex items-center w-full px-4 py-2 text-sm text-gray-700 dark:text-gray-200 data-[focus]:bg-gray-100 dark:data-[focus]:bg-slate-700"
                  >
                    <svg className="h-4 w-4 mr-2" fill={note.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
                    </svg>
                    {note.pinned ? t('note.unpin') : t('note.pin')}
                  </button>
                </MenuItem>
                <MenuItem>
                  <button
                    onClick={handleToggleArchive}
                    className="flex items-center w-full px-4 py-2 text-sm text-gray-700 dark:text-gray-200 data-[focus]:bg-gray-100 dark:data-[focus]:bg-slate-700"
                  >
                    {note.archived ? (
                      <>
                        <ArchiveBoxXMarkIcon className="h-4 w-4 mr-2" />
                        {t('note.unarchive')}
                      </>
                    ) : (
                      <>
                        <ArchiveBoxIcon className="h-4 w-4 mr-2" />
                        {t('note.archive')}
                      </>
                    )}
                  </button>
                </MenuItem>
                {onDuplicate && (
                  <MenuItem>
                    <button
                      onClick={handleDuplicate}
                      className="flex items-center w-full px-4 py-2 text-sm text-gray-700 dark:text-gray-200 data-[focus]:bg-gray-100 dark:data-[focus]:bg-slate-700"
                    >
                      <DocumentDuplicateIcon className="h-4 w-4 mr-2" />
                      {t('note.duplicate')}
                    </button>
                  </MenuItem>
                )}
                {isOwner && (
                  <MenuItem>
                    <button
                      onClick={handleDelete}
                      className="flex items-center w-full px-4 py-2 text-sm text-red-600 dark:text-red-400 data-[focus]:bg-gray-100 dark:data-[focus]:bg-slate-700"
                    >
                      <TrashIcon className="h-4 w-4 mr-2" />
                      {t('note.delete')}
                    </button>
                  </MenuItem>
                )}
              </>
            )}
          </div>
        </MenuItems>
      </Menu>
      </div>

      {/* Content */}
      <div
        onClick={() => !inBin && onEdit(note)}
        className={`${inBin ? 'cursor-default' : 'cursor-pointer'}`}
      >
        {note.title && (
          <h3 className="font-medium text-gray-900 dark:text-white mb-2 line-clamp-2">
            {note.title}
          </h3>
        )}

        {note.note_type === 'text' ? (
          <div className="text-sm text-gray-700 dark:text-gray-200 line-clamp-6 whitespace-pre-wrap">
            {note.content}
          </div>
        ) : (
          <div className="space-y-1">
            {(() => {
              const uncompletedItems = note.items?.filter(item => !item.completed) || [];
              const completedItems = note.items?.filter(item => item.completed) || [];

              return (
                <>
                  {uncompletedItems.map((item) => {
                    const normalizedIndentLevel = Math.max(0, Number(item.indent_level) || 0);
                    return (
                      <div key={item.id} className="flex items-start min-w-0 text-sm" style={{ marginLeft: normalizedIndentLevel * VALIDATION.INDENT_PX_PER_LEVEL }}>
                        <input
                          type="checkbox"
                          checked={item.completed}
                          readOnly
                          className="h-4 w-4 text-blue-600 rounded mr-2 mt-0.5 flex-shrink-0"
                        />
                        <span className="min-w-0 whitespace-pre-wrap break-words text-gray-700 dark:text-gray-200">
                          <LinkText text={item.text} />
                        </span>
                      </div>
                    );
                  })}
                  {completedItems.length > 0 && (
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                      {t('note.moreCompletedItems', { count: completedItems.length })}
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}
      </div>

      {/* Labels */}
      {note.labels && note.labels.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {note.labels.slice(0, 3).map(label => (
            <span
              key={label.id}
              className="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full px-2 py-0.5"
            >
              {label.name}
            </span>
          ))}
          {note.labels.length > 3 && (
            <span className="text-xs text-gray-500 dark:text-gray-400">+{note.labels.length - 3}</span>
          )}
        </div>
      )}

      {/* Shared user avatars */}
      {note.is_shared && (() => {
        const avatars = buildShareAvatars(note, currentUserId, usersById);
        if (avatars.length === 0) return null;
        return (
          <div className="flex items-center mt-2">
            {avatars.map((a, index) => (
              <div key={a.key} title={a.displayName}>
                <LetterAvatar
                  firstName={a.firstName}
                  username={a.username}
                  userId={a.userId}
                  hasProfileIcon={a.hasProfileIcon}
                  className={`w-5 h-5 ring-2 ring-white dark:ring-slate-800 ${index > 0 ? '-ml-1' : ''}`}
                />
              </div>
            ))}
          </div>
        );
      })()}

      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.title}
        message={confirmState.message}
        confirmLabel={confirmState.confirmLabel}
        onConfirm={() => {
          const action = confirmState.onConfirm;
          setConfirmState(prev => ({ ...prev, open: false }));
          action();
        }}
        onCancel={() => setConfirmState(prev => ({ ...prev, open: false }))}
      />
    </div>
  );
}
