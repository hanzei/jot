import { useRef, useState } from 'react';
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
import InlineMarkdown from '@/components/InlineMarkdown';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useToast } from '@/hooks/useToast';
import { buildShareAvatars } from '@/utils/shareAvatars';
import { renderMarkdown } from '@/utils/markdown';

interface NoteCardProps {
  note: Note;
  onEdit: (note: Note) => void;
  onDelete: (noteId: string) => void;
  onDuplicate?: ((noteId: string) => Promise<void> | void) | undefined;
  onShare?: ((note: Note) => void) | undefined;
  onRestore?: ((noteId: string) => void) | undefined;
  onPermanentlyDelete?: ((noteId: string) => void) | undefined;
  currentUserId?: string | undefined;
  usersById?: Map<string, User> | undefined;
  inBin?: boolean;
  onRefresh?: (() => void) | undefined;
  onLabelClick?: ((labelId: string) => void) | undefined;
  /**
   * Rendered into the card's top-right controls, beside the overflow menu.
   *
   * A slot rather than a `sortable` prop on purpose: the only caller passes a
   * drag handle, and passing it as a node keeps every dnd-kit detail — the
   * activator ref, `attributes`, `listeners` — in `SortableNoteCard`, which is
   * the component that actually calls `useSortable`. A card rendered outside a
   * sortable context just omits it.
   */
  dragHandle?: React.ReactNode;
  /**
   * Whether this card holds the grid's one roving-tabindex stop (#950):
   * exactly one card's open button (and, when it's also this one, the drag
   * handle and overflow menu) is a Tab stop at a time, collapsing what used to
   * be three stops per card down to a stop per grid. Defaults to `true` so a
   * card rendered outside `SortableNoteCard` — as every test in
   * `NoteCard.test.tsx` does — keeps its ordinary, always-focusable button.
   */
  isActive?: boolean;
  /**
   * Fires when any focusable control inside the card gains focus. Relies on
   * React's `onFocus` bubbling (it's backed by the native `focusin` event),
   * so one handler on the card's own container catches the open button, the
   * drag handle and the overflow menu alike without wiring each separately.
   */
  onCardFocus?: ((noteId: string) => void) | undefined;
}

function MenuKbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd aria-hidden="true" className="ml-2 inline-flex rounded border border-gray-300 dark:border-slate-600 bg-gray-100 dark:bg-slate-700 px-1.5 py-0.5 font-mono text-xs text-gray-500 dark:text-gray-400">
      {children}
    </kbd>
  );
}

export default function NoteCard({ note, onEdit, onDelete, onDuplicate, onShare, onRestore, onPermanentlyDelete, currentUserId, usersById, inBin = false, onRefresh, onLabelClick, dragHandle, isActive = true, onCardFocus }: NoteCardProps) {
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

  const openButtonRef = useRef<HTMLButtonElement>(null);

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
    onDelete(note.id);
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
      className={`note-card ${getColorClass(note.color)} p-4 relative group ${isUpdating ? 'opacity-50' : ''}`}
      onClick={() => {
        // Hand focus to the card's own control before opening. A click used to
        // focus the card itself, because the card div carried tabIndex={0};
        // now it is a plain container and the button over it takes no pointer
        // events, so without this a click leaves focus on <main>. Two things
        // depend on it: the note modal restores focus to whatever was focused
        // when it opened, and the dashboard's arrow / Home / End navigation
        // only runs when a card holds focus.
        //
        // Safe to do unconditionally here — the overflow menu and the label
        // chips stop propagation, so this handler only ever sees a click on the
        // card itself.
        openButtonRef.current?.focus();
        onEdit(note);
      }}
      // Roving tabindex (#950): React's onFocus is backed by the bubbling
      // native `focusin` event, so this one handler sees focus land on the
      // open button below, the drag handle, or the overflow menu — whichever
      // of the card's controls a click, Tab, or the dashboard's arrow-key/
      // Home/End navigation actually focuses — without wiring each of them.
      onFocus={() => onCardFocus?.(note.id)}
    >
      {/*
        The card's primary action, as a real button rather than a tabIndex on
        the card div. The card used to be its own control, which put a focusable
        element around the overflow menu and the label chips — the
        nested-interactive violation in #799 — and made Space mean two different
        things depending on which of the two stops you were on.

        It carries no click handler and no pointer events, which is what keeps
        this a change of semantics rather than of behaviour:

        - Keyboard activation is the browser's. Enter and Space on a <button>
          synthesize a click, and that click bubbles to the card's own onClick.
          One handler still owns "activating this card opens the note".
        - `pointer-events-none` means a mouse never lands here at all. Clicks go
          on hitting the card exactly as before, so drag-anywhere, the label
          chips' stopPropagation, and the native tooltips on the share avatars
          all keep working without a z-index rule between them.

        It must stay a *sibling* of the menu button and the label chips. An
        ancestor of them is the violation this replaced.
      */}
      <button
        type="button"
        ref={openButtonRef}
        data-note-card="true"
        data-testid="note-card-open"
        aria-label={(note.note_type === 'list' ? note.title : note.content?.slice(0, 50)) || t('share.untitledNote')}
        // Roving tabindex (#950): the grid's one Tab stop lives on whichever
        // card's open button is currently active; every other card's is
        // reachable only by `.focus()` (arrow keys, Home/End, a click).
        tabIndex={isActive ? 0 : -1}
        className="absolute inset-0 rounded-lg pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
      />
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

      {/* The card's controls, top right: the drag handle, then the overflow
          menu, which keeps the corner it has always had.

          DOM order matches left-to-right order on purpose. These two sit side
          by side, so a tab order that ran the other way would move focus right
          and then back left across a pair of adjacent icons.

          Both are absolute rather than a flex row: the handle is invisible
          until focused, and a flex row would still reserve its width and shift
          the menu left by that much at rest. */}
      {dragHandle}
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
      <Menu>
        {/* Roving tabindex (#950): out of the Tab sequence for every card but
            the active one, same as the drag handle in SortableNoteCard —
            otherwise the per-card stop count this issue exists to collapse
            only shrinks from three to two. A click still reaches it, tabIndex
            only governs sequential Tab order. */}
        <MenuButton aria-label={t('note.menuOptions')} tabIndex={isActive ? 0 : -1} className="p-1 rounded-full bg-white/80 dark:bg-slate-900/70 text-gray-700 dark:text-gray-200 shadow-sm hover:bg-white dark:hover:bg-slate-900 transition-colors">
          <EllipsisVertical className="h-4 w-4" />
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
            // links={false} in effect: the card is one control that opens the
            // note, so an anchor here would follow the link *and* open the note.
            // docs/specs/markdown-rendering.md §1.1.
            dangerouslySetInnerHTML={{ __html: renderMarkdown(note.content, { links: false }) }}
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
                        <InlineMarkdown
                          text={item.text}
                          links={false}
                          className="min-w-0 whitespace-pre-wrap break-words text-gray-700 dark:text-gray-200"
                        />
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
