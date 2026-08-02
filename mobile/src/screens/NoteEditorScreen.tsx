import React, { useState, useEffect, useRef, useCallback, useMemo, useContext } from 'react';
import axios from 'axios';
import {
  Animated,
  Easing,
  View,
  Text,
  TextInput,
  ScrollView,
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
  type TextInputProps,
  type TextInputSelectionChangeEventData,
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
import { Archive, ArrowLeft, Check, ChevronRight, CircleAlert, EllipsisVertical, FileText, Image, List, Palette, Pin, Plus } from 'lucide-react-native';
import { useNavigation, useRoute, RouteProp, type NavigationAction } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { useCreateNote, useUpdateNote, useDeleteNote, useRestoreNote, usePermanentDeleteNote, useDuplicateNote, useConvertNoteType, useCreateNoteItem, useUpdateNoteItem, useDeleteNoteItem, useReorderNoteItems, useToggleNoteItemCompleted, useUncheckAllItems, useDeleteCompletedItems } from '../hooks/useNotes';
import { useOfflineNote } from '../hooks/useOfflineNotes';
import { useKeyboardHeight } from '../hooks/useKeyboardHeight';
import { useFailedNoteIds } from '../store/OfflineContext';
import { useSSESubscription } from '../store/SSEContext';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import ConfirmDialog from '../components/ConfirmDialog';
import ColorPicker from '../components/ColorPicker';
import LabelPicker from '../components/LabelPicker';
import AssigneePicker from '../components/AssigneePicker';
import AddImageActionSheet from '../components/AddImageActionSheet';
import { useUploadNoteImage, useDeleteNoteImage } from '../hooks/useNoteImages';
import { usePendingImageUploads, useRetryPendingImageUpload, useDismissPendingImageUpload } from '../hooks/usePendingImageUploads';
import type { ImageUploadFile } from '../api/images';
import { buildCollaborators, generateId, VALIDATION, IMAGE_MAX_PER_NOTE, exceedsCodePointLimit, truncateToCodePoints, type Collaborator, type NoteType, type NoteImage, type CreateNoteRequest, type UpdateNoteRequest, type UpdateListNoteRequest, type UpdateTextNoteRequest, type PatchNoteItemRequest, type Label } from '@jot/shared';
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
import { isServerReachable } from '../api/serverReachability';
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
import {
  clampSelection,
  continueListOnNewline,
  cycleHeading,
  toggleBullet,
  toggleCheckbox,
  toggleInlineMarker,
  type EditorText,
  type TextSelection,
} from './noteEditor/markdownEdits';
import CheckedItemsSection, { type ListItemHandlers } from './noteEditor/CheckedItemsSection';
import NoteEditorMenu from '../components/NoteEditorMenu';
import NoteImageGallery, { type PendingImageUpload } from '../components/NoteImageGallery';
import UserAvatar from '../components/UserAvatar';
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
// Menu-action pending bar: only show it once an action has been in flight for
// this long, so fast actions never flash it; and once shown, keep it up for at
// least the min-visible window so it can't blink out a frame later.
const PENDING_BAR_DELAY_MS = 600;
const PENDING_BAR_MIN_VISIBLE_MS = 300;
// Duration of the zoom-open / zoom-closed transform animation.
const ZOOM_MS = 280;
// Override the reorderable list's default cell animation so the dragged row is
// fully static apart from following the finger: opacity stays 1 and no scale is
// applied. The library's default opacity/scale animations could otherwise stick
// after a drop and leave the row greyed out or enlarged. Module-scoped so the
// reference stays stable across renders.
const DRAG_CELL_ANIMATIONS = { opacity: 1, transform: [] };

// Re-inserts each id in `idsToRestore` back into `currentIds`, anchored right
// after its nearest still-present predecessor in `originalOrder` (or at the
// start, if none precedes it). Used to revert a failed bulk delete: reverting
// to a stale full snapshot would also discard any edit or addition made to
// *other* items while the request was in flight, so instead only the deleted
// ids are restored, on top of whatever `currentIds` has become by the time
// the failure is handled.
function reinsertIds(currentIds: string[], originalOrder: string[], idsToRestore: Set<string>): string[] {
  const present = new Set(currentIds);
  const result = [...currentIds];
  for (let i = 0; i < originalOrder.length; i++) {
    const id = originalOrder[i];
    if (!idsToRestore.has(id)) continue;
    let anchor: string | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (present.has(originalOrder[j])) {
        anchor = originalOrder[j];
        break;
      }
    }
    const insertAt = anchor ? result.indexOf(anchor) + 1 : 0;
    result.splice(insertAt, 0, id);
    present.add(id);
  }
  return result;
}

