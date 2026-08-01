import { useState } from 'react';
import {
  EllipsisVertical,
  Trash2,
  Archive,
  ArchiveX,
  UserPlus,
  Undo2,
  Copy,
  Pin,
} from 'lucide-react';
import { Menu, MenuButton, MenuItems, MenuItem } from '@headlessui/react';
import { useTranslation } from 'react-i18next';
import { VALIDATION, type Note, type User } from '@jot/shared';
import { notes, images as imagesApi } from '@/utils/api';
import LetterAvatar from '@/components/LetterAvatar';
import LinkText from '@/components/LinkText';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useToast } from '@/hooks/useToast';
import { buildShareAvatars } from '@/utils/shareAvatars';
import { renderMarkdown } from '@/utils/markdown';

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
  onLabelClick?: (labelId: string) => void;
}

function MenuKbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd aria-hidden="true" className="ml-2 inline-flex rounded border border-gray-300 dark:border-slate-600 bg-gray-100 dark:bg-slate-700 px-1.5 py-0.5 font-mono text-xs text-gray-500 dark:text-gray-400">
      {children}
    </kbd>
  );
}

export default function NoteCard({ note, onEdit, onDelete, onDuplicate, onShare, onRestore, onPermanentlyDelete, currentUserId, usersById, inBin = false, onRefresh, onLabelClick }: NoteCardProps) {
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
  const coverImage = note.images?.[0];
  const extraImageCount = (note.images?.length ?? 0) - 1;

  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    if (inBin) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;

    const key = e.key.toLowerCase();
    const isDeleteKey = e.key === 'Delete' || e.key === 'Backspace';

    if (key === 'p') {
      e.preventDefault(); e.stopPropagation(); handleTogglePin();
    } else if (key === 'a') {
      e.preventDefault(); e.stopPropagation(); handleToggleArchive();
    } else if (key === 'd' && onDuplicate) {
      e.preventDefault(); e.stopPropagation(); handleDuplicate();
    } else if (key === 's' && isOwner && onShare) {
      e.preventDefault(); e.stopPropagation(); onShare(note);
    } else if (isDeleteKey && isOwner) {
      e.preventDefault(); e.stopPropagation(); handleDelete();
    }
  };

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
      // Send only the field that changed — the card's note prop can be stale,
      // so re-sending title/content here would overwrite concurrent edits made
      // in another tab or by a collaborator.
      await notes.update(note.id, { archived: willArchive });
      onRefresh?.();
      showToast(
        willArchive ? t('dashboard.noteArchived') : t('dashboard.noteUnarchived'),
        'success',
        {
          label: t('dashboard.undo'),
          onClick: async () => {
            try {
              await notes.update(note.id, { archived: !willArchive });
              onRefresh?.();
            } catch (undoError) {
              console.error('Failed to undo archive toggle:', undoError);
              showToast(t('note.failedArchive'), 'error');
            }
          },
        }
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
      // Send only the field that changed (see handleToggleArchive).
      await notes.update(note.id, { pinned: willPin });
      onRefresh?.();
      showToast(
        willPin ? t('dashboard.notePinned') : t('dashboard.noteUnpinned'),
        'success',
        {
          label: t('dashboard.undo'),
          onClick: async () => {
            try {
              await notes.update(note.id, { pinned: !willPin });
              onRefresh?.();
            } catch (undoError) {
              console.error('Failed to undo pin toggle:', undoError);
              showToast(t('note.failedPin'), 'error');
            }
          },
        }
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
      aria-label={(note.note_type === 'list' ? note.title : note.content?.slice(0, 50)) || t('share.untitledNote')}
      className={`note-card ${getColorClass(note.color)} p-4 relative group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 ${isUpdating ? 'opacity-50' : ''} ${!inBin ? 'cursor-pointer' : ''
        }`}
      onClick={() => !inBin && onEdit(note)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (!inBin && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onEdit(note);
        }
      }}
    >
      {coverImage && (
        <div className="relative -mx-4 -mt-4 mb-2 rounded-t-lg overflow-hidden" data-testid="note-card-cover">
          <img
            src={imagesApi.thumbnailUrl(coverImage.id)}
            alt={coverImage.filename}
            className="w-full h-40 object-cover"
          />
          {extraImageCount > 0 && (
            <span
              className="absolute bottom-1 right-1 rounded-full bg-black/60 text-white text-xs px-1.5 py-0.5"
              aria-label={t('images.moreImagesBadge', { count: extraImageCount })}
            >
              +{extraImageCount}
            </span>
          )}
        </div>
      )}

      {/* Menu */}
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
      <Menu>
        <MenuButton aria-label={t('note.menuOptions')} className="p-1 rounded-full hover:bg-gray-200 transition-colors">
          <EllipsisVertical className="h-4 w-4 text-gray-600" />
        </MenuButton>
        <MenuItems transition onKeyDownCapture={handleMenuKeyDown} className="absolute right-0 mt-1 w-52 origin-top-right bg-white dark:bg-slate-800 rounded-md shadow-lg ring-1 ring-black/5 dark:ring-slate-600/20 focus:outline-none z-10 border border-gray-200 dark:border-slate-600 transition duration-100 ease-out data-[closed]:scale-95 data-[closed]:opacity-0 motion-reduce:transition-none">
          <div className="py-1">
            {inBin ? (
              <>
                {onRestore && (
                  <MenuItem>
                    <button
                      onClick={handleRestore}
                      className="flex items-center w-full px-4 py-2 text-sm text-gray-700 dark:text-gray-200 data-[focus]:bg-gray-100 dark:data-[focus]:bg-slate-700"
                    >
                      <Undo2 className="h-4 w-4 mr-2" />
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
                      <Trash2 className="h-4 w-4 mr-2" />
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
                      className="flex items-center justify-between w-full px-4 py-2 text-sm text-gray-700 dark:text-gray-200 data-[focus]:bg-gray-100 dark:data-[focus]:bg-slate-700"
                    >
                      <span className="flex items-center">
                        <UserPlus className="h-4 w-4 mr-2" />
                        {t('note.share')}
                      </span>
                      <MenuKbd>S</MenuKbd>
                    </button>
                  </MenuItem>
                )}
                <MenuItem>
                  <button
                    onClick={handleTogglePin}
                    className="flex items-center justify-between w-full px-4 py-2 text-sm text-gray-700 dark:text-gray-200 data-[focus]:bg-gray-100 dark:data-[focus]:bg-slate-700"
                  >
                    <span className="flex items-center">
                      <Pin className="h-4 w-4 mr-2" fill={note.pinned ? 'currentColor' : 'none'} />
                      {note.pinned ? t('note.unpin') : t('note.pin')}
                    </span>
                    <MenuKbd>P</MenuKbd>
                  </button>
                </MenuItem>
                <MenuItem>
                  <button
                    onClick={handleToggleArchive}
                    className="flex items-center justify-between w-full px-4 py-2 text-sm text-gray-700 dark:text-gray-200 data-[focus]:bg-gray-100 dark:data-[focus]:bg-slate-700"
                  >
                    <span className="flex items-center">
                      {note.archived ? (
                        <>
                          <ArchiveX className="h-4 w-4 mr-2" />
                          {t('note.unarchive')}
                        </>
                      ) : (
                        <>
                          <Archive className="h-4 w-4 mr-2" />
                          {t('note.archive')}
                        </>
                      )}
                    </span>
                    <MenuKbd>A</MenuKbd>
                  </button>
                </MenuItem>
                {onDuplicate && (
                  <MenuItem>
                    <button
                      onClick={handleDuplicate}
                      className="flex items-center justify-between w-full px-4 py-2 text-sm text-gray-700 dark:text-gray-200 data-[focus]:bg-gray-100 dark:data-[focus]:bg-slate-700"
                    >
                      <span className="flex items-center">
                        <Copy className="h-4 w-4 mr-2" />
                        {t('note.duplicate')}
                      </span>
                      <MenuKbd>D</MenuKbd>
                    </button>
                  </MenuItem>
                )}
                {isOwner && (
                  <MenuItem>
                    <button
                      onClick={handleDelete}
                      className="flex items-center justify-between w-full px-4 py-2 text-sm text-red-600 dark:text-red-400 data-[focus]:bg-gray-100 dark:data-[focus]:bg-slate-700"
                    >
                      <span className="flex items-center">
                        <Trash2 className="h-4 w-4 mr-2" />
                        {t('note.delete')}
                      </span>
                      <MenuKbd>Del</MenuKbd>
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
      <div>
        {note.note_type === 'list' && note.title && (
          <h3 className="font-medium text-gray-900 dark:text-white mb-2 line-clamp-2">
            {note.title}
          </h3>
        )}

        {note.note_type === 'text' ? (
          <div
            className="text-sm text-gray-700 dark:text-gray-200 line-clamp-6 markdown-content"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(note.content) }}
          />
        ) : (
          <div className="space-y-1">
            {(() => {
              const uncompletedItems = note.items?.filter(item => !item.completed) || [];
              const completedItems = note.items?.filter(item => item.completed) || [];

              return (
                <>
                  {uncompletedItems.map((item) => {
                    // A child (parent_id set) renders one level indented; nesting
                    // is capped at one level.
                    const normalizedIndentLevel = item.parent_id ? 1 : 0;
                    return (
                      <div key={item.id} className="flex items-start min-w-0 text-sm" style={{ marginLeft: normalizedIndentLevel * VALIDATION.INDENT_PX_PER_LEVEL }}>
                        {/* Decorative: this preview only ever renders
                            uncompleted items, so the box conveys nothing a
                            screen reader needs, and leaving it in the tree
                            adds an unlabelled control plus a tab stop inside
                            a card that is itself a single tab stop. */}
                        <input
                          type="checkbox"
                          checked={item.completed}
                          readOnly
                          tabIndex={-1}
                          aria-hidden="true"
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
            onLabelClick ? (
              <button
                key={label.id}
                type="button"
                onClick={(e) => { e.stopPropagation(); onLabelClick(label.id); }}
                className="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full px-2 py-0.5 hover:bg-blue-200 dark:hover:bg-blue-800/40 transition-colors cursor-pointer"
              >
                {label.name}
              </button>
            ) : (
              <span
                key={label.id}
                className="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full px-2 py-0.5"
              >
                {label.name}
              </span>
            )
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
                  iconVersion={a.iconVersion}
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
