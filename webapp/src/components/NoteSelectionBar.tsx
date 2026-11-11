import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import { Archive, ArchiveX, Check, Minus, Palette, Pin, PinOff, Tag, Trash2, Undo2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NOTE_COLORS, NOTE_COLOR_NAME_KEYS, type Label } from '@jot/shared';

/** How many of the selected notes carry a label. */
export type SelectionLabelState = 'all' | 'some' | 'none';

interface NoteSelectionBarProps {
  count: number;
  inBin: boolean;
  /** True while a batch is running; every action is disabled until it settles. */
  busy: boolean;
  allPinned: boolean;
  allArchived: boolean;
  labels: ReadonlyArray<{ label: Label; state: SelectionLabelState }>;
  onClear: () => void;
  onTogglePin: () => void;
  onToggleArchive: () => void;
  onColor: (color: string) => void;
  onToggleLabel: (label: Label) => void;
  onDelete: () => void;
  onRestore: () => void;
  onDeleteForever: () => void;
}

const BUTTON_CLASS = 'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-200 dark:hover:bg-slate-700';
// Anchored panels render in a portal and keep inside the viewport, which a
// right-aligned absolute panel does not on a phone-width header.
const PANEL_CLASS = 'z-50 max-w-[calc(100vw-2rem)] origin-top-right rounded-md border border-gray-200 bg-white shadow-lg ring-1 ring-black/5 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:ring-slate-600/20';

/**
 * The dashboard header while notes are selected (#1255): the count, the
 * actions that apply to every selected note, and a way out. The trash view
 * offers restore and delete forever instead.
 */
export default function NoteSelectionBar({
  count,
  inBin,
  busy,
  allPinned,
  allArchived,
  labels,
  onClear,
  onTogglePin,
  onToggleArchive,
  onColor,
  onToggleLabel,
  onDelete,
  onRestore,
  onDeleteForever,
}: NoteSelectionBarProps) {
  const { t } = useTranslation();

  return (
    <div
      data-testid="note-selection-bar"
      role="toolbar"
      aria-label={t('dashboard.selection.toolbarLabel')}
      className="flex w-full sm:max-w-7xl flex-wrap items-center gap-1"
    >
      <button
        type="button"
        onClick={onClear}
        aria-label={t('dashboard.selection.clear')}
        title={t('dashboard.selection.clear')}
        className={BUTTON_CLASS}
      >
        <X className="h-5 w-5" aria-hidden="true" />
      </button>
      <span data-testid="note-selection-count" className="mr-auto px-1 text-sm font-semibold text-gray-900 dark:text-white">
        {t('dashboard.selection.count', { count })}
      </span>

      {inBin ? (
        <>
          <button type="button" onClick={onRestore} disabled={busy} className={BUTTON_CLASS}>
            <Undo2 className="h-4 w-4" aria-hidden="true" />
            {t('note.restore')}
          </button>
          <button type="button" onClick={onDeleteForever} disabled={busy} className={`${BUTTON_CLASS} !text-red-700 dark:!text-red-300`}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            {t('note.deleteForever')}
          </button>
        </>
      ) : (
        <>
          <button type="button" onClick={onTogglePin} disabled={busy} className={BUTTON_CLASS}>
            {allPinned ? <PinOff className="h-4 w-4" aria-hidden="true" /> : <Pin className="h-4 w-4" aria-hidden="true" />}
            {allPinned ? t('note.unpin') : t('note.pin')}
          </button>
          <button type="button" onClick={onToggleArchive} disabled={busy} className={BUTTON_CLASS}>
            {allArchived ? <ArchiveX className="h-4 w-4" aria-hidden="true" /> : <Archive className="h-4 w-4" aria-hidden="true" />}
            {allArchived ? t('note.unarchive') : t('note.archive')}
          </button>
          <Menu as="div" className="relative">
            <MenuButton disabled={busy} className={BUTTON_CLASS}>
              <Palette className="h-4 w-4" aria-hidden="true" />
              {t('dashboard.selection.color')}
            </MenuButton>
            <MenuItems anchor={{ to: 'bottom end', gap: 4 }} className={`${PANEL_CLASS} grid w-56 grid-cols-5 gap-2 p-3`}>
              {NOTE_COLORS.map((color) => (
                <MenuItem key={color}>
                  <button
                    type="button"
                    onClick={() => onColor(color)}
                    aria-label={t(NOTE_COLOR_NAME_KEYS[color])}
                    title={t(NOTE_COLOR_NAME_KEYS[color])}
                    style={{ backgroundColor: color }}
                    className="h-8 w-8 rounded-full border border-gray-400 dark:border-slate-400 data-[focus]:ring-2 data-[focus]:ring-blue-500 data-[focus]:ring-offset-2 dark:data-[focus]:ring-offset-slate-800"
                  />
                </MenuItem>
              ))}
            </MenuItems>
          </Menu>
          <Menu as="div" className="relative">
            <MenuButton disabled={busy || labels.length === 0} className={BUTTON_CLASS}>
              <Tag className="h-4 w-4" aria-hidden="true" />
              {t('dashboard.selection.labels')}
            </MenuButton>
            <MenuItems
              anchor={{ to: 'bottom end', gap: 4 }}
              data-testid="note-selection-labels"
              className={`${PANEL_CLASS} max-h-72 w-60 overflow-y-auto py-1`}
            >
              {labels.map(({ label, state }) => (
                <MenuItem key={label.id}>
                  {/* Headless UI fixes the role to menuitem, which cannot
                      carry aria-checked, so the state is part of the name. */}
                  <button
                    type="button"
                    aria-label={state === 'all'
                      ? t('dashboard.selection.labelOnAll', { name: label.name })
                      : state === 'some' ? t('dashboard.selection.labelOnSome', { name: label.name }) : label.name}
                    onClick={() => onToggleLabel(label)}
                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 data-[focus]:bg-gray-100 dark:text-gray-200 dark:data-[focus]:bg-slate-700"
                  >
                    <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-gray-500 dark:border-slate-400">
                      {state === 'all' && <Check className="h-3 w-3" />}
                      {state === 'some' && <Minus className="h-3 w-3" />}
                    </span>
                    <span className="truncate">{label.name}</span>
                  </button>
                </MenuItem>
              ))}
            </MenuItems>
          </Menu>
          <button type="button" onClick={onDelete} disabled={busy} className={`${BUTTON_CLASS} !text-red-700 dark:!text-red-300`}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            {t('note.delete')}
          </button>
        </>
      )}
    </div>
  );
}
