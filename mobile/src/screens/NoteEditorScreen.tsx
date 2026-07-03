import React, { useState, useEffect, useRef, useCallback, useMemo, useContext } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  TouchableOpacity,
  Alert,
  KeyboardAvoidingView,
  Platform,
  InputAccessoryView,
  Keyboard,
  Modal,
  Share,
  type TextInputProps,
  type TextInput as TextInputType,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import {
  NestedReorderableList,
  ScrollViewContainer,
  reorderItems,
  type ReorderableListReorderEvent,
  type ReorderableListDragEndEvent,
  type ReorderableListRenderItemInfo,
} from 'react-native-reorderable-list';
import { Gesture } from 'react-native-gesture-handler';
import { LinearTransition, useSharedValue, runOnJS } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { useCreateNote, useUpdateNote, useDeleteNote, useRestoreNote, useDuplicateNote, useCreateNoteItem, useUpdateNoteItem, useDeleteNoteItem, useReorderNoteItems, useToggleNoteItemCompleted } from '../hooks/useNotes';
import { useOfflineNote } from '../hooks/useOfflineNotes';
import { useKeyboardHeight } from '../hooks/useKeyboardHeight';
import { isLocalId } from '../db/noteQueries';
import { useFailedNoteIds } from '../store/OfflineContext';
import { useSSESubscription } from '../store/SSEContext';
import { useToast } from '../hooks/useToast';
import ColorPicker from '../components/ColorPicker';
import LabelPicker from '../components/LabelPicker';
import AssigneePicker from '../components/AssigneePicker';
import AddImageActionSheet from '../components/AddImageActionSheet';
import { useUploadNoteImage, useDeleteNoteImage } from '../hooks/useNoteImages';
import { usePendingImageUploads, useRetryPendingImageUpload, useDismissPendingImageUpload } from '../hooks/usePendingImageUploads';
import type { ImageUploadFile } from '../api/images';
import { buildCollaborators, generateId, VALIDATION, IMAGE_MAX_PER_NOTE, type Collaborator, type NoteType, type NoteImage, type CreateNoteRequest, type UpdateNoteRequest, type UpdateListNoteRequest, type UpdateTextNoteRequest, type PatchNoteItemRequest, type Label } from '@jot/shared';
import { validateImageFile as validateImageFileRaw, IMAGE_MAX_MB } from '../utils/imageValidation';
import { useAuth } from '../store/AuthContext';
import { useUsers } from '../store/UsersContext';
import { useTheme } from '../theme/ThemeContext';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { getCompletedSectionDividerColor, isWhiteHexColor } from '../utils/colorContrast';
import { formatEditorStateForShare } from '../utils/noteTextFormatter';
import { fullMarkdownStyles, preprocessMarkdown } from '../utils/markdownStyles';
import { getActiveServer, listServers, type ServerAccountEntry } from '../store/serverAccounts';
import { setPendingShare, usePendingShare } from '../store/shareIntent';
import { useBannerShown } from '../hooks/useBannerShown';
import {
  type LocalItem,
  type ItemSnapshot,
  toLocalItems,
  serializeItems,
  itemSnapshot,
  normalizeItemOrder,
  itemHasChildren,
  applyCompletedCascade,
  droppedParentId,
  indentLevelFromDrag,
} from './noteEditor/listItemModel';
import { MarkdownToolbarContent } from './noteEditor/EditorToolbars';
import CheckedItemsSection, { type ListItemHandlers } from './noteEditor/CheckedItemsSection';
import NoteImageGallery, { type PendingImageUpload } from '../components/NoteImageGallery';
import { styles } from './noteEditor/styles';
import { animateListReflow, isReduceMotionEnabledSync } from '../utils/layoutAnimation';
import ActiveListRow from './noteEditor/ActiveListRow';

type EditorRouteProp = RouteProp<RootStackParamList, 'NoteEditor'>;
type EditorNavProp = NativeStackNavigationProp<RootStackParamList, 'NoteEditor'>;

const IOS_KEYBOARD_VERTICAL_OFFSET = 88;
const FOCUSED_INPUT_KEYBOARD_MARGIN = 120;
const MARKDOWN_TOOLBAR_ID = 'markdown-formatting-toolbar';
// Duration (ms) of the row slide when the active list reflows after a toggle/delete.
const LIST_REFLOW_ANIM_MS = 150;
const MAX_EXIT_SAVE_RETRIES = 3;
// Override the reorderable list's default cell animation so the dragged row is
// fully static apart from following the finger: opacity stays 1 and no scale is
// applied. The library's default opacity/scale animations could otherwise stick
// after a drop and leave the row greyed out or enlarged. Module-scoped so the
// reference stays stable across renders.
const DRAG_CELL_ANIMATIONS = { opacity: 1, transform: [] };

