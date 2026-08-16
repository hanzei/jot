import { useState, useEffect, useRef, useCallback, useMemo, useContext } from 'react';
import axios from 'axios';
import type {
  ScrollView} from 'react-native';
import {
  Animated,
  Easing,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  InputAccessoryView,
  Keyboard,
  Modal,
  Share,
  StyleSheet,
  useAnimatedValue,
  useWindowDimensions,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
  type TextInput as TextInputType,
} from 'react-native';
import {
  NestedReorderableList,
  ScrollViewContainer,
  type ReorderableListRenderItemInfo,
} from 'react-native-reorderable-list';
import { LinearTransition } from 'react-native-reanimated';
import { Archive, ArrowLeft, Check, ChevronRight, CircleAlert, EllipsisVertical, FileText, Image, List, Palette, Pin, Plus } from 'lucide-react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { useDeleteNote, useRestoreNote, usePermanentDeleteNote, useDuplicateNote, useConvertNoteType, NoteConversionCapError } from '../hooks/useNotes';
import { useOfflineNote } from '../hooks/useOfflineNotes';
import { useKeyboardHeight } from '../hooks/useKeyboardHeight';
import { useFailedNoteIds } from '../store/OfflineContext';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import ConfirmDialog from '../components/ConfirmDialog';
import Markdown from '../components/Markdown';
import ColorPicker from '../components/ColorPicker';
import LabelPicker from '../components/LabelPicker';
import AssigneePicker from '../components/AssigneePicker';
import AddImageActionSheet from '../components/AddImageActionSheet';
import { useUploadNoteImage, useDeleteNoteImage } from '../hooks/useNoteImages';
import { usePendingImageUploads, useRetryPendingImageUpload, useDismissPendingImageUpload } from '../hooks/usePendingImageUploads';
import type { ImageUploadFile } from '../api/images';
import { buildCollaborators, generateId, IMAGE_MAX_PER_NOTE, exceedsCodePointLimit, truncateToCodePoints, validateImageFile as validateImageFileRaw, imageMaxMB, type Collaborator, type NoteImage } from '@jot/shared';
import { useServerConfig } from '../hooks/useServerConfig';
import { useAuth } from '../store/AuthContext';
import { useUsers } from '../store/UsersContext';
import { useTheme } from '../theme/ThemeContext';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { getCompletedSectionDividerColor, isWhiteHexColor } from '../utils/colorContrast';
import { formatEditorStateForShare } from '../utils/noteTextFormatter';
import { getActiveServer, listServers, type ServerAccountEntry } from '../store/serverAccounts';
import { setPendingShare, usePendingShare } from '../store/shareIntent';
import {
  type LocalItem,
  itemHasChildren,
} from './noteEditor/listItemModel';
import { MarkdownToolbarContent } from './noteEditor/EditorToolbars';
import {
  clampSelection,
  continueListOnNewline,
  cycleHeading,
  toggleBullet,
  toggleCheckbox,
  toggleInlineMarker,
  VALIDATION,
  type EditorText,
  type TextSelection,
} from '@jot/shared';
import CheckedItemsSection from './noteEditor/CheckedItemsSection';
import NoteEditorMenu from '../components/NoteEditorMenu';
import NoteImageGallery, { type PendingImageUpload } from '../components/NoteImageGallery';
import UserAvatar from '../components/UserAvatar';
import { styles } from './noteEditor/styles';
import { animateListReflow, isReduceMotionEnabledSync } from '../utils/layoutAnimation';
import ActiveListRow from './noteEditor/ActiveListRow';
import { useEditorDoc } from './noteEditor/useEditorDoc';
import { useNoteEditorSync } from './noteEditor/useNoteEditorSync';
import { useListItemEditing } from './noteEditor/useListItemEditing';
import { usePendingActionIndicator } from './noteEditor/usePendingActionIndicator';
import type { EditorNavProp, EditorRouteProp } from './noteEditor/types';

const IOS_KEYBOARD_VERTICAL_OFFSET = 88;
const MARKDOWN_TOOLBAR_ID = 'markdown-formatting-toolbar';
// A separate accessory id from the content bar's: the two carry different
// buttons, and an InputAccessoryView is matched to an input by nativeID.
const ITEM_MARKDOWN_TOOLBAR_ID = 'item-markdown-formatting-toolbar';
// Duration (ms) of the row slide when the active list reflows after a toggle/delete.
const LIST_REFLOW_ANIM_MS = 150;
// Duration of the zoom-open / zoom-closed transform animation.
const ZOOM_MS = 280;
// Override the reorderable list's default cell animation so the dragged row is
// fully static apart from following the finger: opacity stays 1 and no scale is
// applied. The library's default opacity/scale animations could otherwise stick
// after a drop and leave the row greyed out or enlarged. Module-scoped so the
// reference stays stable across renders.
const DRAG_CELL_ANIMATIONS = { opacity: 1, transform: [] };

