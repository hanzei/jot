import { useMemo, useRef, useState } from 'react';
import { DEFAULT_NOTE_COLOR, type Label, type NoteType } from '@jot/shared';
import type { LocalItem } from './listItemModel';

/**
 * The editor's document state — the note being edited, as the screen holds it.
 *
 * This exists to be handed to the hooks that act on that state
 * (`useNoteEditorSync`, `useListItemEditing`) without threading a dozen
 * setters through each of their signatures. Splitting it out also gives the
 * `xRef.current = x` render-time mirrors a single home: they were repeated
 * nine times in the screen, each with its own eslint-disable.
 *
 * Those mirrors are what let debounced saves and async handlers read the
 * *latest* value instead of the one captured when their closure was created.
 * Several of them are also written directly between renders (`flushSave` sets
 * `noteIdRef.current` the moment a create resolves; the item handlers write
 * `itemsRef.current` so a rapid follow-up composes on the newest optimistic
 * state) — assigning them during render keeps both paths consistent, since the
 * next render re-mirrors from state either way.
 */
export interface EditorDocHandle {
  // Latest-value mirrors, for reads from callbacks that may hold a stale closure.
  noteIdRef: React.RefObject<string | null>;
  noteTypeRef: React.RefObject<NoteType>;
  titleRef: React.RefObject<string>;
  contentRef: React.RefObject<string>;
  itemsRef: React.RefObject<LocalItem[]>;
  checkedItemsCollapsedRef: React.RefObject<boolean>;
  pinnedRef: React.RefObject<boolean>;
  archivedRef: React.RefObject<boolean>;
  colorRef: React.RefObject<string>;
  // Setters. Stable across renders, so the handle itself can be memoized once
  // and used as a dependency without recreating anything that depends on it.
  setNoteId: React.Dispatch<React.SetStateAction<string | null>>;
  setNoteType: React.Dispatch<React.SetStateAction<NoteType>>;
  setTitle: React.Dispatch<React.SetStateAction<string>>;
  setContent: React.Dispatch<React.SetStateAction<string>>;
  setItems: React.Dispatch<React.SetStateAction<LocalItem[]>>;
  setCheckedItemsCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setPinned: React.Dispatch<React.SetStateAction<boolean>>;
  setArchived: React.Dispatch<React.SetStateAction<boolean>>;
  setColor: React.Dispatch<React.SetStateAction<string>>;
  setLabels: React.Dispatch<React.SetStateAction<Label[]>>;
  setHasCreated: React.Dispatch<React.SetStateAction<boolean>>;
}

export interface UseEditorDocParams {
  /** Note id from the route: null for a new note. */
  initialNoteId: string | null;
  /** Note type a new note opens as (a new list note from the FAB long-press). */
  initialNoteType?: NoteType | undefined;
  /** Body text a new note is pre-filled with, when opened from a share intent. */
  sharedText?: string | undefined;
  /**
   * The tapped card's color, passed as a nav param so a zoom-open shows the
   * note's background immediately; hydration sets the authoritative value.
   */
  originColor?: string | undefined;
}

export interface EditorDoc {
  noteId: string | null;
  noteType: NoteType;
  title: string;
  content: string;
  items: LocalItem[];
  checkedItemsCollapsed: boolean;
  pinned: boolean;
  archived: boolean;
  color: string;
  labels: Label[];
  hasCreated: boolean;
  handle: EditorDocHandle;
}

export function useEditorDoc({
  initialNoteId,
  initialNoteType,
  sharedText,
  originColor,
}: UseEditorDocParams): EditorDoc {
  const [noteId, setNoteId] = useState<string | null>(initialNoteId);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState(() => (initialNoteId === null ? sharedText ?? '' : ''));
  const [noteType, setNoteType] = useState<NoteType>(() => (initialNoteId === null && initialNoteType ? initialNoteType : 'text'));
  const [items, setItems] = useState<LocalItem[]>([]);
  const [checkedItemsCollapsed, setCheckedItemsCollapsed] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [archived, setArchived] = useState(false);
  const [color, setColor] = useState(originColor || DEFAULT_NOTE_COLOR);
  const [labels, setLabels] = useState<Label[]>([]);
  const [hasCreated, setHasCreated] = useState(initialNoteId !== null);

  const noteIdRef = useRef(noteId);
  const noteTypeRef = useRef(noteType);
  const titleRef = useRef(title);
  const contentRef = useRef(content);
  const itemsRef = useRef(items);
  const checkedItemsCollapsedRef = useRef(checkedItemsCollapsed);
  const pinnedRef = useRef(pinned);
  const archivedRef = useRef(archived);
  const colorRef = useRef(color);

  /* eslint-disable react-hooks/refs -- render-time mirrors; see the doc comment above. Pre-existing, tracked in #777. */
  noteIdRef.current = noteId;
  noteTypeRef.current = noteType;
  titleRef.current = title;
  contentRef.current = content;
  itemsRef.current = items;
  checkedItemsCollapsedRef.current = checkedItemsCollapsed;
  pinnedRef.current = pinned;
  archivedRef.current = archived;
  colorRef.current = color;
  /* eslint-enable react-hooks/refs */

  // Every member is a ref or a useState setter, so the handle never needs to
  // change identity — consumers can depend on it without re-running.
  const handle = useMemo<EditorDocHandle>(
    () => ({
      noteIdRef,
      noteTypeRef,
      titleRef,
      contentRef,
      itemsRef,
      checkedItemsCollapsedRef,
      pinnedRef,
      archivedRef,
      colorRef,
      setNoteId,
      setNoteType,
      setTitle,
      setContent,
      setItems,
      setCheckedItemsCollapsed,
      setPinned,
      setArchived,
      setColor,
      setLabels,
      setHasCreated,
    }),
    [],
  );

  return {
    noteId,
    noteType,
    title,
    content,
    items,
    checkedItemsCollapsed,
    pinned,
    archived,
    color,
    labels,
    hasCreated,
    handle,
  };
}