export default function NoteEditorScreen() {
  const navigation = useNavigation<EditorNavProp>();
  const route = useRoute<EditorRouteProp>();
  const { noteId: initialNoteId, sharedText, initialNoteType, readOnly, originRect, originColor } = route.params;
  const { t, i18n } = useTranslation();
  const failedNoteIds = useFailedNoteIds();

  // A new note opened from a share intent arrives with sharedText to pre-fill
  // the body.
  const openedFromShare = initialNoteId === null && !!sharedText;
  // A new list opened from the "New list" app-icon quick action: start in list
  // mode and focus the title so the keyboard comes up ready to type.
  const openedAsNewList = initialNoteId === null && initialNoteType === 'list';

  const [noteId, setNoteId] = useState<string | null>(initialNoteId);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState(() => (initialNoteId === null ? sharedText ?? '' : ''));
  const [noteType, setNoteType] = useState<NoteType>(() => (initialNoteId === null && initialNoteType ? initialNoteType : 'text'));
  const [items, setItems] = useState<LocalItem[]>([]);
  const [checkedItemsCollapsed, setCheckedItemsCollapsed] = useState(false);
  // Id of the item the user just checked off, so its completed-section row pops
  // on mount. Cleared shortly after so a later collapse/expand doesn't re-pop.
  const [popItemId, setPopItemId] = useState<string | null>(null);
  const popClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (popClearRef.current) clearTimeout(popClearRef.current); }, []);
  const [pinned, setPinned] = useState(false);
  const [archived, setArchived] = useState(false);
  // Seed from the tapped card's color (passed as a nav param) so a zoom-open
  // shows the note's background immediately; hydration below sets the
  // authoritative value. Falls back to white for new notes / direct opens.
  const [color, setColor] = useState(originColor || '#ffffff');
  const [labels, setLabels] = useState<Label[]>([]);
  const [hasCreated, setHasCreated] = useState(initialNoteId !== null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [colorPickerVisible, setColorPickerVisible] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [labelPickerVisible, setLabelPickerVisible] = useState(false);
  const [assigneePickerVisible, setAssigneePickerVisible] = useState(false);
  const [assigningItemId, setAssigningItemId] = useState<string | null>(null);
  const [syncToast, setSyncToast] = useState<string | null>(null);
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
  // A trashed note opens view-only. Driven by the route param set when the note
  // is opened from the trash list, and defensively by the note's own deleted_at
  // in case it lands here already trashed.
  const isReadOnly = readOnly === true || existingNote?.deleted_at != null;
  const createMutation = useCreateNote();
  const updateMutation = useUpdateNote();
  const deleteMutation = useDeleteNote();
  const restoreMutation = useRestoreNote();
  const permanentDeleteMutation = usePermanentDeleteNote();
  const duplicateMutation = useDuplicateNote();
  const convertMutation = useConvertNoteType();
  const createItemMutation = useCreateNoteItem();
  const updateItemMutation = useUpdateNoteItem();
  const deleteItemMutation = useDeleteNoteItem();
  const reorderItemsMutation = useReorderNoteItems();
  const toggleItemCompletedMutation = useToggleNoteItemCompleted();
  const uncheckAllItemsMutation = useUncheckAllItems();
  const deleteCompletedItemsMutation = useDeleteCompletedItems();
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

  // Auto-dismiss sync toast after 4 seconds
  useEffect(() => {
    if (!syncToast) return;
    const timer = setTimeout(() => setSyncToast(null), 4000);
    return () => clearTimeout(timer);
  }, [syncToast]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- pre-existing, tracked in #777
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
  // True for the whole duration of a zoom-close animation, from the moment an
  // exit action commits to closing until it actually dispatches the
  // navigation action. intentionalExitRef is only set at that final instant
  // (not up front) so a concurrent back press mid-animation still hits
  // beforeRemove; it's swallowed via this flag instead of falling through to
  // a second, unguarded pop.
  const isClosingRef = useRef(false);
  const hasPendingChangesRef = useRef(false);
  const [exitSavePrompt, setExitSavePrompt] = useState<{
    navAction: NavigationAction;
    wantsZoom: boolean;
    retriesLeft: number;
  } | null>(null);
  const [isExitRetrying, setIsExitRetrying] = useState(false);
  // Visible pending state for menu/overflow actions (delete, restore, convert,
  // share, manage labels, redirect-share) while they await a write. The sheet
  // that triggered them has already closed, so without this the screen would
  // otherwise sit with no feedback for up to the write timeout on the first
  // action of a fresh outage (issue #697).
  const [isMenuActionPending, setIsMenuActionPending] = useState(false);
  // Bumped on every edit (markDirtyAndScheduleUpdate). flushSave snapshots it
  // alongside the state refs so it can tell whether new edits arrived while its
  // network calls were in flight — clearing the dirty flag then would mark
  // those edits clean without ever saving them.
  const editSeqRef = useRef(0);
  const saveInFlightRef = useRef<Promise<boolean> | null>(null);
  // Guards the metadata PATCH path (pin/archive/color) the same way
  // saveInFlightRef guards the body/items save: those updates go through
  // useUpdateNote directly (not flushSave), so they don't touch saveInFlightRef.
  // While one is in flight the refresh effect must not re-apply a (possibly
  // stale) refetch and revert the optimistic pin/archive/color.
  const metadataUpdateInFlightRef = useRef(false);
  const requiresHydrationRef = useRef(initialNoteId !== null);

  // Warn when another user updates this note *while we have unsaved edits*.
  // A clean editor auto-applies the remote change (see the refresh effect
  // below), so no warning is needed there; when the editor is dirty that
  // refresh is intentionally suppressed to protect the in-progress edits, so
  // this banner is the only signal that the note has diverged on the server.
  useSSESubscription(noteId, useCallback(() => {
    if (!hasPendingChangesRef.current) return;
    setSyncToast((prev) => prev ?? t('note.updatedByAnotherUser'));
  }, [t]));

  // Refs for current state to avoid stale closures in debounced save
  const noteIdRef = useRef(noteId);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  noteIdRef.current = noteId;
  const noteTypeRef = useRef(noteType);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  noteTypeRef.current = noteType;
  const titleRef = useRef(title);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  titleRef.current = title;
  const contentRef = useRef(content);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  contentRef.current = content;
  const itemsRef = useRef(items);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  itemsRef.current = items;
  const checkedItemsCollapsedRef = useRef(checkedItemsCollapsed);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  checkedItemsCollapsedRef.current = checkedItemsCollapsed;
  const pinnedRef = useRef(pinned);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  pinnedRef.current = pinned;
  const archivedRef = useRef(archived);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  archivedRef.current = archived;
  const colorRef = useRef(color);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  colorRef.current = color;

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
  }, [animateClose, navigation]);

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
  const createMutateRef = useRef(createMutation.mutateAsync);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  createMutateRef.current = createMutation.mutateAsync;
  const updateMutateRef = useRef(updateMutation.mutateAsync);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  updateMutateRef.current = updateMutation.mutateAsync;
  const createItemRef = useRef(createItemMutation.mutateAsync);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  createItemRef.current = createItemMutation.mutateAsync;
  const updateItemRef = useRef(updateItemMutation.mutateAsync);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  updateItemRef.current = updateItemMutation.mutateAsync;
  const deleteItemRef = useRef(deleteItemMutation.mutateAsync);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  deleteItemRef.current = deleteItemMutation.mutateAsync;
  const reorderItemsRef = useRef(reorderItemsMutation.mutateAsync);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  reorderItemsRef.current = reorderItemsMutation.mutateAsync;
  const toggleItemCompletedRef = useRef(toggleItemCompletedMutation.mutateAsync);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  toggleItemCompletedRef.current = toggleItemCompletedMutation.mutateAsync;
  const uncheckAllItemsRef = useRef(uncheckAllItemsMutation.mutateAsync);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  uncheckAllItemsRef.current = uncheckAllItemsMutation.mutateAsync;
  const deleteCompletedItemsRef = useRef(deleteCompletedItemsMutation.mutateAsync);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  deleteCompletedItemsRef.current = deleteCompletedItemsMutation.mutateAsync;

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
    const error = validateImageFileRaw(file);
    if (error === 'wrongType') return t('images.errorWrongType');
    if (error === 'tooLarge') return t('images.errorTooLarge', { maxMB: IMAGE_MAX_MB });
    return null;
  }, [t]);

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
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  isHydratingRef.current = initialNoteId !== null && !existingNote;

  const titleInputRef = useRef<TextInputType>(null);
  const contentInputRef = useRef<TextInputType>(null);
  // Where the caret sits in the content input. The formatting bar edits text
  // around it, so it has to be tracked even though the input is otherwise
  // uncontrolled with respect to selection.
  const contentSelectionRef = useRef<TextSelection>({ start: 0, end: 0 });
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

  // Applies a note from the offline cache to the editor's local state and
  // re-seeds the save baseline. Used both for the initial hydration and to
  // refresh the editor when the note changes underneath it (see below).
  const applyNoteToState = useCallback((note: NonNullable<typeof existingNote>) => {
    setNoteType(note.note_type);
    setPinned(note.pinned);
    setArchived(note.archived);
    setColor(note.color);
    setLabels(note.labels ?? []);
    let nextItems: LocalItem[] = [];
    if (note.note_type === 'list') {
      setTitle(note.title);
      setCheckedItemsCollapsed(note.checked_items_collapsed);
      nextItems = note.items ? toLocalItems(note.items) : [];
      setItems(nextItems);
    } else {
      setContent(note.content);
    }
    // Seed the save baseline from the note so the next edit diffs against this
    // state rather than re-sending everything.
    savedScalarsRef.current = {
      title: note.note_type === 'list' ? note.title : '',
      content: note.note_type === 'text' ? note.content : '',
      pinned: note.pinned,
      archived: note.archived,
      color: note.color,
      checked_items_collapsed: note.note_type === 'list' ? note.checked_items_collapsed : false,
    };
    savedItemsRef.current = new Map(nextItems.map((it) => [it.id, itemSnapshot(it)]));
    savedOrderRef.current = nextItems.map((it) => it.id);
  }, []);

  // Load existing note data (once, on first hydration).
  useEffect(() => {
    if (existingNote && !isInitializedRef.current) {
      applyNoteToState(existingNote);
      isInitializedRef.current = true;
      requiresHydrationRef.current = false;
    }
  }, [existingNote, applyNoteToState]);

  // Refresh the editor when the note changes underneath it — most visibly when
  // another user edits a shared note, which arrives via SSE → SQLite → this
  // query refetching and surfaces the "updated by another user" banner. Without
  // this, the banner showed but the checklist/content stayed stale.
  //
  // Only refresh when the editor has no unsaved edits and no save (body/items
  // or metadata) is in flight: a clean editor mirrors the last-saved baseline,
  // so replacing it with the newer note loses nothing. When the user has
  // in-progress edits we keep their state intact (the banner alone signals the
  // remote change) rather than risk clobbering them, since there is no
  // field-level merge here.
  useEffect(() => {
    if (
      existingNote
      && isInitializedRef.current
      && !hasPendingChangesRef.current
      && saveInFlightRef.current === null
      && !metadataUpdateInFlightRef.current
    ) {
      applyNoteToState(existingNote);
    }
  }, [existingNote, applyNoteToState]);

  // Keep labels in sync when note data refreshes after label mutations, even
  // while the body has unsaved edits (labels are edited via their own picker
  // and don't participate in the body's save baseline, so the refresh above
  // may be skipped as dirty). Redundant with that refresh when the editor is
  // clean, but idempotent.
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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- pre-existing, tracked in #777
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

  // Runs `fn`, showing the menu-action pending indicator only while the server
  // is believed reachable. When it's already known unreachable, the write
  // underneath skips the network entirely (isOnlineWriteAllowed) and resolves
  // near-instantly, so no indicator is needed — the action already feels
  // immediate. When reachable (including the stale-true case on the very first
  // request of a fresh outage), the write may genuinely block for up to the
  // write timeout, so surface that wait instead of leaving the screen looking
  // frozen (issue #697).
  //
  // The bar is shown on a delay, not immediately: a fast action (the common
  // case — an existing note with no pending edits) finishes before
  // PENDING_BAR_DELAY_MS and never surfaces the bar at all, so it no longer
  // flashes in and shoves the note down. Once the bar does appear it stays up
  // for at least PENDING_BAR_MIN_VISIBLE_MS, so an action finishing just past
  // the delay threshold doesn't produce a one-frame blink either.
  //
  // pendingCountRef tracks overlapping calls (e.g. Pin and Archive tapped in
  // quick succession). The indicator's show-delay is armed once while any call
  // is pending, and it only hides once every in-flight call has finished, so
  // one call's finally doesn't hide the bar while a sibling is still awaiting
  // its write.
  const pendingCountRef = useRef(0);
  const pendingDelayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timestamp (ms) at which the bar became visible, or 0 while it is hidden.
  const pendingShownAtRef = useRef(0);
  const withPendingIndicator = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    const showPending = isServerReachable();
    if (showPending) {
      pendingCountRef.current += 1;
      // A fresh action cancels any in-flight min-visible hide: the bar should
      // stay up (or appear) rather than blink off between back-to-back actions.
      if (pendingHideTimerRef.current) {
        clearTimeout(pendingHideTimerRef.current);
        pendingHideTimerRef.current = null;
      }
      // Arm the delayed show once, only while the bar isn't already visible.
      if (pendingShownAtRef.current === 0 && pendingDelayTimerRef.current === null) {
        pendingDelayTimerRef.current = setTimeout(() => {
          pendingDelayTimerRef.current = null;
          if (pendingCountRef.current > 0 && isMountedRef.current) {
            pendingShownAtRef.current = Date.now();
            setIsMenuActionPending(true);
          }
        }, PENDING_BAR_DELAY_MS);
      }
    }
    try {
      return await fn();
    } finally {
      if (showPending) {
        pendingCountRef.current -= 1;
        if (pendingCountRef.current === 0) {
          if (pendingDelayTimerRef.current !== null) {
            // Finished before the delay elapsed — the bar never showed, so just
            // cancel the pending show.
            clearTimeout(pendingDelayTimerRef.current);
            pendingDelayTimerRef.current = null;
          } else if (pendingShownAtRef.current > 0) {
            // The bar is visible — keep it up for the remainder of the minimum
            // visible window so it doesn't blink out.
            const remaining = PENDING_BAR_MIN_VISIBLE_MS - (Date.now() - pendingShownAtRef.current);
            const hide = () => {
              pendingHideTimerRef.current = null;
              pendingShownAtRef.current = 0;
              if (isMountedRef.current) setIsMenuActionPending(false);
            };
            if (remaining <= 0) hide();
            else pendingHideTimerRef.current = setTimeout(hide, remaining);
          }
        }
      }
    }
  }, []);

  // Clear the menu-action pending bar's show/hide timers on unmount so a timer
  // armed just before the screen closed can't fire a state update afterwards.
  // Kept as its own mount/unmount-only effect (empty deps) rather than folded
  // into the flush-on-unmount effect below, whose dependency changes on every
  // render and would otherwise clear a live show-delay before it could fire.
  useEffect(() => () => {
    if (pendingDelayTimerRef.current) clearTimeout(pendingDelayTimerRef.current);
    if (pendingHideTimerRef.current) clearTimeout(pendingHideTimerRef.current);
  }, []);

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
  }, [activeShareServerId, deleteMutation, withPendingIndicator]);

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
  }, [flushPendingChanges, withPendingIndicator]);

  // Keep input refs bounded to currently rendered items.
  useEffect(() => {
    const activeItemIds = new Set(items.map((item) => item.id));
    for (const id of itemInputRefsMap.current.keys()) {
      if (!activeItemIds.has(id)) {
        itemInputRefsMap.current.delete(id);
      }
    }
  }, [items]);

  // Mark the exit as intentional (so beforeRemove doesn't re-handle it) only
  // once the navigation action is about to dispatch, optionally zooming back
  // onto the originating card first. isClosingRef is set immediately instead,
  // so a back press that lands mid-animation still hits beforeRemove and gets
  // swallowed there rather than falling through to an unguarded second pop.
  const exitWith = useCallback((navAction: NavigationAction, wantsZoom: boolean) => {
    setExitSavePrompt(null);
    const dispatch = () => {
      intentionalExitRef.current = true;
      navigation.dispatch(navAction);
    };
    if (wantsZoom) {
      isClosingRef.current = true;
      void animateClose().then(dispatch);
    } else {
      dispatch();
    }
  }, [animateClose, navigation]);

  // Flush pending edits without blocking navigation — used when we deliberately
  // let the user leave (server known-unreachable) and on an unexpected unmount.
  // flushSave(true) still reports failure via its return value even though its
  // `unmounting` guard suppresses the in-editor error banner (the editor is on
  // its way out), so a genuine background-save failure would otherwise vanish
  // silently. Surface it with a global toast, which outlives this screen.
  //
  // showToast is read through a ref so this callback's identity tracks only
  // flushSave — matching the unmount-flush effect's original `[flushSave]`
  // dependency exactly. (A direct showToast dependency would let an unstable
  // toast identity re-run that effect, and re-fire the flush, on every render.)
  const showToastRef = useRef(showToast);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  showToastRef.current = showToast;
  const flushInBackground = useCallback(() => {
    void flushSave(true)
      .then((saved) => {
        if (!saved) showToastRef.current(t('note.failedSaveChanges'), 'error');
      })
      .catch(() => showToastRef.current(t('note.failedSaveChanges'), 'error'));
  }, [flushSave, t]);

  // Intercept navigation away to flush pending edits before leaving, and to play
  // the zoom-back-onto-the-card animation for back navigation.
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (event) => {
      // Programmatic exits (delete/archive/duplicate) already set this and run
      // their own zoom/goBack, so don't re-handle them here.
      if (intentionalExitRef.current) {
        return;
      }
      // A zoom-close animation from this or another exit action is already
      // playing — swallow this concurrent attempt so it doesn't pop an extra
      // screen once that animation finishes and dispatches its own action.
      if (isClosingRef.current) {
        event.preventDefault();
        return;
      }
      const action = event.data.action;
      const isBack = action.type === 'GO_BACK' || action.type === 'POP';
      // Zoom back onto the card for any back navigation (header button or
      // hardware back; the swipe gesture is disabled). Other removals fall
      // through to an instant dispatch.
      const wantsZoom = isBack && zoomEnabled;
      const hasPending = hasPendingChangesRef.current;
      if (!hasPending && !wantsZoom) {
        return;
      }
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }

      // No pending edits: nothing to save. Zoom back onto the card (a non-zoom
      // back nav without pending edits already returned above).
      if (!hasPending) {
        event.preventDefault();
        exitWith(action, wantsZoom);
        return;
      }

      // Server known-unreachable: an online write would only stall for the
      // request timeout before falling back to the local-persist + queue path,
      // so there is nothing to wait for. Flush in the background and let the exit
      // proceed — blocking here is what made leaving a note with unsaved edits
      // feel frozen while the server was down. The edit stays durable: flushSave
      // writes it to the local DB and enqueues it for replay. Mark the exit
      // intentional so the unmount cleanup below doesn't flush a second time; when
      // a zoom-back is wanted we still preventDefault and drive it via exitWith.
      if (!isServerReachable()) {
        intentionalExitRef.current = true;
        flushInBackground();
        if (wantsZoom) {
          event.preventDefault();
          exitWith(action, wantsZoom);
        }
        return;
      }

      // Server reachable: await the save so a genuine, non-queueable failure
      // (validation/conflict) can still prompt Retry/Discard instead of silently
      // dropping the edit. A reachable server responds promptly, so this path no
      // longer reintroduces the long stall.
      event.preventDefault();
      void (async () => {
        const saveSucceeded = await flushSave();
        if (!saveSucceeded) {
          setExitSavePrompt({ navAction: action, wantsZoom, retriesLeft: MAX_EXIT_SAVE_RETRIES });
          return;
        }
        exitWith(action, wantsZoom);
      })();
    });
    return unsubscribe;
  }, [exitWith, flushSave, flushInBackground, navigation, zoomEnabled]);

  const handleExitDiscard = useCallback(() => {
    if (!exitSavePrompt || isExitRetrying) return;
    exitWith(exitSavePrompt.navAction, exitSavePrompt.wantsZoom);
  }, [exitSavePrompt, exitWith, isExitRetrying]);

  // Guarded by isExitRetrying so a retry in flight can't race a second tap on
  // Retry or Discard into a double dispatch or a stale retriesLeft update —
  // the dialog also disables both buttons via `busy` while this is true.
  const handleExitRetry = useCallback(async () => {
    if (!exitSavePrompt || isExitRetrying) return;
    setIsExitRetrying(true);
    const { navAction, wantsZoom, retriesLeft } = exitSavePrompt;
    const retrySucceeded = await flushSave();
    if (retrySucceeded) {
      exitWith(navAction, wantsZoom);
    } else {
      setExitSavePrompt({ navAction, wantsZoom, retriesLeft: retriesLeft - 1 });
    }
    setIsExitRetrying(false);
  }, [exitSavePrompt, exitWith, flushSave, isExitRetrying]);

  // Flush pending save on unmount (prevent data loss), skip if intentionally exiting
  useEffect(() => {
    isMountedRef.current = true;
    // Captured once: the ref's Map identity never changes across the
    // component's lifetime (only mutated in place), so reading it here and
    // using it in the cleanup below sees the same, up-to-date entries.
    const uploadAbortControllers = imageUploadAbortControllersRef.current;
    return () => {
      isMountedRef.current = false;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (!intentionalExitRef.current && hasPendingChangesRef.current) {
        flushInBackground();
      }
      // Abort any uploads still in flight so they don't keep running in the
      // background for up to the full timeout and fire state updates after
      // this screen has unmounted (issue #695).
      for (const controller of uploadAbortControllers.values()) {
        controller.abort();
      }
      uploadAbortControllers.clear();
    };
  }, [flushInBackground]);

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
    [markDirtyAndScheduleUpdate],
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

  // Unchecks every currently-completed item in one bulk request (overflow
  // menu). Non-destructive and easy to redo by hand, so no confirmation.
  const handleUncheckAllItems = useCallback(async () => {
    const noteId = noteIdRef.current;
    const before = itemsRef.current;
    const completed = before.filter((item) => item.completed);
    if (completed.length === 0) return;
    const ids = completed.map((item) => item.id);

    const optimistic = before.map((item) => (item.completed ? { ...item, completed: false } : item));
    itemsRef.current = optimistic;
    setItems(optimistic);

    if (!noteId) {
      // Unsaved new note: let the bulk-create carry the completed flags.
      markDirtyAndScheduleUpdate();
      return;
    }

    await withPendingIndicator(async () => {
      try {
        const serverItems = await uncheckAllItemsRef.current({ noteId, itemIds: ids });
        if (serverItems.length > 0) {
          const completedById = new Map(serverItems.map((item) => [item.id, item.completed]));
          const reconciled = itemsRef.current.map((item) => {
            const c = completedById.get(item.id);
            return c === undefined ? item : { ...item, completed: c };
          });
          itemsRef.current = reconciled;
          setItems(reconciled);
          for (const [id, comp] of completedById) {
            const snap = savedItemsRef.current.get(id);
            if (snap) savedItemsRef.current.set(id, { ...snap, completed: comp });
          }
        } else {
          // Offline: the local write already applied the uncheck; advance the
          // save baseline so the diff engine does not re-patch it later.
          for (const id of ids) {
            const snap = savedItemsRef.current.get(id);
            if (snap) savedItemsRef.current.set(id, { ...snap, completed: false });
          }
        }
      } catch {
        const reverted = itemsRef.current.map((item) => (ids.includes(item.id) ? { ...item, completed: true } : item));
        itemsRef.current = reverted;
        setItems(reverted);
        setSaveError(t('note.failedSaveChanges'));
      }
    });
  }, [markDirtyAndScheduleUpdate, t, withPendingIndicator]);

  // Deletes every currently-completed item after a confirm dialog (overflow
  // menu); mobile has no in-editor undo-bar equivalent to the web's
  // deferred-delete flow, so this confirms up front instead. Deleting exactly
  // the completed set never orphans a child: the completed-cascade invariant
  // (applyCompletedCascade / collectToggleCascade) guarantees a completed
  // parent's children are completed too, so they are always in the same set.
  const handleDeleteCompletedItems = useCallback(async () => {
    const pendingCount = itemsRef.current.filter((item) => item.completed).length;
    if (pendingCount === 0) return;

    const confirmed = await confirm({
      title: t('note.deleteCheckedItems'),
      message: t('note.deleteCheckedItemsConfirm', { count: pendingCount }),
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!confirmed) return;

    const before = itemsRef.current;
    const completed = before.filter((item) => item.completed);
    if (completed.length === 0) return;
    const ids = completed.map((item) => item.id);
    const idSet = new Set(ids);
    const remaining = before.filter((item) => !item.completed);
    const beforeSavedItems = new Map(savedItemsRef.current);
    const beforeSavedOrder = [...savedOrderRef.current];

    itemsRef.current = remaining;
    setItems(remaining);
    for (const id of ids) savedItemsRef.current.delete(id);
    savedOrderRef.current = savedOrderRef.current.filter((id) => !idSet.has(id));

    const noteId = noteIdRef.current;
    if (!noteId) {
      // Unsaved new note: let the bulk-create carry what's left in `items`.
      markDirtyAndScheduleUpdate();
      return;
    }

    await withPendingIndicator(async () => {
      try {
        await deleteCompletedItemsRef.current({ noteId, itemIds: ids });
      } catch {
        // Restore only the deleted items, on top of whatever itemsRef.current
        // has become since — an edit or addition made to another item while
        // the request was in flight must survive the revert, not just the
        // stale `before` snapshot.
        const byId = new Map(before.map((item) => [item.id, item]));
        const revertedIds = reinsertIds(itemsRef.current.map((item) => item.id), before.map((item) => item.id), idSet);
        const currentById = new Map(itemsRef.current.map((item) => [item.id, item]));
        const reverted = revertedIds.map((id) => currentById.get(id) ?? byId.get(id)!);
        itemsRef.current = reverted;
        setItems(reverted);

        for (const id of ids) {
          const snap = beforeSavedItems.get(id);
          if (snap) savedItemsRef.current.set(id, snap);
        }
        savedOrderRef.current = reinsertIds(savedOrderRef.current, beforeSavedOrder, idSet);

        setSaveError(t('note.failedSaveChanges'));
      }
    });
  }, [confirm, markDirtyAndScheduleUpdate, t, withPendingIndicator]);

  const handleItemTextChange = useCallback(
    (index: number, text: string) => {
      if (!text.includes('\n')) {
        // Clamp like the paste paths below: the server rejects longer item text
        // with a 400, which would wedge the save (or dead-letter it offline).
        const clamped = truncateToCodePoints(text, VALIDATION.ITEM_TEXT_MAX_LENGTH);
        setItems((prev) => prev.map((item, i) => (i === index ? { ...item, text: clamped } : item)));
        markDirtyAndScheduleUpdate();
        return;
      }

      // Multi-line paste: split into separate items
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

      if (lines.length <= 1) {
        const singleText = truncateToCodePoints(lines[0] ?? '', VALIDATION.ITEM_TEXT_MAX_LENGTH);
        setItems((prev) => prev.map((item, i) => (i === index ? { ...item, text: singleText } : item)));
        markDirtyAndScheduleUpdate();
        return;
      }

      const isCompleted = itemsRef.current[index]?.completed ?? false;

      if (isCompleted) {
        setItems((prev) =>
          prev.map((item, i) =>
            i === index ? { ...item, text: truncateToCodePoints(lines.join(' '), VALIDATION.ITEM_TEXT_MAX_LENGTH) } : item,
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
          text: truncateToCodePoints(line, VALIDATION.ITEM_TEXT_MAX_LENGTH),
          completed: false,
          position: 0,
          parentId: sourceParentId,
          assigned_to: '',
        }));
        const updated = prev.map((item, i) =>
          i === index ? { ...item, text: truncateToCodePoints(firstLine, VALIDATION.ITEM_TEXT_MAX_LENGTH) } : item,
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
  // Newly created items inherit the current item's group (parentId),
  // assignee, and completed state.
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
          completed: prev[index]?.completed ?? false,
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
          completed: prev[index]?.completed ?? false,
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
        completed: prev[index]?.completed ?? false,
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

  // Runs a metadata PATCH while holding metadataUpdateInFlightRef so the
  // existingNote refresh effect won't revert the optimistic change with a stale
  // refetch that lands mid-request.
  const runMetadataUpdate = useCallback(async (id: string, data: UpdateNoteRequest) => {
    metadataUpdateInFlightRef.current = true;
    try {
      await updateMutation.mutateAsync({ id, data });
    } finally {
      metadataUpdateInFlightRef.current = false;
    }
  }, [updateMutation]);

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
    if (isReadOnly) return;
    animateListReflow();
    setCheckedItemsCollapsed((prev) => !prev);
    markDirtyAndScheduleUpdate();
  }, [isReadOnly, markDirtyAndScheduleUpdate]);

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
    if (isReadOnly) return;
    setAssigningItemId(itemId);
    setAssigneePickerVisible(true);
  }, [isReadOnly]);

  const handleNativeShare = useCallback(() => {
    const text = formatEditorStateForShare(noteTypeRef.current, titleRef.current, contentRef.current, itemsRef.current);
    if (text.trim()) void Share.share({ message: text });
  }, []);

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
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
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
  }, [deleteMutation, navigation, noteId, restoreMutation, showToast, t, withPendingIndicator, zoomCloseAndExit]);

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
  }, [confirm, noteId, permanentDeleteMutation, t, withPendingIndicator, zoomCloseAndExit]);

  const handleTogglePin = useCallback(() => withSavedNote(async (id) => {
    const newPinned = !pinnedRef.current;
    setPinned(newPinned);
    try {
      await runMetadataUpdate(id, buildMetadataUpdateData({ pinned: newPinned }));
      commitMetadataBaseline({ pinned: newPinned });
    } catch {
      setPinned(!newPinned);
      Alert.alert(t('common.error'), t('note.failedUpdate'));
    }
  }), [buildMetadataUpdateData, commitMetadataBaseline, runMetadataUpdate, withSavedNote, t]);

  const handleToggleArchive = useCallback(() => withSavedNote(async (id) => {
    const newArchived = !archivedRef.current;
    setArchived(newArchived);

    if (!newArchived) {
      // Unarchiving keeps the user on the note.
      try {
        await runMetadataUpdate(id, buildMetadataUpdateData({ archived: false }));
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
      await runMetadataUpdate(id, buildMetadataUpdateData({ archived: true }));
      showToast(t('dashboard.noteArchived'), 'success', {
        label: t('dashboard.undo'),
        onPress: async () => {
          try {
            await runMetadataUpdate(id, buildMetadataUpdateData({ archived: false }));
            showToast(t('dashboard.noteUnarchived'));
          } catch {
            showToast(t('note.failedUnarchive'), 'error');
          }
        },
      });
    } catch {
      showToast(t('note.failedArchive'), 'error');
    }
  }), [buildMetadataUpdateData, zoomCloseAndExit, commitMetadataBaseline, runMetadataUpdate, withSavedNote, showToast, t]);

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
      await runMetadataUpdate(currentNoteId, buildMetadataUpdateData({ color: selectedColor }));
      commitMetadataBaseline({ color: selectedColor });
    } catch {
      setColor(prevColor);
      Alert.alert(t('common.error'), t('note.failedColorUpdate'));
    }
  }, [buildMetadataUpdateData, commitMetadataBaseline, flushPendingChanges, markDirtyAndScheduleUpdate, runMetadataUpdate, t]);

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
      // No originRect: the duplicate isn't tied to a card, so it opens without a
      // zoom (and leaving it won't zoom onto the original's card).
      navigation.replace('NoteEditor', { noteId: duplicatedNote.id });
    } catch {
      Alert.alert(t('common.error'), t('note.failedDuplicate'));
    }
  }, [duplicateMutation, flushSave, navigation, t]);

  // List -> text is lossy (assignments, real checkbox/nesting structure), so
  // it's confirmed first; text -> list just reflows lines and runs directly
  // (mirrors the webapp's NoteModal). The note is reloaded via a screen replace
  // afterward, since the editor's baseline/ref state is keyed to the note's
  // pre-conversion type and shape.
  const handleConvertNoteType = useCallback(async () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

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
    } catch {
      Alert.alert(t('common.error'), t('note.failedConvert'));
    }
  }, [confirm, convertMutation, flushSave, navigation, showToast, t, withPendingIndicator]);

  // Disable inputs while waiting for existing note to hydrate
  const isHydrating = initialNoteId !== null && !existingNote;

  // Build index lookup for items to avoid O(n) indexOf per item
  const itemIndexMap = useMemo(
    () => new Map(items.map((item, i) => [item.id, i])),
    [items],
  );
  const itemIndexMapRef = useRef(itemIndexMap);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
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
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  checkedItemsRef.current = checkedItems;
  const uncheckedItemsRef = useRef(uncheckedItems);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
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
        const targetLevel = indentLevelFromDrag(dragTranslateX.get(), baseLevel, canIndent, canOutdent);
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
          dragTranslateX.set(event.translationX);
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
            onAcceptSuggestion: (text) => handleAcceptSuggestion(item.id, text),
          }}
        />
      );
    },
    [getItemRef, listItemHandlers, isNoteShared, collaborators, hasNoteColor, completedItemTexts, handleAcceptSuggestion, dragTranslateX, isReadOnly],
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
  }, [markDirtyAndScheduleUpdate, showToast, t]);

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

  const toggleMobileHeading = useCallback(() => {
    applyToolbarEdit(cycleHeading);
  }, [applyToolbarEdit]);

  const toggleMobileBullet = useCallback(() => {
    applyToolbarEdit(toggleBullet);
  }, [applyToolbarEdit]);

  const toggleMobileCheckbox = useCallback(() => {
    applyToolbarEdit(toggleCheckbox);
  }, [applyToolbarEdit]);

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
      <View style={[styles.header, { backgroundColor: noteBackground, borderBottomColor: hasNoteColor ? 'transparent' : colors.borderLight, paddingTop: (bannerShown ? 0 : insets.top) + 12 }]}>
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
          style={[styles.syncToast, { backgroundColor: colors.warning, borderBottomColor: colors.warningBorder }]}
          onPress={() => setSyncToast(null)}
          testID="sync-toast"
        >
          <Text style={[styles.syncToastText, { color: colors.warningText }]}>{syncToast}</Text>
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
            autoFocus={openedAsNewList}
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

            {/* iOS: formatting toolbar as InputAccessoryView (docks above keyboard).
                Same conditions as the Android branch below — the accessory view
                is only reachable while the content input exists. */}
            {Platform.OS === 'ios' && noteType === 'text' && isEditingContent && !isReadOnly && (
              <InputAccessoryView nativeID={MARKDOWN_TOOLBAR_ID}>
                <MarkdownToolbarContent
                  onBold={toggleMobileBold}
                  onItalic={toggleMobileItalic}
                  onHeading={toggleMobileHeading}
                  onBullet={toggleMobileBullet}
                  onCheckbox={toggleMobileCheckbox}
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
              isNoteShared={!!isNoteShared}
              collaborators={collaborators}
              hasNoteColor={hasNoteColor}
              dividerColor={completedSectionDividerColor}
              handlers={listItemHandlers}
              popItemId={popItemId}
              editable={!isReadOnly}
            />
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
          onHeading={toggleMobileHeading}
          onBullet={toggleMobileBullet}
          onCheckbox={toggleMobileCheckbox}
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