export default function NoteEditorScreen() {
  const navigation = useNavigation<EditorNavProp>();
  const route = useRoute<EditorRouteProp>();
  const { noteId: initialNoteId, sharedText, initialNoteType, readOnly, originRect, originColor } = route.params;
  const { t } = useTranslation();
  const failedNoteIds = useFailedNoteIds();
  const { upload_max_bytes: uploadMaxBytes } = useServerConfig();
  const uploadMaxMB = imageMaxMB(uploadMaxBytes);

  // A new note opened from a share intent arrives with sharedText to pre-fill
  // the body.
  const openedFromShare = initialNoteId === null && !!sharedText;

  // The note being edited. `handle` is the stable set of refs/setters the
  // editing and persistence hooks below act through.
  const editor = useEditorDoc({ initialNoteId, initialNoteType, sharedText, originColor });
  const { noteId, title, content, noteType, items, checkedItemsCollapsed, pinned, archived, color, labels, hasCreated } = editor;
  const {
    noteIdRef,
    noteTypeRef,
    titleRef,
    contentRef,
    itemsRef,
    colorRef,
    pinnedRef,
    archivedRef,
    setNoteId,
    setNoteType,
    setTitle,
    setContent,
    setCheckedItemsCollapsed,
    setPinned,
    setArchived,
    setColor,
    setHasCreated,
  } = editor.handle;

  const [colorPickerVisible, setColorPickerVisible] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [labelPickerVisible, setLabelPickerVisible] = useState(false);
  const [assigneePickerVisible, setAssigneePickerVisible] = useState(false);
  const [assigningItemId, setAssigningItemId] = useState<string | null>(null);
  const [isEditingContent, setIsEditingContent] = useState(initialNoteId === null);
  // Set only to move the caret after an edit the user did not type (a formatting
  // button, an auto-continued list). It is released as soon as the input reports
  // the caret actually landed there, so normal typing stays uncontrolled and
  // never fights the native selection.
  const [forcedSelection, setForcedSelection] = useState<TextSelection | null>(null);
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
  const { confirm } = useConfirm();

  const { colors } = useTheme();
  const insets = useContext(SafeAreaInsetsContext) ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const keyboardHeight = useKeyboardHeight();
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
  const { data: existingNote } = useOfflineNote(noteId);
  // A trashed note opens view-only. Driven by the route param set when the note
  // is opened from the trash list, and defensively by the note's own deleted_at
  // in case it lands here already trashed.
  const isReadOnly = readOnly === true || existingNote?.deleted_at != null;
  const deleteMutation = useDeleteNote();
  const restoreMutation = useRestoreNote();
  const permanentDeleteMutation = usePermanentDeleteNote();
  const duplicateMutation = useDuplicateNote();
  const convertMutation = useConvertNoteType();
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

  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidHide', () => {
      setIsEditingContent(false);
    });
    return () => sub.remove();
  }, []);

  // Zoom transition: animate the whole editor from the tapped card's rect up to
  // full screen on open, and back down on close. Decided once at mount; the
  // native present/dismiss is disabled so this transform is the only motion.
  const { width: screenW, height: screenH } = useWindowDimensions();
  const [zoomEnabled] = useState(() => !!originRect && !isReduceMotionEnabledSync());
  // 0 = scaled/positioned onto the card, 1 = full screen.
  const zoom = useAnimatedValue(zoomEnabled ? 0 : 1);
  // Holds the editor invisible for the first frame of a zoom-open. With the
  // native driver the transform/opacity aren't written as static props on the
  // JS render — the native animation node applies them, and it only attaches
  // after the first paint (anim.start runs post-mount). Without this gate the
  // editor paints once at its identity layout (full screen, opaque) before
  // snapping onto the card — a visible flash, worst on the first, cold open.
  // A plain (non-native) opacity:0 hides that frame; we reveal on the next
  // frame, once the native node is driving the transform from the card.
  const [zoomRevealed, setZoomRevealed] = useState(!zoomEnabled);

  // Zoom open from the card once on mount.
  useEffect(() => {
    if (!zoomEnabled) return;
    const anim = Animated.timing(zoom, {
      toValue: 1,
      duration: ZOOM_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    anim.start();
    const raf = requestAnimationFrame(() => setZoomRevealed(true));
    return () => {
      cancelAnimationFrame(raf);
      anim.stop();
    };
    // Mount-only; zoom/zoomEnabled are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Zoom the editor back down onto the card, resolving when done. Instant when
  // the note wasn't opened from a card or Reduce Motion is on.
  const animateClose = useCallback(() => {
    if (!zoomEnabled) return Promise.resolve();
    // Blur any focused input first. A focused TextInput and its input-accessory
    // toolbar render outside the transformed view, so without this they "hang"
    // in place while the editor scales away. Wait a frame so the blur takes
    // effect before the zoom starts.
    Keyboard.dismiss();
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        Animated.timing(zoom, {
          toValue: 0,
          duration: ZOOM_MS,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }).start(() => resolve());
      });
    });
  }, [zoom, zoomEnabled]);

  const { isPending: isMenuActionPending, withPendingIndicator } = usePendingActionIndicator();

  const sync = useNoteEditorSync({
    doc: editor.handle,
    noteId,
    initialNoteId,
    existingNote,
    navigation,
    zoomEnabled,
    animateClose,
    t,
    showToast,
  });
  const {
    saveError,
    setSaveError,
    syncToast,
    setSyncToast,
    flushSave,
    flushPendingChanges,
    cancelScheduledSave,
    markDirtyAndScheduleUpdate,
    runMetadataUpdate,
    commitMetadataBaseline,
    isHydratingRef,
    intentionalExitRef,
    isClosingRef,
    saveInFlightRef,
    exitSavePrompt,
    isExitRetrying,
    handleExitRetry,
    handleExitDiscard,
  } = sync;

  // Mark the exit as intentional (so beforeRemove doesn't re-handle it), zoom
  // back onto the card, then pop. Used by every action that leaves the editor
  // via its own button (archive, trash, restore, delete-forever) so the zoom
  // and any dashboard removal reflow plays consistently instead of only on
  // some exit paths.
  const zoomCloseAndExit = useCallback(async () => {
    isClosingRef.current = true;
    await animateClose();
    intentionalExitRef.current = true;
    navigation.goBack();
  }, [animateClose, intentionalExitRef, isClosingRef, navigation]);

  // Maps the fullscreen editor onto the originating card at zoom 0 and to its
  // natural position/size at zoom 1. A short opacity ramp softens the first
  // (most distorted) frames of the non-uniform scale.
  const zoomStyle = useMemo(() => {
    if (!originRect) return null;
    const centerX = originRect.x + originRect.width / 2;
    const centerY = originRect.y + originRect.height / 2;
    return {
      // Fade fully out at the card end so the pop after the close zoom isn't a
      // visible snap; fade in quickly on open.
      opacity: zoom.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 1, 1] }),
      transform: [
        { translateX: zoom.interpolate({ inputRange: [0, 1], outputRange: [centerX - screenW / 2, 0] }) },
        { translateY: zoom.interpolate({ inputRange: [0, 1], outputRange: [centerY - screenH / 2, 0] }) },
        { scaleX: zoom.interpolate({ inputRange: [0, 1], outputRange: [originRect.width / screenW, 1] }) },
        { scaleY: zoom.interpolate({ inputRange: [0, 1], outputRange: [originRect.height / screenH, 1] }) },
      ],
    };
  }, [originRect, zoom, screenW, screenH]);

  const displayedImageUploadsRef = useRef(displayedImageUploads);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  displayedImageUploadsRef.current = displayedImageUploads;
  const pendingImageUploadsRef = useRef(pendingImageUploads);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  pendingImageUploadsRef.current = pendingImageUploads;
  const imageUploadFilesRef = useRef(new Map<string, ImageUploadFile>());
  const activeImageUploadIdsRef = useRef(new Set<string>());
  // Lets the gallery's cancel button abort an in-flight upload (issue #695).
  // Only holds an entry while a request for that upload id is actually in flight.
  const imageUploadAbortControllersRef = useRef(new Map<string, AbortController>());

  const displayedImages = useMemo(
    () => (existingNote?.images ?? []).filter((img) => !removedImageIds.has(img.id)),
    [existingNote?.images, removedImageIds],
  );

  const validateImageFile = useCallback((file: ImageUploadFile): string | null => {
    const error = validateImageFileRaw(file, uploadMaxBytes);
    if (error === 'wrongType') return t('images.errorWrongType');
    if (error === 'tooLarge') return t('images.errorTooLarge', { maxMB: uploadMaxMB });
    return null;
  }, [t, uploadMaxBytes, uploadMaxMB]);

  const removeUploadTile = useCallback((uploadId: string) => {
    // Abort a request actually in flight for this tile (the 'uploading'
    // state's cancel button, issue #695) so a stalled/slow upload doesn't
    // keep running after the user has dismissed its tile.
    const controller = imageUploadAbortControllersRef.current.get(uploadId);
    if (controller) {
      controller.abort();
      imageUploadAbortControllersRef.current.delete(uploadId);
    }
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
    const controller = new AbortController();
    imageUploadAbortControllersRef.current.set(uploadId, controller);
    uploadImageMutation.mutateAsync({
      noteId: currentNoteId,
      uploadId,
      file,
      signal: controller.signal,
      onProgress: (percent) => {
        setImageUploads((prev) => prev.map((u) => (u.id === uploadId ? { ...u, progress: percent } : u)));
      },
    }).then((result) => {
      activeImageUploadIdsRef.current.delete(uploadId);
      imageUploadAbortControllersRef.current.delete(uploadId);
      // Either it uploaded, or it fell back to the persisted offline queue
      // (issue #618) — either way the ephemeral tile is done; a queued upload
      // is now rendered from `pendingImageUploads` instead, under the same id.
      setImageUploads((prev) => prev.filter((u) => u.id !== uploadId));
      imageUploadFilesRef.current.delete(uploadId);
      if (result.status === 'queued') showToast(t('images.uploadQueuedToast'), 'info');
    }).catch((error) => {
      activeImageUploadIdsRef.current.delete(uploadId);
      imageUploadAbortControllersRef.current.delete(uploadId);
      // A user-initiated cancel (the tile's cancel button, issue #695) has
      // already dropped the tile in removeUploadTile — nothing left to do.
      if (axios.isCancel(error)) return;
      console.error('Failed to upload note image:', error);
      const status = (error as { response?: { status?: number } })?.response?.status;
      const message = status === 413 ? t('images.errorTooLarge', { maxMB: uploadMaxMB }) : t('images.uploadFailed');
      setImageUploads((prev) => prev.map((u) => (u.id === uploadId ? { ...u, status: 'error', errorMessage: message } : u)));
    });
  }, [noteIdRef, showToast, t, uploadImageMutation, uploadMaxMB]);

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
  }, [deleteImageMutation, noteIdRef, showToast, t]);

  // Abort any uploads still in flight on unmount so they don't keep running in
  // the background for up to the full timeout and fire state updates after this
  // screen has gone (issue #695). The ref's Map identity never changes across
  // the component's lifetime (only mutated in place), so capturing it here sees
  // the same, up-to-date entries at cleanup time.
  useEffect(() => {
    const uploadAbortControllers = imageUploadAbortControllersRef.current;
    return () => {
      for (const controller of uploadAbortControllers.values()) {
        controller.abort();
      }
      uploadAbortControllers.clear();
    };
  }, []);

  const titleInputRef = useRef<TextInputType>(null);
  const contentInputRef = useRef<TextInputType>(null);
  // Where the caret sits in the content input. The formatting bar edits text
  // around it, so it has to be tracked even though the input is otherwise
  // uncontrolled with respect to selection.
  const contentSelectionRef = useRef<TextSelection>({ start: 0, end: 0 });
  const scrollViewRef = useRef<ScrollView>(null);

  const openAssigneePicker = useCallback((itemId: string) => {
    if (isReadOnly) return;
    setAssigningItemId(itemId);
    setAssigneePickerVisible(true);
  }, [isReadOnly]);

  const listEditing = useListItemEditing({
    doc: editor.handle,
    items,
    markDirtyAndScheduleUpdate,
    cancelScheduledSave,
    setSaveError,
    savedItemsRef: sync.savedItemsRef,
    savedOrderRef: sync.savedOrderRef,
    withPendingIndicator,
    scrollViewRef,
    openAssigneePicker,
    confirm,
    showToast,
    t,
  });
  const {
    uncheckedItems,
    checkedItems,
    itemIndexMap,
    itemIndexMapRef,
    completedItemTexts,
    popItemId,
    isEditingItem,
    getItemRef,
    getItemSelectionRef,
    itemSelectionRefsMap,
    autoFocusItemIdRef,
    focusedItemIdRef,
    dragTranslateX,
    listItemHandlers,
    handleAddItem,
    handleItemTextChange,
    handleAcceptSuggestion,
    handleAssignItem,
    handleUncheckAllItems,
    handleDeleteCompletedItems,
    focusFirstUncheckedOrAppend,
    listDragGesture,
    handleListDragStart,
    handleListDragEnd,
    handleListReorder,
  } = listEditing;

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
    cancelScheduledSave();
    intentionalExitRef.current = true;
    await withPendingIndicator(async () => {
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
    });
    redirectInitiatedRef.current = true;
    setPendingShare({ text: contentRef.current, targetServerId: serverId });
  }, [activeShareServerId, cancelScheduledSave, contentRef, deleteMutation, intentionalExitRef, noteIdRef, saveInFlightRef, withPendingIndicator]);

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
  }, [pendingShare, markDirtyAndScheduleUpdate, intentionalExitRef, noteIdRef, setNoteId, setHasCreated]);

  const activeShareServerName = useMemo(() => {
    const active = shareServers.find((server) => server.serverId === activeShareServerId);
    return active?.displayName || active?.serverUrl || '';
  }, [shareServers, activeShareServerId]);

  // Save-first wrapper for note-level actions. A new/unsaved note is created by
  // flushing before the action runs, so bar actions no longer have to be hidden
  // until the first autosave. flushSave no-ops (and leaves noteId null) only for
  // a genuinely empty note, in which case the action is skipped.
  const withSavedNote = useCallback(async (action: (id: string) => void | Promise<void>) => {
    await withPendingIndicator(async () => {
      const saved = await flushPendingChanges();
      if (!saved) return; // save failed — error already surfaced by flushSave
      const id = noteIdRef.current;
      if (!id) return; // empty note, nothing to act on
      await action(id);
    });
  }, [flushPendingChanges, noteIdRef, withPendingIndicator]);

  const handleTitleChange = useCallback(
    (newTitle: string) => {
      // Clamped rather than rejected so a long paste keeps what fits, which is
      // what the TextInput's maxLength used to do before it was dropped for
      // counting UTF-16 units instead of code points. Typing past a full title
      // clamps to the same string, so don't schedule a save for a no-op.
      const clamped = truncateToCodePoints(newTitle, VALIDATION.TITLE_MAX_LENGTH);
      if (clamped === titleRef.current) return;
      setTitle(clamped);
      markDirtyAndScheduleUpdate();
    },
    [markDirtyAndScheduleUpdate, setTitle, titleRef],
  );

  const handleContentChange = useCallback(
    (newContent: string) => {
      // Enter at the end of a list item carries the marker to the next line
      // (and clears it on an empty item) instead of dropping out of the list.
      let continued = continueListOnNewline(
        { text: contentRef.current, selection: contentSelectionRef.current },
        newContent,
      );
      // The marker is extra characters the user did not type, so at the cap
      // drop the continuation rather than the whole keystroke.
      if (continued && exceedsCodePointLimit(continued.text, VALIDATION.CONTENT_MAX_LENGTH)) {
        continued = null;
      }
      const text = continued?.text ?? newContent;
      if (exceedsCodePointLimit(text, VALIDATION.CONTENT_MAX_LENGTH)) return;
      if (continued) {
        const selection = clampSelection(continued.selection, text);
        contentSelectionRef.current = selection;
        setForcedSelection(selection);
      }
      setContent(text);
      markDirtyAndScheduleUpdate();
    },
    [contentRef, markDirtyAndScheduleUpdate, setContent],
  );

  const handleTitleSubmit = useCallback(() => {
    if (noteTypeRef.current === 'text') {
      contentInputRef.current?.focus();
    } else {
      focusFirstUncheckedOrAppend();
    }
  }, [focusFirstUncheckedOrAppend, noteTypeRef]);

  const handleToggleCollapsed = useCallback(() => {
    if (isReadOnly) return;
    animateListReflow();
    setCheckedItemsCollapsed((prev) => !prev);
    markDirtyAndScheduleUpdate();
  }, [isReadOnly, markDirtyAndScheduleUpdate, setCheckedItemsCollapsed]);

  const collaborators = useMemo<Collaborator[]>(() => {
    if (!existingNote) return [];
    const hasShares = existingNote.shared_with && existingNote.shared_with.length > 0;
    if (!existingNote.is_shared && !hasShares) return [];
    return buildCollaborators(existingNote.user_id, existingNote.shared_with, usersById);
  }, [existingNote, usersById]);

  // Avatars shown in the meta row exclude the current user, matching the
  // dashboard note cards (you never see yourself in a note's avatar stack).
  // The full `collaborators` list is kept intact for task assignment, where
  // assigning an item to yourself is valid.
  const displayCollaborators = useMemo(
    () => collaborators.filter((c) => c.userId !== currentUser?.id),
    [collaborators, currentUser?.id],
  );

  const isNoteShared = useMemo(() => {
    return (existingNote?.shared_with && existingNote.shared_with.length > 0) || existingNote?.is_shared;
  }, [existingNote?.shared_with, existingNote?.is_shared]);

  const handleNativeShare = useCallback(() => {
    const text = formatEditorStateForShare(noteTypeRef.current, titleRef.current, contentRef.current, itemsRef.current);
    if (text.trim()) void Share.share({ message: text });
  }, [contentRef, itemsRef, noteTypeRef, titleRef]);

  const handleDelete = useCallback(async () => {
    if (!noteId) {
      intentionalExitRef.current = true;
      navigation.goBack();
      return;
    }
    // Moving to trash is undoable (toast below + restoreMutation), so this
    // doesn't confirm - matches NotesListScreen's handleMoveToTrash.
    try {
      // Drop any debounced autosave; the delete runs against the last persisted
      // state, and the in-flight save (if any) is awaited below.
      cancelScheduledSave();
      // Run the delete with the editor still mounted so a slow write shows the
      // pending indicator (#697) and a failure surfaces as an Alert. On success
      // we zoom back onto the card afterwards.
      await withPendingIndicator(async () => {
        if (saveInFlightRef.current) {
          try { await saveInFlightRef.current; } catch { /* already handled */ }
        }
        // Re-read after the in-flight save settles; it may have created the note
        // and populated noteIdRef while we were awaiting it.
        const currentNoteId = noteIdRef.current;
        if (!currentNoteId) return;
        await deleteMutation.mutateAsync(currentNoteId);
        showToast(t('dashboard.noteDeleted'), 'success', {
          label: t('dashboard.undo'),
          onPress: async () => {
            try {
              await restoreMutation.mutateAsync(currentNoteId);
              showToast(t('dashboard.noteRestored'));
            } catch {
              showToast(t('note.failedRestore'), 'error');
            }
          },
        });
      });
      // Zoom back onto the card, then pop - the dashboard plays its removal
      // reflow on the still-present card as the editor shrinks away.
      await zoomCloseAndExit();
    } catch {
      Alert.alert(t('common.error'), t('note.failedDelete'));
    }
  }, [cancelScheduledSave, deleteMutation, intentionalExitRef, navigation, noteId, noteIdRef, restoreMutation, saveInFlightRef, showToast, t, withPendingIndicator, zoomCloseAndExit]);

  // Restore a trashed note (read-only view) and return to the list.
  const handleRestoreNote = useCallback(async () => {
    if (!noteId) return;
    try {
      // Restore with the editor still mounted so a slow write shows the pending
      // indicator (#697); on success zoom back onto the card and pop.
      await withPendingIndicator(() => restoreMutation.mutateAsync(noteId));
      showToast(t('dashboard.noteRestored'));
      await zoomCloseAndExit();
    } catch {
      Alert.alert(t('common.error'), t('note.failedRestore'));
    }
  }, [noteId, restoreMutation, showToast, t, withPendingIndicator, zoomCloseAndExit]);

  // Permanently delete a trashed note (read-only view) after confirmation.
  const handleDeletePermanently = useCallback(async () => {
    if (!noteId) return;
    const confirmed = await confirm({
      title: t('note.deleteForeverTitle'),
      message: t('note.deleteForeverConfirm'),
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!confirmed) return;
    const currentNoteId = noteIdRef.current;
    if (!currentNoteId) return;
    try {
      // Run the permanent delete with the editor still mounted so a slow write
      // shows the pending indicator (#697) and a failure surfaces as an Alert.
      await withPendingIndicator(() => permanentDeleteMutation.mutateAsync(currentNoteId));
      // Zoom back onto the card, then pop.
      await zoomCloseAndExit();
    } catch {
      Alert.alert(t('common.error'), t('note.failedDelete'));
    }
  }, [confirm, noteId, noteIdRef, permanentDeleteMutation, t, withPendingIndicator, zoomCloseAndExit]);

  const handleTogglePin = useCallback(() => withSavedNote(async (id) => {
    const newPinned = !pinnedRef.current;
    setPinned(newPinned);
    try {
      await runMetadataUpdate(id, { pinned: newPinned });
      commitMetadataBaseline({ pinned: newPinned });
    } catch {
      setPinned(!newPinned);
      Alert.alert(t('common.error'), t('note.failedUpdate'));
    }
  }), [commitMetadataBaseline, pinnedRef, runMetadataUpdate, setPinned, withSavedNote, t]);

  const handleToggleArchive = useCallback(() => withSavedNote(async (id) => {
    const newArchived = !archivedRef.current;
    setArchived(newArchived);

    if (!newArchived) {
      // Unarchiving keeps the user on the note.
      try {
        await runMetadataUpdate(id, { archived: false });
        commitMetadataBaseline({ archived: false });
        showToast(t('dashboard.noteUnarchived'));
      } catch {
        setArchived(true);
        Alert.alert(t('common.error'), t('note.failedUpdate'));
      }
      return;
    }

    // Archiving from the single-note view returns the user to the dashboard.
    // Zoom back onto the card first, then archive so the dashboard plays its
    // removal reflow on the still-present card. The editor is unmounted by the
    // time we mutate, so failures surface as a toast rather than an alert.
    commitMetadataBaseline({ archived: true });
    await zoomCloseAndExit();
    try {
      await runMetadataUpdate(id, { archived: true });
      showToast(t('dashboard.noteArchived'), 'success', {
        label: t('dashboard.undo'),
        onPress: async () => {
          try {
            await runMetadataUpdate(id, { archived: false });
            showToast(t('dashboard.noteUnarchived'));
          } catch {
            showToast(t('note.failedUnarchive'), 'error');
          }
        },
      });
    } catch {
      showToast(t('note.failedArchive'), 'error');
    }
  }), [archivedRef, zoomCloseAndExit, commitMetadataBaseline, runMetadataUpdate, setArchived, withSavedNote, showToast, t]);

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
      await runMetadataUpdate(currentNoteId, { color: selectedColor });
      commitMetadataBaseline({ color: selectedColor });
    } catch {
      setColor(prevColor);
      Alert.alert(t('common.error'), t('note.failedColorUpdate'));
    }
  }, [colorRef, commitMetadataBaseline, flushPendingChanges, isHydratingRef, markDirtyAndScheduleUpdate, noteIdRef, runMetadataUpdate, setColor, t]);

  const handleToggleNoteType = useCallback(() => {
    if (hasCreated) return;
    setNoteType((prev) => (prev === 'text' ? 'list' : 'text'));
  }, [hasCreated, setNoteType]);

  const handleDuplicate = useCallback(async () => {
    cancelScheduledSave();

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
      // No originRect: the duplicate isn't tied to a card, so it opens without a
      // zoom (and leaving it won't zoom onto the original's card).
      navigation.replace('NoteEditor', { noteId: duplicatedNote.id });
    } catch {
      Alert.alert(t('common.error'), t('note.failedDuplicate'));
    }
  }, [cancelScheduledSave, duplicateMutation, flushSave, intentionalExitRef, navigation, noteIdRef, t]);

  // List -> text is lossy (assignments, real checkbox/nesting structure), so
  // it's confirmed first; text -> list just reflows lines and runs directly
  // (mirrors the webapp's NoteModal). The note is reloaded via a screen replace
  // afterward, since the editor's baseline/ref state is keyed to the note's
  // pre-conversion type and shape.
  const handleConvertNoteType = useCallback(async () => {
    cancelScheduledSave();

    const saveSucceeded = await withPendingIndicator(() => flushSave());
    if (!saveSucceeded) {
      return;
    }

    const currentNoteId = noteIdRef.current;
    if (!currentNoteId) {
      return;
    }

    if (noteTypeRef.current === 'list') {
      const assignedCount = itemsRef.current.filter((item) => item.assigned_to).length;
      const message = assignedCount > 0
        ? t('note.convertToTextConfirmMessageWithAssignments', { count: assignedCount })
        : t('note.convertToTextConfirmMessage');
      const confirmed = await confirm({
        title: t('note.convertToTextConfirmTitle'),
        message,
        confirmLabel: t('note.convertToText'),
      });
      if (!confirmed) {
        return;
      }
    }

    try {
      await withPendingIndicator(async () => {
        await convertMutation.mutateAsync(currentNoteId);
        intentionalExitRef.current = true;
        navigation.replace('NoteEditor', { noteId: currentNoteId });
        showToast(t('note.converted'));
      });
    } catch (err) {
      if (err instanceof NoteConversionCapError) {
        Alert.alert(t('common.error'), err.kind === 'tooManyItems'
          ? t('note.tooManyItems', { max: err.max })
          : t('note.itemTooLong', { max: err.max }));
      } else {
        Alert.alert(t('common.error'), t('note.failedConvert'));
      }
    }
  }, [cancelScheduledSave, confirm, convertMutation, flushSave, intentionalExitRef, itemsRef, navigation, noteIdRef, noteTypeRef, showToast, t, withPendingIndicator]);

  // Disable inputs while waiting for existing note to hydrate
  const isHydrating = initialNoteId !== null && !existingNote;

  const hasNoteColor = !!color && !isWhiteHexColor(color);

  // Share, Labels, and Add-image all act on a note that exists on the server.
  // A brand-new note (noteId === null) no longer has to wait for the first
  // autosave: tapping one of these runs it through withSavedNote, which flushes
  // a create first (save-first) and then performs the action against the
  // resulting id. Offline-created notes carry a server-valid id up front and
  // queue the op for replay, so the same path works offline (issue #652).
  //
  // Sharing additionally requires a central server and ownership. A brand-new
  // note is always owned by the current user; an existing one must be owned by
  // them (a note shared with the user can't be re-shared).
  const ownsNote = noteId === null || (!!existingNote && existingNote.user_id === currentUser?.id);
  const canShareWithCollaborators = !isLocalMode && ownsNote;

  // Save-first openers shared by the overflow menu and the inline
  // labels/collaborators row below the note body, so tapping a label chip or a
  // collaborator avatar behaves exactly like the matching menu action. Both go
  // through withSavedNote: a brand-new note is created first so the picker /
  // share screen has an id to act on. The pending bar no longer flashes for the
  // common fast case — withPendingIndicator now only surfaces it after a delay.
  const openLabelPicker = useCallback(() => {
    void withSavedNote(() => setLabelPickerVisible(true));
  }, [withSavedNote]);
  const openShareScreen = useCallback(() => {
    void withSavedNote((id) => navigation.navigate('Share', { noteId: id }));
  }, [withSavedNote, navigation]);

  // Muted icon color for the bar; disabled buttons render at reduced opacity.
  const barIconColor = hasNoteColor ? '#444' : colors.icon;
  const disabledBarIconColor = hasNoteColor ? '#999' : colors.iconMuted;

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
            selectionHandleRef: getItemSelectionRef(item.id),
            inputAccessoryViewID: Platform.OS === 'ios' ? ITEM_MARKDOWN_TOOLBAR_ID : undefined,
            autoFocus: item.id === autoFocusItemIdRef.current,
            text: item.text,
            completed: item.completed,
            indentLevel: item.parentId ? 1 : 0,
            editable: !isReadOnly,
            showDragHandle: !isReadOnly,
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
            onBlur: () => listItemHandlers.onBlur(item.id),
            onAcceptSuggestion: (text) => handleAcceptSuggestion(item.id, text),
          }}
        />
      );
    },
    [autoFocusItemIdRef, getItemRef, getItemSelectionRef, itemIndexMapRef, itemsRef, listItemHandlers, isNoteShared, collaborators, hasNoteColor, completedItemTexts, handleAcceptSuggestion, dragTranslateX, isReadOnly],
  );

  /**
   * Runs a formatting-bar edit against the current text and caret, then pushes
   * both the new text and the new caret position back into the input. The
   * caret has to be set explicitly: without it the next keystroke would land
   * outside the markers that were just inserted.
   */
  const applyToolbarEdit = useCallback((edit: (state: EditorText) => EditorText) => {
    const previous = contentRef.current;
    const next = edit({ text: previous, selection: contentSelectionRef.current });
    // A dropped keystroke is at least visible as a character that never
    // appeared; a dropped button press looks like a broken button, so this one
    // says why nothing happened.
    if (exceedsCodePointLimit(next.text, VALIDATION.CONTENT_MAX_LENGTH)) {
      showToast(t('note.contentLimitReached'), 'error');
      return;
    }

    const selection = clampSelection(next.selection, next.text);
    const caret = contentSelectionRef.current;
    // Nothing to force when the caret is already where the edit wants it — e.g.
    // clearing a bullet with the caret at the start of the line, where the
    // removed characters all sit after it. The input would report no selection
    // change, so the forced value would never be released and the prop would
    // stay controlled with a value that goes stale on the next tap.
    const caretAlreadyThere = selection.start === caret.start && selection.end === caret.end;
    contentSelectionRef.current = selection;
    setForcedSelection(caretAlreadyThere ? null : selection);
    if (next.text !== previous) {
      setContent(next.text);
      markDirtyAndScheduleUpdate();
    }
    // Normally still focused (the bar's buttons are focusable={false}), and
    // re-focusing a focused input would issue a redundant show-keyboard command.
    if (!contentInputRef.current?.isFocused()) contentInputRef.current?.focus();
  }, [contentRef, markDirtyAndScheduleUpdate, setContent, showToast, t]);

  const handleContentSelectionChange = useCallback(
    (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      const selection = event.nativeEvent.selection;
      contentSelectionRef.current = selection;
      // Release the forced caret only once the input confirms it landed there,
      // so an event that arrives before the move is applied cannot cancel it.
      setForcedSelection((forced) =>
        forced && forced.start === selection.start && forced.end === selection.end ? null : forced,
      );
    },
    [],
  );

  const toggleMobileBold = useCallback(() => {
    applyToolbarEdit((state) => toggleInlineMarker(state, '**'));
  }, [applyToolbarEdit]);

  const toggleMobileItalic = useCallback(() => {
    applyToolbarEdit((state) => toggleInlineMarker(state, '*'));
  }, [applyToolbarEdit]);

  const toggleMobileStrikethrough = useCallback(() => {
    applyToolbarEdit((state) => toggleInlineMarker(state, '~~'));
  }, [applyToolbarEdit]);

  const toggleMobileHeading = useCallback(() => {
    applyToolbarEdit(cycleHeading);
  }, [applyToolbarEdit]);

  const toggleMobileBullet = useCallback(() => {
    applyToolbarEdit(toggleBullet);
  }, [applyToolbarEdit]);

  const toggleMobileCheckbox = useCallback(() => {
    applyToolbarEdit(toggleCheckbox);
  }, [applyToolbarEdit]);

  /**
   * The same thing for a list-item row: run the transform against the row that
   * holds the caret, then put the caret back.
   *
   * Only the inline markers get here — the bar an item row is given carries no
   * block buttons, because an item is lexed as inline content and would show
   * their output as literal source (docs/specs/markdown-rendering.md §2.1).
   */
  const applyItemToolbarEdit = useCallback(
    (edit: (state: EditorText) => EditorText) => {
      const itemId = focusedItemIdRef.current;
      if (!itemId) return;
      const handle = itemSelectionRefsMap.current.get(itemId)?.current;
      const index = itemsRef.current.findIndex((item) => item.id === itemId);
      if (!handle || index === -1) return;

      const previous = itemsRef.current[index]!.text;
      const next = edit({ text: previous, selection: handle.getSelection() });
      // The markers are characters the user did not type, so a row already at
      // the cap drops the press rather than losing the tail of its text —
      // handleItemTextChange would otherwise truncate it away silently.
      if (exceedsCodePointLimit(next.text, VALIDATION.ITEM_TEXT_MAX_LENGTH)) {
        showToast(t('note.itemLimitReached'), 'error');
        return;
      }

      if (next.text !== previous) handleItemTextChange(index, next.text);
      handle.setSelection(clampSelection(next.selection, next.text));
    },
    [focusedItemIdRef, handleItemTextChange, itemSelectionRefsMap, itemsRef, showToast, t],
  );

  const toggleItemBold = useCallback(() => {
    applyItemToolbarEdit((state) => toggleInlineMarker(state, '**'));
  }, [applyItemToolbarEdit]);

  const toggleItemItalic = useCallback(() => {
    applyItemToolbarEdit((state) => toggleInlineMarker(state, '*'));
  }, [applyItemToolbarEdit]);

  const toggleItemStrikethrough = useCallback(() => {
    applyItemToolbarEdit((state) => toggleInlineMarker(state, '~~'));
  }, [applyItemToolbarEdit]);

  const noteBackground = hasNoteColor ? color : colors.surface;
  const completedSectionDividerColor = hasNoteColor
    ? getCompletedSectionDividerColor(noteBackground)
    : colors.borderLight;

  return (
    <Animated.View style={[StyleSheet.absoluteFill, zoomStyle, zoomRevealed ? null : styles.zoomHidden]}>
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: noteBackground, paddingBottom: androidKeyboardInset }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? IOS_KEYBOARD_VERTICAL_OFFSET : 0}
    >
      <View style={[styles.header, { backgroundColor: noteBackground, borderBottomColor: hasNoteColor ? 'transparent' : colors.borderLight, paddingTop: insets.top + 12 }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          testID="editor-back"
        >
          <ArrowLeft size={24} color={hasNoteColor ? '#1a1a1a' : colors.text} />
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
                {noteType === 'text' ? (
                  <List size={22} color={colors.primary} />
                ) : (
                  <FileText size={22} color={colors.primary} />
                )}
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
          <CircleAlert size={16} color={colors.warningText} />
          <Text style={[styles.failedBarText, { color: colors.warningText }]} numberOfLines={1}>
            {t('syncFailures.editorBanner')}
          </Text>
          <ChevronRight size={16} color={colors.warningText} />
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
            cancelScheduledSave();
            flushSave();
          }}
          testID="save-error-banner"
        >
          <Text style={[styles.errorText, { color: colors.error }]}>{t(saveError)}</Text>
        </TouchableOpacity>
      )}

      {syncToast && (
        <TouchableOpacity
          style={[styles.syncToast, { backgroundColor: colors.warning, borderBottomColor: colors.warningBorder }]}
          onPress={() => setSyncToast(null)}
          testID="sync-toast"
        >
          <Text style={[styles.syncToastText, { color: colors.warningText }]}>{t(syncToast)}</Text>
        </TouchableOpacity>
      )}

      {/* Visible pending state for menu/overflow actions (delete, restore, convert,
          share, manage labels, redirect-share) while the server is reachable but
          the write hasn't resolved yet — the sheet that triggered the action has
          already closed, so this is the only feedback the user gets (#697). */}
      {isMenuActionPending && (
        <View style={[styles.pendingBar, { backgroundColor: colors.surface, borderBottomColor: colors.borderLight }]} testID="menu-action-pending">
          <ActivityIndicator size="small" color={colors.textSecondary} />
          <Text style={[styles.pendingBarText, { color: colors.textSecondary }]}>{t('common.loading')}</Text>
        </View>
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
            autoFocus={!hasCreated}
            placeholder={t('note.titlePlaceholder')}
            placeholderTextColor={hasNoteColor ? '#999' : colors.placeholder}
            returnKeyType="next"
            onSubmitEditing={handleTitleSubmit}
            blurOnSubmit={false}
            editable={!isHydrating && !isReadOnly}
            testID="note-title-input"
          />
        )}

        {noteType === 'text' ? (
          <>
            {isEditingContent && !isReadOnly ? (
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
                selection={forcedSelection ?? undefined}
                onSelectionChange={handleContentSelectionChange}
                textAlignVertical="top"
                editable={!isHydrating}
                testID="note-content-input"
              />
            ) : (
              <TouchableOpacity
                onPress={isReadOnly ? undefined : () => setIsEditingContent(true)}
                disabled={isReadOnly}
                activeOpacity={1}
                testID="content-preview"
                style={styles.contentPreview}
              >
                {content ? (
                  <Markdown content={content} onColoredNote={hasNoteColor} />
                ) : (
                  <Text style={{ color: hasNoteColor ? '#999' : colors.placeholder, fontSize: 14 }}>
                    {t('note.contentPlaceholder')}
                  </Text>
                )}
              </TouchableOpacity>
            )}

            {/* iOS: formatting toolbar as InputAccessoryView (docks above keyboard).
                Same conditions as the Android branch below — the accessory view
                is only reachable while the content input exists. */}
            {Platform.OS === 'ios' && noteType === 'text' && isEditingContent && !isReadOnly && (
              <InputAccessoryView nativeID={MARKDOWN_TOOLBAR_ID}>
                <MarkdownToolbarContent
                  onBold={toggleMobileBold}
                  onItalic={toggleMobileItalic}
                  onStrikethrough={toggleMobileStrikethrough}
                  onHeading={toggleMobileHeading}
                  onBullet={toggleMobileBullet}
                  onCheckbox={toggleMobileCheckbox}
                  backgroundColor={noteBackground}
                  hasNoteColor={hasNoteColor}
                />
              </InputAccessoryView>
            )}
          </>
        ) : (
          <View style={styles.listContainer}>
            <NestedReorderableList<LocalItem>
              data={uncheckedItems}
              // `item` is typed non-optional, but the library reads
              // `data[i]` at drag-start indices while finishing a drop, and
              // those can outlive the row they pointed at (see commitDrag).
              // Falling back to the index — the same fallback the library
              // applies to a missing key — keeps that read from throwing.
              keyExtractor={(item, index) => item?.id ?? String(index)}
              scrollable={false}
              // Inherited from the ScrollViewContainer above rather than
              // defaulted: this list is a FlatList, so it has a ScrollView of its
              // own, and a ScrollView left at the default ('never') captures the
              // responder for any tap that lands on something which is not a
              // TextInput while one is focused — blurring it, dismissing the
              // keyboard, and swallowing the tap. Harmless while every row's tap
              // target *was* its TextInput; not once a rendered row's target is a
              // Text (docs/specs/markdown-rendering.md §1.2), where it cost a
              // first tap on every row-to-row move.
              keyboardShouldPersistTaps="handled"
              shouldUpdateActiveItem
              panGesture={listDragGesture}
              onDragStart={handleListDragStart}
              onReorder={handleListReorder}
              onDragEnd={handleListDragEnd}
              cellAnimations={DRAG_CELL_ANIMATIONS}
              renderItem={renderActiveRow}
              // Slide remaining rows into place when an item is checked off (and
              // moves to the completed section) or deleted. Skipped under the OS
              // Reduce Motion setting, like the editor's other animations.
              itemLayoutAnimation={isReduceMotionEnabledSync() ? undefined : LinearTransition.duration(LIST_REFLOW_ANIM_MS)}
            />

            {!isReadOnly && (
              <TouchableOpacity style={styles.addItemRow} onPress={handleAddItem} testID="add-list-item">
                <Plus size={22} color={colors.primary} />
                <Text style={[styles.addItemText, { color: colors.primary }]}>{t('note.addItem')}</Text>
              </TouchableOpacity>
            )}

            <CheckedItemsSection
              checkedItems={checkedItems}
              items={items}
              itemIndexMap={itemIndexMap}
              collapsed={checkedItemsCollapsed}
              onToggleCollapsed={handleToggleCollapsed}
              getItemRef={getItemRef}
              getItemSelectionRef={getItemSelectionRef}
              itemAccessoryViewID={Platform.OS === 'ios' ? ITEM_MARKDOWN_TOOLBAR_ID : undefined}
              isNoteShared={!!isNoteShared}
              collaborators={collaborators}
              hasNoteColor={hasNoteColor}
              dividerColor={completedSectionDividerColor}
              handlers={listItemHandlers}
              popItemId={popItemId}
              editable={!isReadOnly}
            />

            {/* iOS: the rows' accessory view. Every row carries this nativeID,
                so the bar docks above the keyboard for whichever one is focused
                and no state here has to track which. Inline-only buttons — see
                applyItemToolbarEdit. */}
            {Platform.OS === 'ios' && !isReadOnly && (
              <InputAccessoryView nativeID={ITEM_MARKDOWN_TOOLBAR_ID}>
                <MarkdownToolbarContent
                  onBold={toggleItemBold}
                  onItalic={toggleItemItalic}
                  onStrikethrough={toggleItemStrikethrough}
                  backgroundColor={noteBackground}
                  hasNoteColor={hasNoteColor}
                />
              </InputAccessoryView>
            )}
          </View>
        )}

        {/* Collaborators + labels, mirroring the webapp's single-note view.
            Tapping a collaborator avatar opens the share screen; tapping a
            label chip opens the label picker — the same targets as the overflow
            menu's Share / Labels actions. Shown only for shared and/or labelled
            notes; labels are added on an empty note via the overflow menu.
            Read-only (trashed) notes render it as plain, non-interactive
            display, matching the menu hiding those actions. */}
        {(displayCollaborators.length > 0 || labels.length > 0) && (
          <View style={styles.metaRow} testID="note-meta-row">
            {labels.map((label) => (
              !isReadOnly ? (
                <TouchableOpacity
                  key={label.id}
                  style={[styles.metaLabelChip, { backgroundColor: hasNoteColor ? 'rgba(0,0,0,0.08)' : colors.borderLight }]}
                  onPress={openLabelPicker}
                  testID={`note-meta-label-${label.id}`}
                  accessibilityLabel={`${t('labels.title')}: ${label.name}`}
                >
                  <Text style={[styles.metaLabelText, { color: hasNoteColor ? '#666' : colors.textSecondary }]}>{label.name}</Text>
                </TouchableOpacity>
              ) : (
                <View
                  key={label.id}
                  style={[styles.metaLabelChip, { backgroundColor: hasNoteColor ? 'rgba(0,0,0,0.08)' : colors.borderLight }]}
                >
                  <Text style={[styles.metaLabelText, { color: hasNoteColor ? '#666' : colors.textSecondary }]}>{label.name}</Text>
                </View>
              )
            ))}

            {displayCollaborators.length > 0 && (() => {
              const avatars = displayCollaborators.map((c, index) => (
                <View key={c.userId} style={index === 0 ? undefined : styles.metaAvatarOverlap}>
                  <UserAvatar
                    userId={c.userId}
                    username={c.username}
                    hasProfileIcon={c.hasProfileIcon}
                    iconVersion={c.iconVersion}
                    size="small"
                  />
                </View>
              ));
              // Tappable only when the note can actually be (re)shared: a
              // read-only (trashed) note has no Share action in the menu, so
              // its avatars stay a plain, non-interactive display too.
              return canShareWithCollaborators && !isReadOnly ? (
                <TouchableOpacity
                  style={styles.metaAvatars}
                  onPress={openShareScreen}
                  testID="note-meta-collaborators"
                  accessibilityLabel={t('note.share')}
                >
                  {avatars}
                </TouchableOpacity>
              ) : (
                <View style={styles.metaAvatars} testID="note-meta-collaborators">
                  {avatars}
                </View>
              );
            })()}
          </View>
        )}
      </ScrollViewContainer>

      {/* Android: formatting toolbar fixed directly above the action bar below
          (shown when editing), rather than inline in the scrollable content
          where its position would drift with the content length. */}
      {Platform.OS === 'android' && noteType === 'text' && isEditingContent && !isReadOnly && (
        <MarkdownToolbarContent
          onBold={toggleMobileBold}
          onItalic={toggleMobileItalic}
          onStrikethrough={toggleMobileStrikethrough}
          onHeading={toggleMobileHeading}
          onBullet={toggleMobileBullet}
          onCheckbox={toggleMobileCheckbox}
          backgroundColor={noteBackground}
          hasNoteColor={hasNoteColor}
        />
      )}

      {/* Android: the list's bar, in the same slot as the content one above and
          on the same terms — shown while a row holds the caret, since that is
          the only time there is text for it to act on. iOS gets this from the
          accessory view instead. */}
      {Platform.OS === 'android' && noteType === 'list' && isEditingItem && !isReadOnly && (
        <MarkdownToolbarContent
          onBold={toggleItemBold}
          onItalic={toggleItemItalic}
          onStrikethrough={toggleItemStrikethrough}
          backgroundColor={noteBackground}
          hasNoteColor={hasNoteColor}
        />
      )}

      <View style={[styles.toolbar, { backgroundColor: noteBackground, borderTopColor: hasNoteColor ? 'transparent' : colors.border, paddingBottom: insets.bottom || 8 }]}>
        {/* Color. Works on unsaved notes (deferred via autosave), so it is only
            disabled for read-only (trashed) notes. */}
        <TouchableOpacity
          onPress={() => setColorPickerVisible(true)}
          disabled={isReadOnly}
          style={styles.toolbarBtn}
          testID="toolbar-color-btn"
          accessibilityLabel={t('note.changeColor')}
          accessibilityState={{ disabled: isReadOnly }}
        >
          <Palette size={22} color={isReadOnly ? disabledBarIconColor : barIconColor} />
        </TouchableOpacity>

        {/* Add image. Needs a server-backed note, so a brand-new note is saved
            first via withSavedNote before the picker opens — no draft/orphan
            upload is ever created (spec §15.6). Only read-only (trashed) notes
            disable it. Offline uploads are queued and flushed on reconnect
            (#618). */}
        <TouchableOpacity
          onPress={() => withSavedNote(() => setAddImageSheetVisible(true))}
          disabled={isReadOnly}
          style={styles.toolbarBtn}
          testID="toolbar-add-image-btn"
          accessibilityLabel={t('images.addImage')}
          accessibilityState={{ disabled: isReadOnly }}
        >
          <Image size={22} color={isReadOnly ? disabledBarIconColor : barIconColor} />
        </TouchableOpacity>

        {/* Pin / Unpin. Save-first: an unsaved note is created before pinning. */}
        <TouchableOpacity
          onPress={handleTogglePin}
          disabled={isReadOnly}
          style={styles.toolbarBtn}
          testID="toolbar-pin-btn"
          accessibilityLabel={pinned ? t('note.unpin') : t('note.pin')}
          accessibilityState={{ disabled: isReadOnly }}
        >
          <Pin size={22} color={isReadOnly ? disabledBarIconColor : (pinned ? colors.primary : barIconColor)} fill={pinned ? colors.primary : 'none'} />
        </TouchableOpacity>

        {/* Archive / Unarchive. Save-first, like Pin. */}
        <TouchableOpacity
          onPress={handleToggleArchive}
          disabled={isReadOnly}
          style={styles.toolbarBtn}
          testID="toolbar-archive-btn"
          accessibilityLabel={archived ? t('note.unarchive') : t('note.archive')}
          accessibilityState={{ disabled: isReadOnly }}
        >
          <Archive
            size={22}
            color={isReadOnly ? disabledBarIconColor : (archived ? colors.primary : barIconColor)}
          />
        </TouchableOpacity>

        <View style={styles.toolbarSpacer} />

        {/* Overflow menu: Send / Share / Duplicate / Labels / Delete for a normal
            note, or Restore / Delete-forever for a read-only trashed note.
            Disabled while a previous menu action is still pending so a second
            tap can't fire a concurrent action (#697). */}
        <TouchableOpacity
          onPress={() => setMenuVisible(true)}
          disabled={isMenuActionPending}
          style={styles.toolbarBtn}
          testID="toolbar-menu-btn"
          accessibilityLabel={t('note.menuOptions')}
          accessibilityState={{ disabled: isMenuActionPending }}
        >
          <EllipsisVertical size={22} color={isMenuActionPending ? disabledBarIconColor : barIconColor} />
        </TouchableOpacity>
      </View>

      <NoteEditorMenu
        visible={menuVisible}
        onClose={() => setMenuVisible(false)}
        trashed={isReadOnly}
        title={noteType === 'list' ? title : undefined}
        noteType={noteType}
        onSend={handleNativeShare}
        onShare={canShareWithCollaborators ? openShareScreen : undefined}
        onDuplicate={handleDuplicate}
        onConvert={handleConvertNoteType}
        onManageLabels={openLabelPicker}
        onUncheckAllItems={noteType === 'list' && checkedItems.length > 0 ? handleUncheckAllItems : undefined}
        onDeleteCheckedItems={noteType === 'list' && checkedItems.length > 0 ? handleDeleteCompletedItems : undefined}
        onMoveToTrash={handleDelete}
        onRestore={handleRestoreNote}
        onDeletePermanently={handleDeletePermanently}
      />

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

      <ConfirmDialog
        visible={!!exitSavePrompt}
        title={t('note.saveFailedExitTitle')}
        message={t('note.saveFailedExitMessage')}
        confirmLabel={t('note.discardAndLeave')}
        destructive
        cancelLabel={exitSavePrompt && exitSavePrompt.retriesLeft > 0 ? t('common.retry') : undefined}
        onCancel={exitSavePrompt && exitSavePrompt.retriesLeft > 0 ? handleExitRetry : undefined}
        onConfirm={handleExitDiscard}
        busy={isExitRetrying}
        dismissible={false}
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
                  <Check size={18} color={colors.primary} />
                )}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </KeyboardAvoidingView>
    </Animated.View>
  );
}