export default function NoteEditorScreen() {
  const navigation = useNavigation<EditorNavProp>();
  const route = useRoute<EditorRouteProp>();
  const { noteId: initialNoteId, sharedText } = route.params;
  const { t, i18n } = useTranslation();
  const failedNoteIds = useFailedNoteIds();

  // A new note opened from an Android share intent arrives with sharedText to
  // pre-fill the body.
  const openedFromShare = initialNoteId === null && !!sharedText;

  const [noteId, setNoteId] = useState<string | null>(initialNoteId);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState(() => (initialNoteId === null ? sharedText ?? '' : ''));
  const [noteType, setNoteType] = useState<NoteType>('text');
  const [items, setItems] = useState<LocalItem[]>([]);
  const [checkedItemsCollapsed, setCheckedItemsCollapsed] = useState(false);
  // Id of the item the user just checked off, so its completed-section row pops
  // on mount. Cleared shortly after so a later collapse/expand doesn't re-pop.
  const [popItemId, setPopItemId] = useState<string | null>(null);
  const popClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (popClearRef.current) clearTimeout(popClearRef.current); }, []);
  const [pinned, setPinned] = useState(false);
  const [archived, setArchived] = useState(false);
  const [color, setColor] = useState('#ffffff');
  const [labels, setLabels] = useState<Label[]>([]);
  const [hasCreated, setHasCreated] = useState(initialNoteId !== null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [colorPickerVisible, setColorPickerVisible] = useState(false);
  const [labelPickerVisible, setLabelPickerVisible] = useState(false);
  const [assigneePickerVisible, setAssigneePickerVisible] = useState(false);
  const [assigningItemId, setAssigningItemId] = useState<string | null>(null);
  const [syncToast, setSyncToast] = useState<string | null>(null);
  const [isEditingContent, setIsEditingContent] = useState(initialNoteId === null);
  // Share-target picker: lets a share be redirected to another server before it
  // is saved (only relevant when opened from a share and 2+ servers exist).
  const [shareServers, setShareServers] = useState<ServerAccountEntry[]>([]);
  const [activeShareServerId, setActiveShareServerId] = useState<string | null>(null);
  const [shareServerPickerVisible, setShareServerPickerVisible] = useState(false);
  // Tracks the pending share so a redirect that the navigation layer drops
  // (e.g. the server switch failed) can be rolled back while still mounted.
  const pendingShare = usePendingShare();
  const redirectInitiatedRef = useRef(false);
  const { user: currentUser, isLocalMode } = useAuth();
  const { usersById } = useUsers();
  const { showToast } = useToast();

  const { colors } = useTheme();
  const insets = useContext(SafeAreaInsetsContext) ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const keyboardHeight = useKeyboardHeight();
  // Live horizontal travel of the row currently being dragged. The list pan's
  // onChange writes translationX here; the active row snaps it to an indent step
  // for Keep-style drag-to-indent, and the drop handler reads it to commit.
  const dragTranslateX = useSharedValue(0);
  // On Android the window is edge-to-edge and is NOT resized for the keyboard,
  // so lift the whole editor (scroll area + toolbars) above it manually. iOS
  // relies on KeyboardAvoidingView's "padding" behavior instead.
  //
  // Android reports the keyboard height excluding the bottom navigation inset:
  // the keyboard draws over that inset, so endCoordinates.height is measured from
  // the top of the navigation bar, not the bottom edge of the screen. Reserve the
  // full keyboardHeight here; the toolbar's own safe-area bottom padding
  // (insets.bottom) then bridges the navigation-inset region so its buttons sit
  // flush against the top of the keyboard instead of behind it.
  const androidKeyboardInset = Platform.OS === 'android' ? keyboardHeight : 0;
  const bannerShown = useBannerShown();
  const { data: existingNote } = useOfflineNote(noteId);
  const createMutation = useCreateNote();
  const updateMutation = useUpdateNote();
  const deleteMutation = useDeleteNote();
  const restoreMutation = useRestoreNote();
  const duplicateMutation = useDuplicateNote();
  const createItemMutation = useCreateNoteItem();
  const updateItemMutation = useUpdateNoteItem();
  const deleteItemMutation = useDeleteNoteItem();
  const reorderItemsMutation = useReorderNoteItems();
  const toggleItemCompletedMutation = useToggleNoteItemCompleted();
  const uploadImageMutation = useUploadNoteImage();
  const deleteImageMutation = useDeleteNoteImage();
  const retryPendingImageUploadMutation = useRetryPendingImageUpload();
  const dismissPendingImageUploadMutation = useDismissPendingImageUpload();
  // Uploads queued while offline (or after a transient failure) — persisted to
  // pending_image_uploads, so they survive navigating away or an app restart
  // until the sync engine's drain flushes them (issue #618).
  const pendingImageUploads = usePendingImageUploads(noteId);

  // Add-image UX state: the action sheet, in-flight/failed uploads rendered as
  // gallery placeholders, and images hidden pending the deferred-delete undo
  // window (spec §3.1/§6). `imageUploads` only ever holds attempts currently
  // in flight online or that failed permanently — anything falling back to the
  // offline queue is handed off to `pendingImageUploads` above instead.
  const [addImageSheetVisible, setAddImageSheetVisible] = useState(false);
  const [imageUploads, setImageUploads] = useState<PendingImageUpload[]>([]);
  const displayedImageUploads = useMemo(
    () => [...imageUploads, ...pendingImageUploads],
    [imageUploads, pendingImageUploads],
  );
  const [removedImageIds, setRemovedImageIds] = useState<Set<string>>(new Set());

  // Show a toast when another user updates this note while editor is open
  useSSESubscription(noteId, useCallback(() => {
    setSyncToast((prev) => prev ?? t('note.updatedByAnotherUser'));
  }, [t]));

  // Auto-dismiss sync toast after 4 seconds
  useEffect(() => {
    if (!syncToast) return;
    const timer = setTimeout(() => setSyncToast(null), 4000);
    return () => clearTimeout(timer);
  }, [syncToast]);

  useEffect(() => {
    setSaveError(null);
    setSyncToast(null);
  }, [i18n.language]);

  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidHide', () => {
      setIsEditingContent(false);
    });
    return () => sub.remove();
  }, []);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const isInitializedRef = useRef(false);
  const intentionalExitRef = useRef(false);
  const hasPendingChangesRef = useRef(false);
  // Bumped on every edit (markDirtyAndScheduleUpdate). flushSave snapshots it
  // alongside the state refs so it can tell whether new edits arrived while its
  // network calls were in flight — clearing the dirty flag then would mark
  // those edits clean without ever saving them.
  const editSeqRef = useRef(0);
  const saveInFlightRef = useRef<Promise<boolean> | null>(null);
  const requiresHydrationRef = useRef(initialNoteId !== null);

  // Refs for current state to avoid stale closures in debounced save
  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;
  const noteTypeRef = useRef(noteType);
  noteTypeRef.current = noteType;
  const titleRef = useRef(title);
  titleRef.current = title;
  const contentRef = useRef(content);
  contentRef.current = content;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const checkedItemsCollapsedRef = useRef(checkedItemsCollapsed);
  checkedItemsCollapsedRef.current = checkedItemsCollapsed;
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  const archivedRef = useRef(archived);
  archivedRef.current = archived;
  const colorRef = useRef(color);
  colorRef.current = color;
  const createMutateRef = useRef(createMutation.mutateAsync);
  createMutateRef.current = createMutation.mutateAsync;
  const updateMutateRef = useRef(updateMutation.mutateAsync);
  updateMutateRef.current = updateMutation.mutateAsync;
  const createItemRef = useRef(createItemMutation.mutateAsync);
  createItemRef.current = createItemMutation.mutateAsync;
  const updateItemRef = useRef(updateItemMutation.mutateAsync);
  updateItemRef.current = updateItemMutation.mutateAsync;
  const deleteItemRef = useRef(deleteItemMutation.mutateAsync);
  deleteItemRef.current = deleteItemMutation.mutateAsync;
  const reorderItemsRef = useRef(reorderItemsMutation.mutateAsync);
  reorderItemsRef.current = reorderItemsMutation.mutateAsync;
  const toggleItemCompletedRef = useRef(toggleItemCompletedMutation.mutateAsync);
  toggleItemCompletedRef.current = toggleItemCompletedMutation.mutateAsync;

  const displayedImageUploadsRef = useRef(displayedImageUploads);
  displayedImageUploadsRef.current = displayedImageUploads;
  const pendingImageUploadsRef = useRef(pendingImageUploads);
  pendingImageUploadsRef.current = pendingImageUploads;
  const imageUploadFilesRef = useRef(new Map<string, ImageUploadFile>());
  const activeImageUploadIdsRef = useRef(new Set<string>());

  const displayedImages = useMemo(
    () => (existingNote?.images ?? []).filter((img) => !removedImageIds.has(img.id)),
    [existingNote?.images, removedImageIds],
  );

  const validateImageFile = useCallback((file: ImageUploadFile): string | null => {
    const error = validateImageFileRaw(file);
    if (error === 'wrongType') return t('images.errorWrongType');
    if (error === 'tooLarge') return t('images.errorTooLarge', { maxMB: IMAGE_MAX_MB });
    return null;
  }, [t]);

  const removeUploadTile = useCallback((uploadId: string) => {
    setImageUploads((prev) => prev.filter((u) => u.id !== uploadId));
    imageUploadFilesRef.current.delete(uploadId);
    // Only hits the DB when this tile had actually fallen back to the
    // persisted offline queue (#618) — the common ephemeral uploading/error
    // tile was never persisted, so there's nothing to cancel.
    if (pendingImageUploadsRef.current.some((u) => u.id === uploadId)) {
      dismissPendingImageUploadMutation.mutate(uploadId);
    }
  }, [dismissPendingImageUploadMutation]);

  const runImageUpload = useCallback((uploadId: string, file: ImageUploadFile) => {
    const currentNoteId = noteIdRef.current;
    if (!currentNoteId) {
      // The note id can null out mid-flight (e.g. the share-target redirect
      // resets it) between queuing the placeholder tile and getting here —
      // surface it as a failed upload instead of leaving the tile spinning
      // forever with no retry/dismiss affordance.
      setImageUploads((prev) => prev.map((u) => (u.id === uploadId ? { ...u, status: 'error', errorMessage: t('images.uploadFailed') } : u)));
      return;
    }
    // Guard against a duplicate concurrent request for the same upload (a
    // rapid double-tap on Retry before React re-renders the tile out of its
    // pressable state).
    if (activeImageUploadIdsRef.current.has(uploadId)) return;
    activeImageUploadIdsRef.current.add(uploadId);
    uploadImageMutation.mutateAsync({
      noteId: currentNoteId,
      uploadId,
      file,
      onProgress: (percent) => {
        setImageUploads((prev) => prev.map((u) => (u.id === uploadId ? { ...u, progress: percent } : u)));
      },
    }).then((result) => {
      activeImageUploadIdsRef.current.delete(uploadId);
      // Either it uploaded, or it fell back to the persisted offline queue
      // (issue #618) — either way the ephemeral tile is done; a queued upload
      // is now rendered from `pendingImageUploads` instead, under the same id.
      setImageUploads((prev) => prev.filter((u) => u.id !== uploadId));
      imageUploadFilesRef.current.delete(uploadId);
      if (result.status === 'queued') showToast(t('images.uploadQueuedToast'), 'info');
    }).catch((error) => {
      activeImageUploadIdsRef.current.delete(uploadId);
      console.error('Failed to upload note image:', error);
      const status = (error as { response?: { status?: number } })?.response?.status;
      const message = status === 413 ? t('images.errorTooLarge', { maxMB: IMAGE_MAX_MB }) : t('images.uploadFailed');
      setImageUploads((prev) => prev.map((u) => (u.id === uploadId ? { ...u, status: 'error', errorMessage: message } : u)));
    });
  }, [showToast, t, uploadImageMutation]);

  const startImageUpload = useCallback((file: ImageUploadFile) => {
    const id = generateId();
    imageUploadFilesRef.current.set(id, file);
    setImageUploads((prev) => [...prev, { id, filename: file.name, previewUri: file.uri, progress: 0, status: 'uploading' }]);
    runImageUpload(id, file);
  }, [runImageUpload]);

  const retryImageUpload = useCallback((uploadId: string) => {
    const file = imageUploadFilesRef.current.get(uploadId);
    if (file) {
      setImageUploads((prev) => prev.map((u) => (u.id === uploadId ? { ...u, status: 'uploading', progress: 0, errorMessage: undefined } : u)));
      runImageUpload(uploadId, file);
      return;
    }
    // Not an in-flight ephemeral upload — a persisted offline upload that hit
    // a permanent error; re-queue it so the next drain retries it (#618).
    retryPendingImageUploadMutation.mutate(uploadId);
  }, [retryPendingImageUploadMutation, runImageUpload]);

  // Entry point for the add-image action sheet. Validates each file and
  // enforces the per-note image cap client-side (the server enforces it
  // authoritatively) before starting an upload per valid file.
  const queueImageFiles = useCallback((files: ImageUploadFile[]) => {
    if (files.length === 0) return;

    const noteImages = existingNote?.images ?? [];
    let remainingSlots = IMAGE_MAX_PER_NOTE
      - noteImages.length
      - displayedImageUploadsRef.current.filter((u) => u.status !== 'error').length;

    // Collect distinct error messages across the whole batch instead of
    // showing (and immediately overwriting) one per invalid file.
    const errors = new Set<string>();
    for (const file of files) {
      const validationError = validateImageFile(file);
      if (validationError) {
        errors.add(validationError);
        continue;
      }
      if (remainingSlots <= 0) {
        errors.add(t('images.errorTooMany', { max: IMAGE_MAX_PER_NOTE }));
        break;
      }
      remainingSlots -= 1;
      startImageUpload(file);
    }
    if (errors.size > 0) showToast(Array.from(errors).join(' '), 'error');
  }, [existingNote?.images, showToast, startImageUpload, t, validateImageFile]);

  const handleImagePermissionDenied = useCallback((source: 'camera' | 'library') => {
    showToast(source === 'camera' ? t('images.cameraPermissionDenied') : t('images.libraryPermissionDenied'), 'error');
  }, [showToast, t]);

  // Removal is client-deferred: the tile hides immediately and an undo toast
  // appears; the DELETE only fires once the toast's own timer expires with no
  // undo (no restore endpoint exists for images, unlike notes/archive above).
  // Driven entirely by the toast's onExpire — not a second independent timer —
  // so the delete can never race ahead of (or lag) the visible Undo button.
  const removeNoteImage = useCallback((image: NoteImage) => {
    const currentNoteId = noteIdRef.current;
    if (!currentNoteId) return;
    setRemovedImageIds((prev) => new Set(prev).add(image.id));

    const clearRemovalState = () => {
      setRemovedImageIds((prev) => {
        const next = new Set(prev);
        next.delete(image.id);
        return next;
      });
    };

    showToast(t('images.removedToast'), 'info', {
      label: t('dashboard.undo'),
      onPress: clearRemovalState,
      onExpire: () => {
        deleteImageMutation.mutateAsync({ noteId: currentNoteId, imageId: image.id })
          .catch((error) => {
            console.error('Failed to delete note image:', error);
          })
          .finally(clearRemovalState);
      },
    });
  }, [deleteImageMutation, showToast, t]);

  // Baseline of the last-saved state, used to diff local edits into granular
  // per-item operations (and field-only scalar patches) instead of re-sending
  // the whole note — so a save here can't overwrite another device's edits.
  const savedItemsRef = useRef<Map<string, ItemSnapshot>>(new Map());
  const savedOrderRef = useRef<string[]>([]);
  const savedScalarsRef = useRef({ title: '', content: '', pinned: false, archived: false, color: '#ffffff', checked_items_collapsed: false });
  const isHydratingRef = useRef(initialNoteId !== null && !existingNote);
  isHydratingRef.current = initialNoteId !== null && !existingNote;

  const titleInputRef = useRef<TextInputType>(null);
  const contentInputRef = useRef<TextInputType>(null);
  const scrollViewRef = useRef<ScrollView>(null);
  const itemInputRefsMap = useRef(new Map<string, React.RefObject<TextInputType | null>>());
  const autoFocusItemIdRef = useRef<string | null>(null);
  const autoFocusClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getItemRef = useCallback((id: string): React.RefObject<TextInputType | null> => {
    if (!itemInputRefsMap.current.has(id)) {
      itemInputRefsMap.current.set(id, React.createRef<TextInputType>());
    }
    return itemInputRefsMap.current.get(id)!;
  }, []);

  // New list items get a server-format ID up front so they keep a stable
  // identity across granular per-item updates and offline replay.
  function nextTempId(): string {
    return generateId();
  }

  // Load existing note data
  useEffect(() => {
    if (existingNote && !isInitializedRef.current) {
      setNoteType(existingNote.note_type);
      setPinned(existingNote.pinned);
      setArchived(existingNote.archived);
      setColor(existingNote.color);
      setLabels(existingNote.labels ?? []);
      let initialItems: LocalItem[] = [];
      if (existingNote.note_type === 'list') {
        setTitle(existingNote.title);
        setCheckedItemsCollapsed(existingNote.checked_items_collapsed);
        if (existingNote.items) {
          initialItems = toLocalItems(existingNote.items);
          setItems(initialItems);
        }
      } else {
        setContent(existingNote.content);
      }
      // Seed the save baseline from the hydrated note so the first edit diffs
      // against the server state rather than re-sending everything.
      savedScalarsRef.current = {
        title: existingNote.note_type === 'list' ? existingNote.title : '',
        content: existingNote.note_type === 'text' ? existingNote.content : '',
        pinned: existingNote.pinned,
        archived: existingNote.archived,
        color: existingNote.color,
        checked_items_collapsed: existingNote.note_type === 'list' ? existingNote.checked_items_collapsed : false,
      };
      savedItemsRef.current = new Map(initialItems.map((it) => [it.id, itemSnapshot(it)]));
      savedOrderRef.current = initialItems.map((it) => it.id);
      isInitializedRef.current = true;
      requiresHydrationRef.current = false;
    }
  }, [existingNote]);

  // Keep labels in sync when note data refreshes after label mutations
  useEffect(() => {
    if (existingNote && isInitializedRef.current) {
      setLabels(existingNote.labels ?? []);
    }
  }, [existingNote?.labels]); // eslint-disable-line react-hooks/exhaustive-deps

  // When the queue drains, OfflineContext sets the React Query cache for the old local
  // ID to hold the server note. Detect this by checking whether the cached note's id
  // now differs from the local ID we hold, and update noteId + route params accordingly.
  useEffect(() => {
    if (existingNote && noteId && existingNote.id !== noteId) {
      setNoteId(existingNote.id);
      navigation.setParams({ noteId: existingNote.id });
    }
  }, [existingNote?.id, noteId, navigation]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persists list-item changes as granular create/patch/delete/reorder ops by
  // diffing the current items against the saved baseline.
  const persistItemDiff = useCallback(async (currentNoteId: string, currentItems: LocalItem[]) => {
    const base = savedItemsRef.current;
    const curIds = new Set(currentItems.map((it) => it.id));

    // Advance the baseline incrementally after each successful op so a later
    // failure does not re-send already-applied ops on the next retry (which
    // would re-create items and get stuck on 409 Conflict).
    for (const it of currentItems) {
      const snap = base.get(it.id);
      if (!snap) {
        try {
          await createItemRef.current({
            noteId: currentNoteId,
            item: {
              id: it.id,
              text: it.text,
              position: it.position,
              completed: it.completed,
              parent_id: it.parentId,
              assigned_to: it.assigned_to || undefined,
            },
          });
        } catch (err) {
          // 409 means a prior attempt already created this item; treat as done.
          const status = (err as { response?: { status?: number } })?.response?.status;
          if (status !== 409) throw err;
        }
        base.set(it.id, itemSnapshot(it));
        continue;
      }
      const data: PatchNoteItemRequest = {};
      if (it.text !== snap.text) data.text = it.text;
      if (it.completed !== snap.completed) data.completed = it.completed;
      if (it.parentId !== snap.parentId) data.parent_id = it.parentId ?? '';
      if (it.assigned_to !== snap.assigned_to) data.assigned_to = it.assigned_to;
      if (Object.keys(data).length > 0) {
        await updateItemRef.current({ noteId: currentNoteId, itemId: it.id, data });
        base.set(it.id, itemSnapshot(it));
      }
    }

    for (const id of [...base.keys()]) {
      if (!curIds.has(id)) {
        await deleteItemRef.current({ noteId: currentNoteId, itemId: id });
        base.delete(id);
      }
    }

    const curOrder = currentItems.map((it) => it.id);
    const orderChanged = curOrder.length !== savedOrderRef.current.length
      || curOrder.some((id, i) => savedOrderRef.current[i] !== id);
    if (orderChanged && curOrder.length > 0) {
      await reorderItemsRef.current({ noteId: currentNoteId, itemIds: curOrder });
    }
    savedOrderRef.current = curOrder;
  }, []);

  const flushSave = useCallback(async (unmounting = false): Promise<boolean> => {
    if (!hasPendingChangesRef.current) return true;
    // If an existing note has local edits flagged but hasn't hydrated yet,
    // treat this as a failed flush so callers can retry after hydration.
    if (requiresHydrationRef.current && noteIdRef.current && !isInitializedRef.current) return false;

    // Serialize mutations: chain onto any in-flight save to prevent concurrent writes
    const predecessor = saveInFlightRef.current;
    const thisPromise = (async () => {
      if (predecessor) {
        try { await predecessor; } catch { /* handled by prior caller */ }
      }

      const currentNoteId = noteIdRef.current;
      const currentTitle = titleRef.current;
      const currentContent = contentRef.current;
      const currentItems = itemsRef.current;
      const currentCollapsed = checkedItemsCollapsedRef.current;
      const currentNoteType = noteTypeRef.current;
      const currentColor = colorRef.current;
      const currentPinned = pinnedRef.current;
      const currentArchived = archivedRef.current;
      const capturedEditSeq = editSeqRef.current;

      // Clear the dirty flag only if no edit arrived while the awaited network
      // calls below were in flight. A mid-save keystroke re-marks dirty and
      // schedules its own debounced save; unconditionally clearing here would
      // wipe that flag, the debounced flushSave would early-return on "no
      // pending changes", and the mid-save edit would be silently lost on exit.
      const clearPendingUnlessEditedMidSave = () => {
        if (editSeqRef.current === capturedEditSeq) {
          hasPendingChangesRef.current = false;
        }
      };

      const captureBaseline = () => {
        savedScalarsRef.current = {
          title: currentTitle,
          content: currentContent,
          pinned: currentPinned,
          archived: currentArchived,
          color: currentColor,
          checked_items_collapsed: currentCollapsed,
        };
        savedItemsRef.current = new Map(currentItems.map((it) => [it.id, itemSnapshot(it)]));
        savedOrderRef.current = currentItems.map((it) => it.id);
      };

      if (!currentNoteId) {
        const isEmpty = currentNoteType === 'list'
          ? !currentTitle && currentItems.length === 0
          : !currentContent;
        if (isEmpty) {
          hasPendingChangesRef.current = false;
          return true;
        }
        const req: CreateNoteRequest = currentNoteType === 'list'
          ? {
              note_type: 'list',
              title: currentTitle,
              color: !isWhiteHexColor(currentColor) ? currentColor : undefined,
              items: serializeItems(currentItems),
            }
          : {
              note_type: 'text',
              content: currentContent,
              color: !isWhiteHexColor(currentColor) ? currentColor : undefined,
            };
        const newNote = await createMutateRef.current(req);
        clearPendingUnlessEditedMidSave();
        // The server honors the client-supplied item IDs, so the items we just
        // sent become the baseline for subsequent granular edits.
        captureBaseline();
        if (!isMountedRef.current || unmounting) return true;
        noteIdRef.current = newNote.id;
        setNoteId(newNote.id);
        setHasCreated(true);
        setSaveError(null);
      } else {
        // Patch only the scalar fields that changed, so a list-item edit never
        // re-sends the title and vice versa, and another device's concurrent
        // changes to untouched fields are preserved.
        const base = savedScalarsRef.current;
        const scalarData: UpdateNoteRequest = {};
        if (currentNoteType === 'list') {
          if (currentTitle !== base.title) (scalarData as UpdateListNoteRequest).title = currentTitle;
          if (currentCollapsed !== base.checked_items_collapsed) (scalarData as UpdateListNoteRequest).checked_items_collapsed = currentCollapsed;
        } else if (currentContent !== base.content) {
          (scalarData as UpdateTextNoteRequest).content = currentContent;
        }
        if (currentPinned !== base.pinned) scalarData.pinned = currentPinned;
        if (currentArchived !== base.archived) scalarData.archived = currentArchived;
        if (currentColor !== base.color) scalarData.color = currentColor;

        if (Object.keys(scalarData).length > 0) {
          await updateMutateRef.current({ id: currentNoteId, data: scalarData });
        }

        // Items are persisted as granular per-item operations.
        if (currentNoteType === 'list') {
          await persistItemDiff(currentNoteId, currentItems);
        }

        clearPendingUnlessEditedMidSave();
        captureBaseline();
        if (!isMountedRef.current || unmounting) return true;
        setSaveError(null);
      }

      return true;
    })();

    saveInFlightRef.current = thisPromise;
    try {
      await thisPromise;
      return true;
    } catch (err) {
      console.error('Failed to save note:', err);
      if (isMountedRef.current && !unmounting) {
        setSaveError(t('note.failedSaveChanges'));
      }
      return false;
    } finally {
      if (saveInFlightRef.current === thisPromise) {
        saveInFlightRef.current = null;
      }
    }
  }, [t, persistItemDiff]);

  const scheduleUpdate = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      flushSave();
    }, VALIDATION.AUTO_SAVE_TIMEOUT_MS);
  }, [flushSave]);

  const markDirtyAndScheduleUpdate = useCallback(() => {
    editSeqRef.current += 1;
    hasPendingChangesRef.current = true;
    scheduleUpdate();
  }, [scheduleUpdate]);

  // Pre-filled share content must be flagged dirty so it auto-saves (and is not
  // lost on unmount). Runs once on mount.
  const sharedInitRef = useRef(false);
  useEffect(() => {
    if (sharedInitRef.current || !openedFromShare || !sharedText) {
      return;
    }
    sharedInitRef.current = true;
    markDirtyAndScheduleUpdate();
  }, [openedFromShare, sharedText, markDirtyAndScheduleUpdate]);

  // Load the server list so the share-target picker can offer to redirect the
  // new note to another configured server.
  useEffect(() => {
    if (!openedFromShare) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const [servers, active] = await Promise.all([listServers(), getActiveServer()]);
      if (cancelled) {
        return;
      }
      setShareServers(servers);
      setActiveShareServerId(active?.serverId ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [openedFromShare]);

  // Redirect the shared note to a different server: stash the text targeted at
  // that server and let the navigation layer switch servers and re-open the
  // editor there. We skip the unmount flush so nothing new is written to the
  // current server on the way out. Because the note auto-saves ~1s after the
  // editor opens, a draft may already have been created on the current server
  // by the time the user picks a different one — so we remove it first to avoid
  // leaving an orphan behind.
  const handleRedirectShare = useCallback(async (serverId: string) => {
    setShareServerPickerVisible(false);
    if (serverId === activeShareServerId) {
      return;
    }
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    intentionalExitRef.current = true;
    // Wait for any in-flight create so we know whether a note already landed on
    // the current server.
    if (saveInFlightRef.current) {
      try { await saveInFlightRef.current; } catch { /* failure surfaced elsewhere */ }
    }
    const createdNoteId = noteIdRef.current;
    if (createdNoteId) {
      try {
        await deleteMutation.mutateAsync(createdNoteId);
      } catch { /* best effort: leave it on the original server if delete fails */ }
    }
    redirectInitiatedRef.current = true;
    setPendingShare({ text: contentRef.current, targetServerId: serverId });
  }, [activeShareServerId, deleteMutation]);

  // If the navigation layer drops a redirect we started (the server switch
  // failed, so no remount unmounts this editor), recover instead of leaving a
  // deleted draft behind a no-save editor: treat the content as a fresh unsaved
  // note again and re-arm the auto-save on the current server.
  useEffect(() => {
    if (!redirectInitiatedRef.current || pendingShare !== null) {
      return;
    }
    redirectInitiatedRef.current = false;
    intentionalExitRef.current = false;
    noteIdRef.current = null;
    setNoteId(null);
    setHasCreated(false);
    markDirtyAndScheduleUpdate();
  }, [pendingShare, markDirtyAndScheduleUpdate]);

  const activeShareServerName = useMemo(() => {
    const active = shareServers.find((server) => server.serverId === activeShareServerId);
    return active?.displayName || active?.serverUrl || '';
  }, [shareServers, activeShareServerId]);

  const flushPendingChanges = useCallback(async (): Promise<boolean> => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    return flushSave();
  }, [flushSave]);

  // Keep input refs bounded to currently rendered items.
  useEffect(() => {
    const activeItemIds = new Set(items.map((item) => item.id));
    for (const id of itemInputRefsMap.current.keys()) {
      if (!activeItemIds.has(id)) {
        itemInputRefsMap.current.delete(id);
      }
    }
  }, [items]);

  // Intercept navigation away to flush pending edits before leaving the screen.
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (event) => {
      if (intentionalExitRef.current || !hasPendingChangesRef.current) {
        return;
      }
      event.preventDefault();
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }

      const showSaveFailedAlert = (retriesLeft = MAX_EXIT_SAVE_RETRIES) => {
        Alert.alert(
          t('note.saveFailedExitTitle'),
          t('note.saveFailedExitMessage'),
          [
            {
              text: t('note.discardAndLeave'),
              style: 'destructive',
              onPress: () => {
                intentionalExitRef.current = true;
                navigation.dispatch(event.data.action);
              },
            },
            ...(retriesLeft > 0
              ? [
                  {
                    text: t('common.retry'),
                    onPress: async () => {
                      const retrySucceeded = await flushSave();
                      if (retrySucceeded) {
                        intentionalExitRef.current = true;
                        navigation.dispatch(event.data.action);
                      } else {
                        showSaveFailedAlert(retriesLeft - 1);
                      }
                    },
                  },
                ]
              : []),
          ],
        );
      };

      void (async () => {
        const saveSucceeded = await flushSave();
        if (!saveSucceeded) {
          showSaveFailedAlert();
          return;
        }
        intentionalExitRef.current = true;
        navigation.dispatch(event.data.action);
      })();
    });
    return unsubscribe;
  }, [flushSave, navigation, t]);

  // Flush pending save on unmount (prevent data loss), skip if intentionally exiting
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (!intentionalExitRef.current && hasPendingChangesRef.current) {
        flushSave(true);
      }
    };
  }, [flushSave]);

  const handleTitleChange = useCallback(
    (newTitle: string) => {
      if (newTitle.length > VALIDATION.TITLE_MAX_LENGTH) return;
      setTitle(newTitle);
      markDirtyAndScheduleUpdate();
    },
    [markDirtyAndScheduleUpdate],
  );

  const handleContentChange = useCallback(
    (newContent: string) => {
      if (newContent.length > VALIDATION.CONTENT_MAX_LENGTH) return;
      setContent(newContent);
      markDirtyAndScheduleUpdate();
    },
    [markDirtyAndScheduleUpdate],
  );

  const handleItemCompletedToggle = useCallback(
    async (itemId: string, completed: boolean) => {
      // itemsRef.current is the authoritative latest state here: each branch
      // below writes the new array back to it synchronously, so a rapid
      // follow-up toggle (fired before React re-renders) composes on the most
      // recent optimistic state rather than a stale render snapshot. Without
      // this, rows flicker back into the active list and an overlapping
      // parent/child toggle captures a stale prior snapshot, corrupting its
      // rollback and save baseline (issue: mobile item flicker).
      const before = itemsRef.current;
      const target = before.find((item) => item.id === itemId);
      if (!target || target.completed === completed) return;

      // Capture the prior completed state of just the items this toggle touches
      // (the item plus, for a top-level item, its children — or, for a child
      // being unchecked, its parent) from that latest state. Used to advance
      // the save baseline and to revert precisely on failure — without
      // clobbering any other item whose state may change before this async
      // call settles.
      const cascadeToChildren = target.parentId === null;
      const uncompleteParent = target.parentId !== null && !completed;
      const priorCompletedById = new Map(
        before
          .filter(
            (item) =>
              item.id === itemId ||
              (cascadeToChildren && item.parentId === itemId) ||
              (uncompleteParent && item.id === target.parentId),
          )
          .map((item) => [item.id, item.completed]),
      );

      // Optimistic cascade applied immediately, with a subtle settle as the
      // item moves between the active list and the completed section.
      const optimisticItems = applyCompletedCascade(before, itemId, completed);
      itemsRef.current = optimisticItems;
      animateListReflow();
      // Flag the just-checked item so its completed-section row pops on mount,
      // then clear the flag so a later collapse/expand doesn't replay the pop.
      if (popClearRef.current) clearTimeout(popClearRef.current);
      if (completed) {
        setPopItemId(itemId);
        popClearRef.current = setTimeout(() => setPopItemId(null), 400);
      } else {
        setPopItemId(null);
      }
      setItems(optimisticItems);

      // For unsaved new notes, let the bulk-create carry completed flags
      if (!noteIdRef.current) {
        markDirtyAndScheduleUpdate();
        return;
      }

      // Cancel any pending debounced save to avoid a race with the toggle API call
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }

      try {
        const serverItems = await toggleItemCompletedRef.current({
          noteId: noteIdRef.current,
          itemId,
          completed,
        });
        if (serverItems.length > 0) {
          // Online: reconcile only completed flags from server response,
          // composing on (and writing back) the latest state so a concurrent
          // toggle's optimistic change is preserved.
          const completedById = new Map(serverItems.map((item) => [item.id, item.completed]));
          const reconciled = itemsRef.current.map((item) => {
            const serverCompleted = completedById.get(item.id);
            return serverCompleted === undefined ? item : { ...item, completed: serverCompleted };
          });
          itemsRef.current = reconciled;
          setItems(reconciled);
          // Advance the baseline so the diff engine does not re-patch completed
          for (const [id, comp] of completedById) {
            const snap = savedItemsRef.current.get(id);
            if (snap) savedItemsRef.current.set(id, { ...snap, completed: comp });
          }
        } else {
          // Offline: cascade was applied to local DB; advance baseline here too
          for (const [id, prior] of priorCompletedById) {
            if (prior === completed) continue;
            const snap = savedItemsRef.current.get(id);
            if (snap) savedItemsRef.current.set(id, { ...snap, completed });
          }
        }
      } catch {
        // Revert only the items this toggle changed, restoring their prior
        // completed values, so a concurrent toggle's optimistic state survives.
        const reverted = itemsRef.current.map((item) =>
          priorCompletedById.has(item.id)
            ? { ...item, completed: priorCompletedById.get(item.id)! }
            : item,
        );
        itemsRef.current = reverted;
        setItems(reverted);
        setSaveError(t('note.failedSaveChanges'));
      }
    },
    [markDirtyAndScheduleUpdate, t],
  );

  const handleItemTextChange = useCallback(
    (index: number, text: string) => {
      if (!text.includes('\n')) {
        // Clamp like the paste paths below: the server rejects longer item text
        // with a 400, which would wedge the save (or dead-letter it offline).
        const clamped = text.slice(0, VALIDATION.ITEM_TEXT_MAX_LENGTH);
        setItems((prev) => prev.map((item, i) => (i === index ? { ...item, text: clamped } : item)));
        markDirtyAndScheduleUpdate();
        return;
      }

      // Multi-line paste: split into separate items
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

      if (lines.length <= 1) {
        const singleText = (lines[0] ?? '').slice(0, VALIDATION.ITEM_TEXT_MAX_LENGTH);
        setItems((prev) => prev.map((item, i) => (i === index ? { ...item, text: singleText } : item)));
        markDirtyAndScheduleUpdate();
        return;
      }

      const isCompleted = itemsRef.current[index]?.completed ?? false;

      if (isCompleted) {
        setItems((prev) =>
          prev.map((item, i) =>
            i === index ? { ...item, text: lines.join(' ').slice(0, VALIDATION.ITEM_TEXT_MAX_LENGTH) } : item,
          ),
        );
        markDirtyAndScheduleUpdate();
        return;
      }

      const prepasteItems = [...itemsRef.current];
      const [firstLine, ...remainingLines] = lines;
      const newIds = remainingLines.map(() => nextTempId());

      setItems((prev) => {
        const sourceParentId = prev[index]?.parentId ?? null;
        const newItems: LocalItem[] = remainingLines.map((line, i) => ({
          id: newIds[i],
          text: line.slice(0, VALIDATION.ITEM_TEXT_MAX_LENGTH),
          completed: false,
          position: 0,
          parentId: sourceParentId,
          assigned_to: '',
        }));
        const updated = prev.map((item, i) =>
          i === index ? { ...item, text: firstLine.slice(0, VALIDATION.ITEM_TEXT_MAX_LENGTH) } : item,
        );
        updated.splice(index + 1, 0, ...newItems);
        return updated.map((item, i) => ({ ...item, position: i }));
      });
      markDirtyAndScheduleUpdate();

      showToast(t('note.itemsPasted', { count: remainingLines.length }), 'info', {
        label: t('dashboard.undo'),
        onPress: () => {
          setItems(prepasteItems);
          markDirtyAndScheduleUpdate();
        },
      });

      const lastId = newIds[newIds.length - 1];
      const lastItemRef = getItemRef(lastId);
      setTimeout(() => lastItemRef.current?.focus(), 50);
    },
    [markDirtyAndScheduleUpdate, getItemRef, showToast, t],
  );

  const handleDeleteItem = useCallback(
    (index: number) => {
      const removedItemId = itemsRef.current[index]?.id;
      if (removedItemId) {
        if (itemInputRefsMap.current.get(removedItemId)?.current?.isFocused()) {
          Keyboard.dismiss();
        }
        itemInputRefsMap.current.delete(removedItemId);
      }
      // Settle the surrounding rows as this one is removed instead of snapping.
      animateListReflow();
      setItems((prev) => prev.filter((_, i) => i !== index));
      markDirtyAndScheduleUpdate();
    },
    [markDirtyAndScheduleUpdate],
  );

  const handleAddItem = useCallback(() => {
    const newId = nextTempId();
    // Mark before setItems so the item mounts with autoFocus={true}, which
    // reliably opens the soft keyboard (programmatic focus() doesn't always
    // trigger the IME on Android for newly mounted inputs).
    autoFocusItemIdRef.current = newId;
    // Ease the new row in rather than having the list jump to make room.
    animateListReflow();
    setItems((prev) => [
      ...prev,
      { id: newId, text: '', completed: false, position: prev.length, parentId: null, assigned_to: '' },
    ]);
    markDirtyAndScheduleUpdate();
    // autoFocus is only consumed at mount; clear after a short delay so a
    // later unmount/remount of the same ID doesn't re-open the keyboard.
    // Cancel any pending clear from a previous rapid tap before rescheduling.
    if (autoFocusClearTimerRef.current !== null) clearTimeout(autoFocusClearTimerRef.current);
    autoFocusClearTimerRef.current = setTimeout(() => { autoFocusItemIdRef.current = null; }, 500);
  }, [markDirtyAndScheduleUpdate]);

  // handleItemEnterAtCursor mirrors the webapp's Enter-key handling:
  //  - cursor at the very start of a non-empty item -> insert a blank item
  //    before it (leaving its own text untouched), focus the new item;
  //  - cursor mid-text -> split the item into two at the cursor, focus the
  //    new (second) item with its cursor at the start;
  //  - cursor at the end (or item is empty) -> append a blank item after
  //    (previous default behavior).
  // Newly created items inherit the current item's group (parentId) and
  // assignee; completed always resets to false.
  const handleItemEnterAtCursor = useCallback((index: number, cursorPosition: number) => {
    const currentItem = itemsRef.current[index];
    if (!currentItem) return;

    const text = currentItem.text;
    const cursorPos = Math.max(0, Math.min(cursorPosition, text.length));

    if (cursorPos === 0 && text.length > 0) {
      const newId = nextTempId();
      const newItemRef = getItemRef(newId);
      setItems((prev) => {
        const newItem: LocalItem = {
          id: newId,
          text: '',
          completed: false,
          position: index,
          parentId: prev[index]?.parentId ?? null,
          assigned_to: prev[index]?.assigned_to ?? '',
        };
        const next = [...prev.slice(0, index), newItem, ...prev.slice(index)];
        return next.map((item, i) => ({ ...item, position: i }));
      });
      markDirtyAndScheduleUpdate();
      setTimeout(() => newItemRef.current?.focus(), 50);
      return;
    }

    if (cursorPos > 0 && cursorPos < text.length) {
      const before = text.slice(0, cursorPos);
      const after = text.slice(cursorPos);
      const newId = nextTempId();
      const newItemRef = getItemRef(newId);
      setItems((prev) => {
        const newItem: LocalItem = {
          id: newId,
          text: after,
          completed: false,
          position: index + 1,
          parentId: prev[index]?.parentId ?? null,
          assigned_to: prev[index]?.assigned_to ?? '',
        };
        const next = [
          ...prev.slice(0, index),
          { ...prev[index], text: before },
          newItem,
          ...prev.slice(index + 1),
        ];
        return next.map((item, i) => ({ ...item, position: i }));
      });
      markDirtyAndScheduleUpdate();
      setTimeout(() => {
        newItemRef.current?.focus();
        // Not all TextInput host implementations (e.g. test mocks) provide
        // this imperative method, so guard the call.
        newItemRef.current?.setSelection?.(0, 0);
      }, 50);
      return;
    }

    const newId = nextTempId();
    const newItemRef = getItemRef(newId);
    setItems((prev) => {
      const newItem: LocalItem = {
        id: newId,
        text: '',
        completed: false,
        position: index + 1,
        parentId: prev[index]?.parentId ?? null,
        assigned_to: '',
      };
      const next = [...prev.slice(0, index + 1), newItem, ...prev.slice(index + 1)];
      return next.map((item, i) => ({ ...item, position: i }));
    });
    markDirtyAndScheduleUpdate();
    setTimeout(() => newItemRef.current?.focus(), 50);
  }, [markDirtyAndScheduleUpdate, getItemRef]);

  const handleBackspaceOnEmpty = useCallback((index: number) => {
    const currentItems = itemsRef.current;
    const item = currentItems[index];
    if (!item || item.text !== '') {
      return;
    }
    const removedItemId = item.id;
    const focusTargetId = index > 0 ? (currentItems[index - 1]?.id ?? null) : null;
    setItems((prev) => prev.filter((_, i) => i !== index));
    itemInputRefsMap.current.delete(removedItemId);
    markDirtyAndScheduleUpdate();
    setTimeout(() => {
      if (focusTargetId) itemInputRefsMap.current.get(focusTargetId)?.current?.focus();
    }, 50);
  }, [markDirtyAndScheduleUpdate]);

  const handleAcceptSuggestion = useCallback(
    (itemId: string, suggestionText: string) => {
      // Capture the completed item ID from the ref snapshot so we can focus it after setItems
      const restoredId = itemsRef.current.find(
        (item) => item.completed && item.text.trim().toLowerCase() === suggestionText.toLowerCase(),
      )?.id;

      setItems((prev) => {
        const completedItem = prev.find(
          (item) => item.completed && item.text.trim().toLowerCase() === suggestionText.toLowerCase(),
        );

        if (!completedItem) {
          return prev.map((item) => (item.id === itemId ? { ...item, text: suggestionText } : item));
        }

        const currentUnchecked = prev.filter((item) => !item.completed);
        // itemId is always an unchecked item so findIndex should never return -1; Math.max guards against stale ref races
        const insertAt = Math.max(0, currentUnchecked.findIndex((item) => item.id === itemId));

        const filtered = prev.filter(
          (item) => item.id !== itemId && item.id !== completedItem.id,
        );

        const restoredItem: LocalItem = { ...completedItem, completed: false };
        const remainingUncompleted = filtered.filter((item) => !item.completed);
        const remainingCompleted = filtered.filter((item) => item.completed);

        const newUncompleted = [
          ...remainingUncompleted.slice(0, insertAt),
          restoredItem,
          ...remainingUncompleted.slice(insertAt),
        ].map((item, i) => ({ ...item, position: i }));

        return [
          ...newUncompleted,
          ...remainingCompleted.map((item, i) => ({ ...item, position: newUncompleted.length + i })),
        ];
      });

      markDirtyAndScheduleUpdate();

      if (restoredId) {
        setTimeout(() => {
          itemInputRefsMap.current.get(restoredId)?.current?.focus();
        }, 50);
      }
    },
    [markDirtyAndScheduleUpdate],
  );

  // Metadata actions (pin/archive/color) flush pending item edits first, then
  // PATCH only the field that changed. Sending just the changed scalar avoids
  // re-sending (and clobbering) items or other fields edited concurrently
  // elsewhere. The caller advances the saved baseline only after the PATCH
  // succeeds (see commitMetadataBaseline).
  const buildMetadataUpdateData = useCallback((overrides: Partial<UpdateNoteRequest>): UpdateNoteRequest => {
    return { ...overrides } as UpdateNoteRequest;
  }, []);

  const commitMetadataBaseline = useCallback((overrides: Partial<UpdateNoteRequest>) => {
    Object.assign(savedScalarsRef.current, overrides);
  }, []);

  const handleTitleSubmit = useCallback(() => {
    if (noteTypeRef.current === 'text') {
      contentInputRef.current?.focus();
    } else {
      const firstUnchecked = itemsRef.current.find((item) => !item.completed);
      if (firstUnchecked) {
        itemInputRefsMap.current.get(firstUnchecked.id)?.current?.focus();
      } else {
        const newId = nextTempId();
        const newItemRef = getItemRef(newId);
        setItems((prev) => [
          ...prev,
          { id: newId, text: '', completed: false, position: prev.length, parentId: null, assigned_to: '' },
        ]);
        markDirtyAndScheduleUpdate();
        setTimeout(() => newItemRef.current?.focus(), 50);
      }
    }
  }, [markDirtyAndScheduleUpdate, getItemRef]);

  const handleToggleCollapsed = useCallback(() => {
    animateListReflow();
    setCheckedItemsCollapsed((prev) => !prev);
    markDirtyAndScheduleUpdate();
  }, [markDirtyAndScheduleUpdate]);

  const collaborators = useMemo<Collaborator[]>(() => {
    if (!existingNote) return [];
    const hasShares = existingNote.shared_with && existingNote.shared_with.length > 0;
    if (!existingNote.is_shared && !hasShares) return [];
    return buildCollaborators(existingNote.user_id, existingNote.shared_with, usersById);
  }, [existingNote, usersById]);

  const isNoteShared = useMemo(() => {
    return (existingNote?.shared_with && existingNote.shared_with.length > 0) || existingNote?.is_shared;
  }, [existingNote?.shared_with, existingNote?.is_shared]);

  const handleAssignItem = useCallback(
    (itemId: string, userId: string) => {
      setItems((prev) =>
        prev.map((item) => (item.id === itemId ? { ...item, assigned_to: userId } : item)),
      );
      markDirtyAndScheduleUpdate();
    },
    [markDirtyAndScheduleUpdate],
  );

  const openAssigneePicker = useCallback((itemId: string) => {
    setAssigningItemId(itemId);
    setAssigneePickerVisible(true);
  }, []);

  const handleNativeShare = useCallback(() => {
    const text = formatEditorStateForShare(noteTypeRef.current, titleRef.current, contentRef.current, itemsRef.current);
    if (text.trim()) void Share.share({ message: text });
  }, []);

  const handleDelete = useCallback(() => {
    if (!noteId) {
      intentionalExitRef.current = true;
      navigation.goBack();
      return;
    }
    Alert.alert(t('note.deleteConfirmTitle'), t('note.deleteConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          try {
            if (debounceRef.current) {
              clearTimeout(debounceRef.current);
              debounceRef.current = null;
            }
            intentionalExitRef.current = true;
            if (saveInFlightRef.current) {
              try { await saveInFlightRef.current; } catch { /* already handled */ }
            }
            await deleteMutation.mutateAsync(noteId);
            showToast(t('dashboard.noteDeleted'), 'success', {
              label: t('dashboard.undo'),
              onPress: async () => {
                try {
                  await restoreMutation.mutateAsync(noteId);
                  showToast(t('dashboard.noteRestored'));
                } catch {
                  showToast(t('note.failedRestore'), 'error');
                }
              },
            });
            navigation.goBack();
          } catch {
            intentionalExitRef.current = false;
            Alert.alert(t('common.error'), t('note.failedDelete'));
          }
        },
      },
    ]);
  }, [deleteMutation, navigation, noteId, restoreMutation, showToast, t]);

  const handleTogglePin = useCallback(async () => {
    if (!noteId) return;
    const saveSucceeded = await flushPendingChanges();
    if (!saveSucceeded) {
      return;
    }
    const newPinned = !pinnedRef.current;
    setPinned(newPinned);
    try {
      await updateMutation.mutateAsync({
        id: noteId,
        data: buildMetadataUpdateData({ pinned: newPinned }),
      });
      commitMetadataBaseline({ pinned: newPinned });
    } catch {
      setPinned(!newPinned);
      Alert.alert(t('common.error'), t('note.failedUpdate'));
    }
  }, [buildMetadataUpdateData, commitMetadataBaseline, flushPendingChanges, noteId, t, updateMutation]);

  const handleToggleArchive = useCallback(async () => {
    if (!noteId) return;
    const saveSucceeded = await flushPendingChanges();
    if (!saveSucceeded) {
      return;
    }
    const newArchived = !archivedRef.current;
    setArchived(newArchived);
    try {
      await updateMutation.mutateAsync({
        id: noteId,
        data: buildMetadataUpdateData({ archived: newArchived }),
      });
      commitMetadataBaseline({ archived: newArchived });
      if (newArchived) {
        // Archiving from the single-note view returns the user to the dashboard.
        intentionalExitRef.current = true;
        navigation.goBack();
        showToast(t('dashboard.noteArchived'), 'success', {
          label: t('dashboard.undo'),
          onPress: async () => {
            try {
              await updateMutation.mutateAsync({
                id: noteId,
                data: buildMetadataUpdateData({ archived: false }),
              });
              commitMetadataBaseline({ archived: false });
              setArchived(false);
              showToast(t('dashboard.noteUnarchived'));
            } catch {
              showToast(t('note.failedUnarchive'), 'error');
            }
          },
        });
      } else {
        showToast(t('dashboard.noteUnarchived'));
      }
    } catch {
      setArchived(!newArchived);
      Alert.alert(t('common.error'), t('note.failedUpdate'));
    }
  }, [buildMetadataUpdateData, commitMetadataBaseline, flushPendingChanges, navigation, noteId, showToast, t, updateMutation]);

  const handleColorSelect = useCallback(async (selectedColor: string) => {
    const saveSucceeded = await flushPendingChanges();
    if (!saveSucceeded) {
      return;
    }
    const prevColor = colorRef.current;
    setColor(selectedColor);
    const currentNoteId = noteIdRef.current;
    if (!currentNoteId) {
      // Newly-created notes may not have committed noteId into render state yet.
      // Keep this change dirty so autosave (or beforeRemove flush) persists color.
      markDirtyAndScheduleUpdate();
      return;
    }
    if (isHydratingRef.current) {
      // Existing note data is still loading; avoid sending a metadata-only update
      // with placeholder refs that could overwrite hydrated title/content.
      markDirtyAndScheduleUpdate();
      return;
    }
    try {
      await updateMutation.mutateAsync({
        id: currentNoteId,
        data: buildMetadataUpdateData({ color: selectedColor }),
      });
      commitMetadataBaseline({ color: selectedColor });
    } catch {
      setColor(prevColor);
      Alert.alert(t('common.error'), t('note.failedColorUpdate'));
    }
  }, [buildMetadataUpdateData, commitMetadataBaseline, flushPendingChanges, markDirtyAndScheduleUpdate, t, updateMutation]);

  const handleToggleNoteType = useCallback(() => {
    if (hasCreated) return;
    setNoteType((prev) => (prev === 'text' ? 'list' : 'text'));
  }, [hasCreated]);

  const handleDuplicate = useCallback(async () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    const saveSucceeded = await flushSave();
    if (!saveSucceeded) {
      return;
    }

    const currentNoteId = noteIdRef.current;
    if (!currentNoteId) {
      return;
    }

    try {
      const duplicatedNote = await duplicateMutation.mutateAsync(currentNoteId);
      intentionalExitRef.current = true;
      Alert.alert(t('note.duplicate'), t('note.duplicated'));
      navigation.replace('NoteEditor', { noteId: duplicatedNote.id });
    } catch {
      Alert.alert(t('common.error'), t('note.failedDuplicate'));
    }
  }, [duplicateMutation, flushSave, navigation, t]);

  // Disable inputs while waiting for existing note to hydrate
  const isHydrating = initialNoteId !== null && !existingNote;

  // Build index lookup for items to avoid O(n) indexOf per item
  const itemIndexMap = useMemo(
    () => new Map(items.map((item, i) => [item.id, i])),
    [items],
  );
  const itemIndexMapRef = useRef(itemIndexMap);
  itemIndexMapRef.current = itemIndexMap;

  const uncheckedItems = useMemo(() => items.filter((item) => !item.completed), [items]);
  const checkedItems = useMemo(() => items.filter((item) => item.completed), [items]);

  const completedItemTexts = useMemo(() => {
    const seen = new Set<string>();
    const texts: string[] = [];
    for (const item of checkedItems) {
      const trimmed = item.text.trim();
      if (trimmed && !seen.has(trimmed.toLowerCase())) {
        seen.add(trimmed.toLowerCase());
        texts.push(trimmed);
      }
    }
    return texts;
  }, [checkedItems]);

  // Refs to avoid recreating handleListReorder on every items change
  const checkedItemsRef = useRef(checkedItems);
  checkedItemsRef.current = checkedItems;
  const uncheckedItemsRef = useRef(uncheckedItems);
  uncheckedItemsRef.current = uncheckedItems;

  // Commits a finished drag: applies the vertical move (if any) and the indent
  // implied by the horizontal drag distance, then persists. Called from both
  // onReorder (fires only when the row changed slots) and onDragEnd (fires on
  // every drop, which is how a purely sideways indent gets committed at all).
  const commitDrag = useCallback(
    (from: number, to: number) => {
      // Apply the move to the unchecked list (a no-op when from === to, e.g. a
      // purely sideways drag that only changed the indent).
      const reorderedUnchecked = reorderItems(uncheckedItemsRef.current, from, to);
      const moved = reorderedUnchecked[to];
      let changed = from !== to;
      if (moved) {
        const above = to > 0 ? reorderedUnchecked[to - 1] : null;
        const baseLevel = moved.parentId ? 1 : 0;
        const canIndent = !itemHasChildren(itemsRef.current, moved.id) && !!above;
        const canOutdent = baseLevel === 1;
        const targetLevel = indentLevelFromDrag(dragTranslateX.value, baseLevel, canIndent, canOutdent);
        let newParentId: string | null;
        if (targetLevel !== baseLevel) {
          // The horizontal drag past a step is an explicit indent intent.
          newParentId = targetLevel === 1 && above ? above.parentId ?? above.id : null;
        } else if (from !== to) {
          // No sideways intent but the row moved: fall back to the position-based
          // reparent so dropping into a group still nests as before.
          newParentId = droppedParentId(itemsRef.current, moved, above);
        } else {
          // Released in place with no sideways intent: leave the parent untouched.
          newParentId = moved.parentId;
        }
        if (newParentId !== moved.parentId) {
          reorderedUnchecked[to] = { ...moved, parentId: newParentId };
          changed = true;
        }
      }
      // Note: dragTranslateX is intentionally not reset here. Each active row now
      // holds its dropped indent in its own `displayLevel` until the committed
      // re-render lands; zeroing the shared value mid-drop could clobber that hold
      // and reintroduce the snap-back flash. The drag start resets it instead.
      if (!changed) return;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      // Merge with existing checked items and normalize so each parent's
      // children stay contiguous.
      setItems(normalizeItemOrder([...reorderedUnchecked, ...checkedItemsRef.current]));
      markDirtyAndScheduleUpdate();
    },
    [markDirtyAndScheduleUpdate, dragTranslateX],
  );

  const handleListReorder = useCallback(
    ({ from, to }: ReorderableListReorderEvent) => commitDrag(from, to),
    [commitDrag],
  );

  // onReorder never fires for a purely sideways drag (the library only calls it
  // when from !== to). onDragEnd fires on every drop — inside a UI-thread
  // worklet — so we hop back to JS to commit the indent for that case. The
  // from !== to drops are already handled by onReorder above.
  const handleListDragEnd = useCallback(
    ({ from, to }: ReorderableListDragEndEvent) => {
      'worklet';
      if (from === to) {
        runOnJS(commitDrag)(from, to);
      }
    },
    [commitDrag],
  );

  // The reorder drag activates on movement along either axis: vertical to
  // reorder, horizontal to indent/outdent (Google Keep style). onChange feeds
  // translationX into dragTranslateX so the lifted row can follow the finger
  // sideways and snap to an indent step as it is dragged. (There is no longer a
  // separate swipe-to-indent gesture competing for the horizontal axis.) The
  // library chains its own onBegin/onUpdate/onEnd/onFinalize handlers onto this
  // gesture; onChange is free for us to use.
  const listDragGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-10, 10])
        .activeOffsetY([-10, 10])
        .onChange((event) => {
          'worklet';
          dragTranslateX.value = event.translationX;
        }),
    [dragTranslateX],
  );

  const handleListItemFocus = useCallback<NonNullable<TextInputProps['onFocus']>>((event) => {
    const nativeTarget = event.nativeEvent.target;
    if (nativeTarget == null) return;

    // Use ScrollView's native keyboard helper so focused list item inputs stay
    // visible. scrollViewRef now points at the library's ScrollViewContainer
    // (a Reanimated ScrollView); if its forwarded ref doesn't expose
    // getScrollResponder this degrades to a no-op rather than crashing.
    const responder = scrollViewRef.current?.getScrollResponder?.();
    if (
      responder &&
      typeof responder.scrollResponderScrollNativeHandleToKeyboard === 'function'
    ) {
      responder.scrollResponderScrollNativeHandleToKeyboard(
        nativeTarget,
        FOCUSED_INPUT_KEYBOARD_MARGIN,
        true,
      );
      return;
    }
  }, []);

  const handleFocusListItem = useCallback(
    (_itemId: string, event: Parameters<NonNullable<TextInputProps['onFocus']>>[0]) => {
      handleListItemFocus(event);
    },
    [handleListItemFocus],
  );

  const hasNoteColor = !!color && !isWhiteHexColor(color);

  // Per-item callbacks shared by the active list (renderListItem) and the
  // completed-items section, so both wire ListItem the same way.
  const listItemHandlers = useMemo<ListItemHandlers>(
    () => ({
      onToggle: (itemId, completed) => { void handleItemCompletedToggle(itemId, completed); },
      onChangeText: handleItemTextChange,
      onDelete: handleDeleteItem,
      onEnterAtCursor: handleItemEnterAtCursor,
      onBackspaceOnEmpty: handleBackspaceOnEmpty,
      onAssignPress: openAssigneePicker,
      onFocus: handleFocusListItem,
    }),
    [handleItemCompletedToggle, handleItemTextChange, handleDeleteItem, handleItemEnterAtCursor, handleBackspaceOnEmpty, openAssigneePicker, handleFocusListItem],
  );

  const renderActiveRow = useCallback(
    ({ item, index }: ReorderableListRenderItemInfo<LocalItem>) => {
      const originalIndex = itemIndexMapRef.current.get(item.id);
      if (originalIndex === undefined) return null;
      const baseLevel = item.parentId ? 1 : 0;
      return (
        <ActiveListRow
          dragTranslateX={dragTranslateX}
          indentBaseLevel={baseLevel}
          // Mirror commitDrag: an item can only nest if it has no children and
          // there is a row above it to nest under (index > 0 in the active list).
          // Keeping this in step stops the preview showing an indent that the
          // drop would reject.
          canIndent={!itemHasChildren(itemsRef.current, item.id) && index > 0}
          canOutdent={baseLevel === 1}
          listItemProps={{
            inputRef: getItemRef(item.id),
            autoFocus: item.id === autoFocusItemIdRef.current,
            text: item.text,
            completed: item.completed,
            indentLevel: item.parentId ? 1 : 0,
            showDragHandle: true,
            assignedTo: item.assigned_to,
            isShared: !!isNoteShared,
            collaborators,
            hasNoteColor,
            completedItemTexts,
            onToggle: () => listItemHandlers.onToggle(item.id, !item.completed),
            onChangeText: (text) => listItemHandlers.onChangeText(originalIndex, text),
            onDelete: () => listItemHandlers.onDelete(originalIndex),
            onSubmitEditing: (cursorPos) => listItemHandlers.onEnterAtCursor(originalIndex, cursorPos),
            onBackspaceOnEmpty: () => listItemHandlers.onBackspaceOnEmpty(originalIndex),
            onAssignPress: () => listItemHandlers.onAssignPress(item.id),
            onFocus: (event) => listItemHandlers.onFocus(item.id, event),
            onAcceptSuggestion: (text) => handleAcceptSuggestion(item.id, text),
          }}
        />
      );
    },
    [getItemRef, listItemHandlers, isNoteShared, collaborators, hasNoteColor, completedItemTexts, handleAcceptSuggestion, dragTranslateX],
  );

  const applyToolbarEdit = useCallback((updater: (prev: string) => string) => {
    const next = updater(contentRef.current);
    if (next === contentRef.current || next.length > VALIDATION.CONTENT_MAX_LENGTH) {
      return;
    }
    setContent(next);
    markDirtyAndScheduleUpdate();
    contentInputRef.current?.focus();
  }, [markDirtyAndScheduleUpdate]);

  const wrapMobileSelection = useCallback((before: string, after: string) => {
    applyToolbarEdit((prev) => prev + before + after);
  }, [applyToolbarEdit]);

  const insertMobileBullet = useCallback(() => {
    applyToolbarEdit((prev) => {
      const insert = (prev.endsWith('\n') || prev === '') ? '- ' : '\n- ';
      return prev + insert;
    });
  }, [applyToolbarEdit]);

  const insertMobileHeading = useCallback(() => {
    applyToolbarEdit((prev) => {
      const lines = prev.split('\n');
      const lastLine = lines[lines.length - 1];
      if (lastLine.startsWith('## ')) return prev;
      return prev + (prev.endsWith('\n') || prev === '' ? '' : '\n') + '## ';
    });
  }, [applyToolbarEdit]);

  const noteBackground = hasNoteColor ? color : colors.surface;
  const completedSectionDividerColor = hasNoteColor
    ? getCompletedSectionDividerColor(noteBackground)
    : colors.borderLight;

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: noteBackground, paddingBottom: androidKeyboardInset }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? IOS_KEYBOARD_VERTICAL_OFFSET : 0}
    >
      <View style={[styles.header, { backgroundColor: noteBackground, borderBottomColor: hasNoteColor ? 'transparent' : colors.borderLight, paddingTop: (bannerShown ? 0 : insets.top) + 12 }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          testID="editor-back"
        >
          <Ionicons name="arrow-back" size={24} color={hasNoteColor ? '#1a1a1a' : colors.text} />
        </TouchableOpacity>
        <View style={styles.headerRight}>
          {noteType === 'text' && isEditingContent && hasCreated ? (
            <TouchableOpacity
              onPress={() => { Keyboard.dismiss(); setIsEditingContent(false); }}
              style={[styles.typeToggle, { backgroundColor: colors.primaryLight }]}
              testID="done-editing-btn"
            >
              <Text style={[styles.typeToggleText, { color: colors.primary }]}>
                {t('common.done')}
              </Text>
            </TouchableOpacity>
          ) : (
            !hasCreated && (
              <TouchableOpacity onPress={handleToggleNoteType} style={[styles.typeToggle, { backgroundColor: colors.primaryLight }]} testID="toggle-note-type">
                <Ionicons
                  name={noteType === 'text' ? 'list' : 'document-text-outline'}
                  size={22}
                  color={colors.primary}
                />
                <Text style={[styles.typeToggleText, { color: colors.primary }]}>
                  {noteType === 'text' ? t('note.typeList') : t('note.typeText')}
                </Text>
              </TouchableOpacity>
            )
          )}
        </View>
      </View>

      {!!noteId && failedNoteIds.has(noteId) && (
        <TouchableOpacity
          style={[styles.failedBar, { backgroundColor: colors.warning, borderBottomColor: colors.warningBorder }]}
          onPress={() => navigation.navigate('SyncFailures')}
          testID="editor-failed-bar"
          accessibilityRole="button"
          accessibilityLabel={t('syncFailures.badge')}
        >
          <Ionicons name="alert-circle" size={16} color={colors.warningText} />
          <Text style={[styles.failedBarText, { color: colors.warningText }]} numberOfLines={1}>
            {t('syncFailures.editorBanner')}
          </Text>
          <Ionicons name="chevron-forward" size={16} color={colors.warningText} />
        </TouchableOpacity>
      )}

      {openedFromShare && shareServers.length > 1 && (
        <View style={[styles.shareTargetBar, { backgroundColor: colors.primaryLight, borderBottomColor: colors.primary }]} testID="share-target-bar">
          <Text style={[styles.shareTargetText, { color: colors.primary }]} numberOfLines={1}>
            {t('shareIntent.saveTargetLabel', { server: activeShareServerName })}
          </Text>
          <TouchableOpacity
            onPress={() => setShareServerPickerVisible(true)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            testID="share-change-server-btn"
          >
            <Text style={[styles.shareTargetAction, { color: colors.primary }]}>{t('shareIntent.changeServer')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {saveError && (
        <TouchableOpacity
          style={[styles.errorBanner, { backgroundColor: colors.errorLight, borderBottomColor: colors.error }]}
          onPress={() => {
            setSaveError(null);
            if (debounceRef.current) {
              clearTimeout(debounceRef.current);
              debounceRef.current = null;
            }
            flushSave();
          }}
          testID="save-error-banner"
        >
          <Text style={[styles.errorText, { color: colors.error }]}>{saveError}</Text>
        </TouchableOpacity>
      )}

      {syncToast && (
        <TouchableOpacity
          style={[styles.syncToast, { backgroundColor: colors.primaryLight, borderBottomColor: colors.primary }]}
          onPress={() => setSyncToast(null)}
          testID="sync-toast"
        >
          <Text style={[styles.syncToastText, { color: colors.primary }]}>{syncToast}</Text>
        </TouchableOpacity>
      )}

      {/*
        ScrollViewContainer (from react-native-reorderable-list) wraps the editor
        so the NestedReorderableList below can drive drag-to-reorder and autoscroll
        while still scrolling as one page with the title and completed section.
      */}
      <ScrollViewContainer
        ref={scrollViewRef}
        style={styles.scrollContent}
        contentContainerStyle={styles.scrollContentContainer}
        keyboardShouldPersistTaps="handled"
      >
        {(displayedImages.length > 0 || displayedImageUploads.length > 0) && (
          <NoteImageGallery
            images={displayedImages}
            editable
            uploads={displayedImageUploads}
            onRemove={removeNoteImage}
            onRetryUpload={retryImageUpload}
            onDismissUpload={removeUploadTile}
          />
        )}

        {noteType === 'list' && (
          <TextInput
            ref={titleInputRef}
            style={[styles.titleInput, { color: hasNoteColor ? '#1a1a1a' : colors.text }]}
            value={title}
            onChangeText={handleTitleChange}
            placeholder={t('note.titlePlaceholder')}
            placeholderTextColor={hasNoteColor ? '#999' : colors.placeholder}
            maxLength={VALIDATION.TITLE_MAX_LENGTH}
            returnKeyType="next"
            onSubmitEditing={handleTitleSubmit}
            blurOnSubmit={false}
            editable={!isHydrating}
            testID="note-title-input"
          />
        )}

        {noteType === 'text' ? (
          <>
            {isEditingContent ? (
              <TextInput
                ref={contentInputRef}
                autoFocus
                inputAccessoryViewID={Platform.OS === 'ios' ? MARKDOWN_TOOLBAR_ID : undefined}
                multiline
                autoCapitalize="sentences"
                placeholder={t('note.contentPlaceholder')}
                placeholderTextColor={hasNoteColor ? '#999' : colors.placeholder}
                style={[styles.contentInput, { color: hasNoteColor ? '#1a1a1a' : colors.text }]}
                value={content}
                onChangeText={handleContentChange}
                textAlignVertical="top"
                editable={!isHydrating}
                testID="note-content-input"
              />
            ) : (
              <TouchableOpacity
                onPress={() => setIsEditingContent(true)}
                activeOpacity={1}
                testID="content-preview"
                style={styles.contentPreview}
              >
                {content ? (
                  <Markdown style={fullMarkdownStyles(hasNoteColor ? '#1a1a1a' : colors.text)}>
                    {preprocessMarkdown(content)}
                  </Markdown>
                ) : (
                  <Text style={{ color: hasNoteColor ? '#999' : colors.placeholder, fontSize: 14 }}>
                    {t('note.contentPlaceholder')}
                  </Text>
                )}
              </TouchableOpacity>
            )}

            {/* Android: formatting toolbar in layout (shown when editing) */}
            {Platform.OS === 'android' && isEditingContent && (
              <MarkdownToolbarContent
                onBold={() => wrapMobileSelection('**', '**')}
                onItalic={() => wrapMobileSelection('*', '*')}
                onHeading={insertMobileHeading}
                onBullet={insertMobileBullet}
              />
            )}

            {/* iOS: formatting toolbar as InputAccessoryView (docks above keyboard) */}
            {Platform.OS === 'ios' && noteType === 'text' && (
              <InputAccessoryView nativeID={MARKDOWN_TOOLBAR_ID}>
                <MarkdownToolbarContent
                  onBold={() => wrapMobileSelection('**', '**')}
                  onItalic={() => wrapMobileSelection('*', '*')}
                  onHeading={insertMobileHeading}
                  onBullet={insertMobileBullet}
                />
              </InputAccessoryView>
            )}
          </>
        ) : (
          <View style={styles.listContainer}>
            <NestedReorderableList
              data={uncheckedItems}
              keyExtractor={(item) => item.id}
              scrollable={false}
              shouldUpdateActiveItem
              panGesture={listDragGesture}
              onReorder={handleListReorder}
              onDragEnd={handleListDragEnd}
              cellAnimations={DRAG_CELL_ANIMATIONS}
              renderItem={renderActiveRow}
              // Slide remaining rows into place when an item is checked off (and
              // moves to the completed section) or deleted. Skipped under the OS
              // Reduce Motion setting, like the editor's other animations.
              itemLayoutAnimation={isReduceMotionEnabledSync() ? undefined : LinearTransition.duration(LIST_REFLOW_ANIM_MS)}
            />

            <TouchableOpacity style={styles.addItemRow} onPress={handleAddItem} testID="add-list-item">
              <Ionicons name="add" size={22} color={colors.primary} />
              <Text style={[styles.addItemText, { color: colors.primary }]}>{t('note.addItem')}</Text>
            </TouchableOpacity>

            <CheckedItemsSection
              checkedItems={checkedItems}
              items={items}
              itemIndexMap={itemIndexMap}
              collapsed={checkedItemsCollapsed}
              onToggleCollapsed={handleToggleCollapsed}
              getItemRef={getItemRef}
              isNoteShared={!!isNoteShared}
              collaborators={collaborators}
              hasNoteColor={hasNoteColor}
              dividerColor={completedSectionDividerColor}
              handlers={listItemHandlers}
              popItemId={popItemId}
            />
          </View>
        )}
      </ScrollViewContainer>

      <View style={[styles.toolbar, { backgroundColor: noteBackground, borderTopColor: hasNoteColor ? 'transparent' : colors.border, paddingBottom: insets.bottom || 8 }]}>
        {/* Color picker button */}
        <TouchableOpacity
          onPress={() => setColorPickerVisible(true)}
          style={styles.toolbarBtn}
          testID="toolbar-color-btn"
          accessibilityLabel={t('note.changeColor')}
        >
          <Ionicons name="color-palette-outline" size={22} color={hasNoteColor ? '#444' : colors.icon} />
        </TouchableOpacity>

        {/* Send: share note content via the system share sheet. Available for
            any saved note regardless of ownership. */}
        {noteId && (
          <TouchableOpacity
            onPress={handleNativeShare}
            style={styles.toolbarBtn}
            testID="toolbar-send-btn"
            accessibilityLabel={t('note.send')}
          >
            <Ionicons name="share-outline" size={22} color={hasNoteColor ? '#444' : colors.icon} />
          </TouchableOpacity>
        )}

        {/* Share with collaborators (when the note is saved and owned by the current
            user). Sharing requires a central server and is not available in local mode.
            An offline-created note can be shared: its create drains FIFO before the
            queued share (#475). Notes with a local_* id are excluded (no server id). */}
        {!isLocalMode && noteId && !isLocalId(noteId) && existingNote && existingNote.user_id === currentUser?.id && (
          <TouchableOpacity
            onPress={() => navigation.navigate('Share', { noteId })}
            style={styles.toolbarBtn}
            testID="toolbar-share-btn"
            accessibilityLabel={t('note.share')}
          >
            <Ionicons name="person-add-outline" size={22} color={hasNoteColor ? '#444' : colors.icon} />
          </TouchableOpacity>
        )}

        {/* Pin / Unpin */}
        {noteId && (
          <TouchableOpacity
            onPress={handleTogglePin}
            style={styles.toolbarBtn}
            testID="toolbar-pin-btn"
            accessibilityLabel={pinned ? t('note.unpin') : t('note.pin')}
          >
            <Ionicons name={pinned ? 'pin' : 'pin-outline'} size={22} color={pinned ? colors.primary : (hasNoteColor ? '#444' : colors.icon)} />
          </TouchableOpacity>
        )}

        {/* Archive / Unarchive */}
        {noteId && (
          <TouchableOpacity
            onPress={handleToggleArchive}
            style={styles.toolbarBtn}
            testID="toolbar-archive-btn"
            accessibilityLabel={archived ? t('note.unarchive') : t('note.archive')}
          >
            <Ionicons
              name="archive-outline"
              size={22}
              color={archived ? colors.primary : (hasNoteColor ? '#444' : colors.icon)}
            />
          </TouchableOpacity>
        )}

        {/* Duplicate. */}
        {noteId && (
          <TouchableOpacity
            onPress={handleDuplicate}
            style={styles.toolbarBtn}
            testID="toolbar-duplicate-btn"
            accessibilityLabel={t('note.duplicate')}
          >
            <Ionicons name="copy-outline" size={22} color={hasNoteColor ? '#444' : colors.icon} />
          </TouchableOpacity>
        )}

        {/* Label button. Label ops queue FIFO behind an offline-created note's
            create (#475), so they work for pending-create notes. Only unsynced
            notes with a local_* id (offline labels) are excluded. */}
        {noteId && !isLocalId(noteId) && (
          <TouchableOpacity
            onPress={() => setLabelPickerVisible(true)}
            style={styles.toolbarBtn}
            testID="toolbar-label-btn"
            accessibilityLabel={t('labels.title')}
          >
            <Ionicons name="pricetag-outline" size={22} color={hasNoteColor ? '#444' : colors.icon} />
          </TouchableOpacity>
        )}

        {/* Add image. Images require a server-backed note_id (spec §15.6 — no
            draft/orphan uploads), so this is gated the same as the label
            button. Offline uploads are queued and flushed on reconnect (#618). */}
        {noteId && !isLocalId(noteId) && (
          <TouchableOpacity
            onPress={() => setAddImageSheetVisible(true)}
            style={styles.toolbarBtn}
            testID="toolbar-add-image-btn"
            accessibilityLabel={t('images.addImage')}
          >
            <Ionicons name="image-outline" size={22} color={hasNoteColor ? '#444' : colors.icon} />
          </TouchableOpacity>
        )}

        <View style={styles.toolbarSpacer} />

        {/* Delete */}
        <TouchableOpacity onPress={handleDelete} style={styles.toolbarBtn} testID="delete-note-btn">
          <Ionicons name="trash-outline" size={22} color={colors.error} />
        </TouchableOpacity>
      </View>

      <ColorPicker
        visible={colorPickerVisible}
        currentColor={color}
        onSelect={handleColorSelect}
        onClose={() => setColorPickerVisible(false)}
      />

      <AddImageActionSheet
        visible={addImageSheetVisible}
        onClose={() => setAddImageSheetVisible(false)}
        onPick={queueImageFiles}
        onPermissionDenied={handleImagePermissionDenied}
        remainingSlots={Math.max(
          IMAGE_MAX_PER_NOTE - displayedImages.length - displayedImageUploads.filter((u) => u.status !== 'error').length,
          0,
        )}
      />

      {noteId && (
        <LabelPicker
          visible={labelPickerVisible}
          noteId={noteId}
          noteLabels={labels}
          onClose={() => setLabelPickerVisible(false)}
        />
      )}

      <AssigneePicker
        visible={assigneePickerVisible}
        collaborators={collaborators}
        currentAssigneeId={
          assigningItemId
            ? items.find((i) => i.id === assigningItemId)?.assigned_to ?? ''
            : ''
        }
        onAssign={(userId) => {
          if (assigningItemId) {
            handleAssignItem(assigningItemId, userId);
          }
        }}
        onClose={() => {
          setAssigneePickerVisible(false);
          setAssigningItemId(null);
        }}
      />

      <Modal
        visible={shareServerPickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setShareServerPickerVisible(false)}
      >
        <TouchableOpacity
          style={styles.shareModalOverlay}
          activeOpacity={1}
          onPress={() => setShareServerPickerVisible(false)}
        >
          <View style={[styles.shareModalCard, { backgroundColor: colors.surface }]}>
            <Text style={[styles.shareModalTitle, { color: colors.text }]}>
              {t('shareIntent.chooseServerTitle')}
            </Text>
            {shareServers.map((server) => (
              <TouchableOpacity
                key={server.serverId}
                style={styles.shareModalRow}
                onPress={() => { void handleRedirectShare(server.serverId); }}
                testID={`share-server-option-${server.serverId}`}
              >
                <Text style={[styles.shareModalRowText, { color: colors.text }]} numberOfLines={1}>
                  {server.displayName || server.serverUrl}
                </Text>
                {server.serverId === activeShareServerId && (
                  <Ionicons name="checkmark" size={18} color={colors.primary} />
                )}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </KeyboardAvoidingView>
  );
}
