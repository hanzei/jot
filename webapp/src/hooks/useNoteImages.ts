import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IMAGE_ALLOWED_TYPES, IMAGE_MAX_PER_NOTE, generateId, type Note, type NoteImage } from '@jot/shared';
import { images as imagesApi } from '@/utils/api';
import type { PendingImageUpload } from '@/components/NoteImageGallery';

// Undo window for a client-deferred note image removal (spec: ~10s).
export const IMAGE_REMOVE_UNDO_MS = 10_000;

interface UseNoteImagesOptions {
  // The note being edited. Uploads require an existing note (an id to attach
  // to), so everything here is gated on it being set.
  note?: Note | null;
  // Server-configured image upload cap, fetched via GET /config.
  uploadMaxBytes: number;
  onRefresh?: () => void;
  // Surfaces a validation/upload error in the modal's own error banner.
  showError: (message: string) => void;
}

// useNoteImages owns the note-image add/remove UI: the upload queue and its
// retry/dismiss handling, the optimistic overlay that covers the dropped SSE
// self-echo, the client-deferred removal undo window, and the drag-to-upload
// state. These are coupled to each other and barely to the rest of the editor,
// which is what makes them separable; the caller only renders what comes back.
export function useNoteImages({ note, uploadMaxBytes, onRefresh, showError }: UseNoteImagesOptions) {
  const { t } = useTranslation();

  const [imageUploads, setImageUploads] = useState<PendingImageUpload[]>([]);
  // Images currently showing an inline "Image removed — Undo" bar. Rendered
  // inside the DialogPanel (not the app-wide toast) so clicking Undo is never
  // mistaken by HeadlessUI's Dialog for an outside click that should close it.
  // hiddenImageIds is derived from this below rather than tracked separately
  // — the two must always agree, so there is only one thing to keep in sync.
  const [removedImages, setRemovedImages] = useState<NoteImage[]>([]);
  const hiddenImageIds = useMemo(() => new Set(removedImages.map(img => img.id)), [removedImages]);
  // Images this session has uploaded that note.images may not reflect yet.
  // The server's note_image_added SSE event is dropped for the client that
  // triggered it (self-echo suppression in useSSE, keyed on X-Client-Id —
  // every mutation this modal makes carries that header), so without this
  // local overlay a just-uploaded tile would vanish the moment its upload
  // placeholder is removed and only reappear after an unrelated refresh or a
  // reload. Tagged with the note it was uploaded to (NoteImage itself carries
  // no note_id) so switching notes can't leak one note's optimistic image
  // into another's gallery. Pruned once note.images actually contains it.
  const [optimisticImages, setOptimisticImages] = useState<{ noteId: string; image: NoteImage }[]>([]);
  const optimisticImagesRef = useRef<{ noteId: string; image: NoteImage }[]>([]);
  // The gallery's actual source of truth: note.images plus this session's own
  // not-yet-confirmed uploads for this note, minus anything mid-undo-window.
  const displayedImages = useMemo(() => {
    const base = note?.images ?? [];
    if (!note) return base;
    const baseIds = new Set(base.map(img => img.id));
    const extra = optimisticImages
      .filter(e => e.noteId === note.id && !baseIds.has(e.image.id))
      .map(e => e.image);
    const merged = extra.length > 0 ? [...base, ...extra] : base;
    return hiddenImageIds.size > 0 ? merged.filter(img => !hiddenImageIds.has(img.id)) : merged;
  }, [note, optimisticImages, hiddenImageIds]);
  // Human-readable max upload size for error copy, derived from the
  // server-configured cap (falls back to the shared default) rather than a
  // hardcoded value, so the message matches what the server will actually
  // accept even when an admin has overridden UPLOAD_MAX_BYTES.
  const imageMaxMB = useMemo(() => Math.round(uploadMaxBytes / (1024 * 1024)), [uploadMaxBytes]);
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const imageUploadsRef = useRef<PendingImageUpload[]>([]);
  const imageUploadFilesRef = useRef<Map<string, File>>(new Map());
  // Upload ids currently in flight, checked synchronously (not via React
  // state) so a rapid double-click on Retry can't start a second concurrent
  // request for the same file before a re-render reflects the first one.
  const activeUploadIdsRef = useRef<Set<string>>(new Set());
  const imageDragCounterRef = useRef(0);
  // Timers for client-deferred image removal (undo window). Stored in a ref
  // (not React state) so they keep running — and the eventual DELETE still
  // fires — even if the modal unmounts before the undo window elapses.
  const pendingImageRemovalsRef = useRef<Map<string, { timeoutId: ReturnType<typeof setTimeout> }>>(new Map());

  useEffect(() => {
    imageUploadsRef.current = imageUploads;
  }, [imageUploads]);

  useEffect(() => {
    optimisticImagesRef.current = optimisticImages;
  }, [optimisticImages]);

  // Once note.images actually contains an optimistically-added image (a
  // later refresh caught up), drop it from the local overlay so it doesn't
  // grow unbounded across a long session. Only prunes entries for the
  // currently-open note — entries for a note that's no longer open are
  // reconciled the next time that note is reopened. displayedImages already
  // ignores confirmed entries, so this is bookkeeping rather than a visual
  // change; adjusting during render (the pruned result is stable on the next
  // pass) keeps it out of an effect (react-hooks/set-state-in-effect).
  if (optimisticImages.length > 0 && note) {
    const confirmedIds = new Set((note.images ?? []).map(img => img.id));
    const remaining = optimisticImages.filter(e => e.noteId !== note.id || !confirmedIds.has(e.image.id));
    if (remaining.length !== optimisticImages.length) {
      setOptimisticImages(remaining);
    }
  }

  // Revoke any outstanding local preview URLs on unmount. Deliberately does
  // NOT clear pendingImageRemovalsRef's timers — those must keep running so
  // a removal's deferred DELETE still fires after the modal closes.
  useEffect(() => {
    return () => {
      imageUploadsRef.current.forEach(u => URL.revokeObjectURL(u.previewUrl));
    };
  }, []);

  // Validates a file client-side before it's queued for upload — a fast,
  // friendly pre-check; the server (§7 of the spec) is the source of truth
  // and re-validates type/size/count regardless.
  const validateImageFile = useCallback((file: File): string | null => {
    if (!(IMAGE_ALLOWED_TYPES as readonly string[]).includes(file.type)) {
      return t('images.errorWrongType');
    }
    if (file.size > uploadMaxBytes) {
      return t('images.errorTooLarge', { maxMB: imageMaxMB });
    }
    return null;
  }, [t, uploadMaxBytes, imageMaxMB]);

  // Removes a completed or dismissed upload tile and revokes its local
  // preview URL so the object URL doesn't leak.
  const removeUploadTile = useCallback((uploadId: string) => {
    setImageUploads(prev => {
      const tile = prev.find(u => u.id === uploadId);
      if (tile) URL.revokeObjectURL(tile.previewUrl);
      return prev.filter(u => u.id !== uploadId);
    });
    imageUploadFilesRef.current.delete(uploadId);
  }, []);

  const runImageUpload = useCallback((uploadId: string, file: File) => {
    const noteId = note?.id;
    if (!noteId) return;
    // Guard against a duplicate concurrent request for the same upload — a
    // rapid double-click on Retry (or the initial upload racing a fast
    // retry) before React re-renders the tile out of its clickable state.
    if (activeUploadIdsRef.current.has(uploadId)) return;
    activeUploadIdsRef.current.add(uploadId);
    imagesApi.upload(noteId, file, (percent) => {
      setImageUploads(prev => prev.map(u => (u.id === uploadId ? { ...u, progress: percent } : u)));
    }).then((image) => {
      activeUploadIdsRef.current.delete(uploadId);
      // note_image_added's SSE echo is dropped for the client that triggered
      // it (self-echo suppression in useSSE, keyed on the same X-Client-Id
      // header this upload just sent), so note.images won't reflect this
      // upload here on its own — add it to the local overlay so the real
      // tile takes over from the upload placeholder immediately instead of
      // vanishing until an unrelated refresh or reload catches it up.
      setOptimisticImages(prev => (prev.some(e => e.image.id === image.id) ? prev : [...prev, { noteId, image }]));
      removeUploadTile(uploadId);
      // optimisticImages only lives as long as this NoteModal instance does.
      // Closing the modal unmounts it entirely, so without also correcting
      // Dashboard's own note list here, reopening the same note would read
      // the same stale note.images (missing this upload) all over again —
      // the same dropped-SSE-echo gap the deferred delete already guards
      // against below, just on the add side instead of the remove side.
      onRefresh?.();
    }).catch((error) => {
      activeUploadIdsRef.current.delete(uploadId);
      console.error('Failed to upload image:', error);
      const status = (error as { response?: { status?: number } })?.response?.status;
      const message = status === 413
        ? t('images.errorTooLarge', { maxMB: imageMaxMB })
        : t('images.uploadFailed');
      setImageUploads(prev => prev.map(u => (u.id === uploadId ? { ...u, status: 'error', errorMessage: message } : u)));
    });
  }, [note?.id, removeUploadTile, t, imageMaxMB, onRefresh]);

  const startImageUpload = useCallback((file: File) => {
    const id = generateId();
    const previewUrl = URL.createObjectURL(file);
    imageUploadFilesRef.current.set(id, file);
    setImageUploads(prev => [...prev, { id, filename: file.name, previewUrl, progress: 0, status: 'uploading' }]);
    runImageUpload(id, file);
  }, [runImageUpload]);

  const retryImageUpload = useCallback((uploadId: string) => {
    const file = imageUploadFilesRef.current.get(uploadId);
    if (!file) return;
    setImageUploads(prev => prev.map(u => (u.id === uploadId ? { ...u, status: 'uploading', progress: 0, errorMessage: undefined } : u)));
    runImageUpload(uploadId, file);
  }, [runImageUpload]);

  // Entry point for the toolbar picker, drag & drop, and paste. Validates
  // each file and enforces the per-note image cap client-side (the server
  // enforces it authoritatively) before starting an upload per valid file.
  const queueImageFiles = useCallback((files: File[]) => {
    if (!note || files.length === 0) return;

    const noteImages = note.images ?? [];
    const confirmedIds = new Set(noteImages.map(img => img.id));
    // Images this session already uploaded to this note that note.images
    // doesn't reflect yet (see optimisticImages above) still occupy a slot.
    const unconfirmedOptimisticCount = optimisticImagesRef.current.filter(
      e => e.noteId === note.id && !confirmedIds.has(e.image.id)
    ).length;
    let remainingSlots = IMAGE_MAX_PER_NOTE
      - noteImages.length
      - unconfirmedOptimisticCount
      - imageUploadsRef.current.filter(u => u.status !== 'error').length;

    // Collect distinct error messages across the whole batch instead of
    // showing (and immediately overwriting) one per invalid file — a drop of
    // several invalid files in one action would otherwise only ever surface
    // the last file's error.
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
    if (errors.size > 0) showError(Array.from(errors).join(' '));
  }, [note, showError, startImageUpload, t, validateImageFile]);

  const handleImageFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    queueImageFiles(files);
  }, [queueImageFiles]);

  const handleImageDragEnter = useCallback((e: React.DragEvent) => {
    if (!note || !Array.from(e.dataTransfer.items).some(item => item.kind === 'file')) return;
    e.preventDefault();
    imageDragCounterRef.current += 1;
    setIsDraggingImage(true);
  }, [note]);

  const handleImageDragOver = useCallback((e: React.DragEvent) => {
    // Only claim file drags — preventDefault() unconditionally would also
    // suppress the browser's native text drag-and-drop (e.g. repositioning
    // selected text within the note's own textarea), which this handler
    // does nothing with.
    if (!note || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
  }, [note]);

  const handleImageDragLeave = useCallback(() => {
    if (!note) return;
    imageDragCounterRef.current = Math.max(0, imageDragCounterRef.current - 1);
    if (imageDragCounterRef.current === 0) setIsDraggingImage(false);
  }, [note]);

  const handleImageDrop = useCallback((e: React.DragEvent) => {
    if (!note) return;
    // Only claim drops that actually carry files — same reasoning as
    // handleImageDragOver: cancelling a file-less drop would also cancel the
    // browser's native text drag-and-drop (e.g. repositioning selected text
    // within the note's own textarea), making that drop silently do nothing.
    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length === 0) return;
    e.preventDefault();
    imageDragCounterRef.current = 0;
    setIsDraggingImage(false);
    const imageFiles = droppedFiles.filter(f => f.type.startsWith('image/'));
    // A drop of nothing but non-images never reaches queueImageFiles' own
    // validation, so say why here instead of letting the overlay just vanish.
    // Mixed drops keep uploading their images silently, as before.
    if (imageFiles.length === 0) {
      showError(t('images.errorWrongType'));
      return;
    }
    queueImageFiles(imageFiles);
  }, [note, queueImageFiles, showError, t]);

  const handleModalPaste = useCallback((e: React.ClipboardEvent) => {
    if (!note) return;
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    e.preventDefault();
    queueImageFiles(files);
  }, [note, queueImageFiles]);

  // Clears the local "removed, showing undo" state for an image — called
  // either by undo or once the deferred delete actually lands.
  const clearImageRemovalState = useCallback((imageId: string) => {
    setRemovedImages(prev => prev.filter(img => img.id !== imageId));
  }, []);

  // Removal is client-deferred (spec §3.1): the tile hides immediately and an
  // inline "Image removed — Undo" bar appears (rendered inside the modal, not
  // the app-wide toast — HeadlessUI's Dialog treats any click outside its own
  // portal as a request to close it, which would otherwise dismiss the modal
  // the moment Undo is clicked). The DELETE only fires once the undo window
  // elapses with no undo. The timer lives in pendingImageRemovalsRef (a ref,
  // not state) so it keeps running even if the modal unmounts first.
  const removeNoteImage = useCallback((image: NoteImage) => {
    setRemovedImages(prev => (prev.some(img => img.id === image.id) ? prev : [...prev, image]));

    const timeoutId = setTimeout(() => {
      const entry = pendingImageRemovalsRef.current.get(image.id);
      pendingImageRemovalsRef.current.delete(image.id);
      // Undo (or a later removal of the same image) deletes the map entry
      // and clears this timer, so reaching here with no entry means it was
      // already cancelled — nothing left to do.
      if (!entry) return;
      imagesApi.delete(image.id).then(() => {
        // Drop the optimistic entry too, if this image was uploaded in this
        // same session and note.images hasn't caught up yet. The render-time
        // prune only clears entries that note.images confirms, and a deleted
        // image never will be — so leaving it would let displayedImages put
        // the tile straight back once clearImageRemovalState un-hides it.
        // Only on success: a failed delete must keep the entry so the restore
        // below still has something to show.
        setOptimisticImages(prev => prev.filter(e => e.image.id !== image.id));
        // note_image_removed's SSE echo is dropped for this client (same
        // self-echo suppression as uploads), and the modal may have
        // already unmounted (closed) by the time this fires, so
        // Dashboard's note.images can otherwise stay stale — reopening the
        // note would show the just-deleted image again. onRefresh's closure
        // still targets the current Dashboard instance's state setters even
        // if captured before this component unmounted.
        onRefresh?.();
      }).catch((error) => {
        console.error('Failed to delete note image:', error);
      }).finally(() => {
        // Deliberately deferred until the request settles (not run
        // synchronously when the timer fires) — clearing this earlier would
        // un-hide the tile for the gap between "timer fired" and "DELETE
        // actually completed," flashing the about-to-be-deleted image back
        // into view. On failure this correctly restores it since the delete
        // never happened.
        clearImageRemovalState(image.id);
      });
    }, IMAGE_REMOVE_UNDO_MS);
    pendingImageRemovalsRef.current.set(image.id, { timeoutId });
  }, [clearImageRemovalState, onRefresh]);

  const undoRemoveImage = useCallback((imageId: string) => {
    const entry = pendingImageRemovalsRef.current.get(imageId);
    if (entry) {
      clearTimeout(entry.timeoutId);
      pendingImageRemovalsRef.current.delete(imageId);
    }
    clearImageRemovalState(imageId);
  }, [clearImageRemovalState]);

  // Called by the modal's adoption effect when it switches to a different note
  // (or to/from a brand-new note). Drops any in-flight uploads left over from
  // whichever note we're leaving.
  //
  // removedImages (and the hiddenImageIds derived from it) is NOT simply
  // cleared — pendingImageRemovalsRef's timers are keyed by image id and keep
  // running across a note switch (the modal doesn't unmount), so a removal
  // whose ~10s undo window is still open must stay hidden (with its undo bar)
  // if the user navigates back to this note before it elapses. Re-derive it
  // from whatever the incoming note's images still have a live timer for,
  // rather than assuming "different note adopted" means "no pending removals"
  // — otherwise the image would reappear with no undo affordance and then
  // vanish once the timer fires, with no explanation. optimisticImages is left
  // alone entirely (not reset here) for the same reason on the upload side —
  // it's pruned per-note during render as each note is (re-)opened, not
  // cleared on switch.
  const resetForNoteSwitch = useCallback(() => {
    imageUploadsRef.current.forEach(u => URL.revokeObjectURL(u.previewUrl));
    imageUploadFilesRef.current.clear();
    setImageUploads([]);
    const stillPending = (note?.images ?? []).filter(img => pendingImageRemovalsRef.current.has(img.id));
    setRemovedImages(stillPending);
  }, [note]);

  return {
    displayedImages,
    imageUploads,
    removedImages,
    isDraggingImage,
    imageFileInputRef,
    handleImageFileInputChange,
    handleImageDragEnter,
    handleImageDragOver,
    handleImageDragLeave,
    handleImageDrop,
    handleModalPaste,
    removeNoteImage,
    undoRemoveImage,
    retryImageUpload,
    removeUploadTile,
    resetForNoteSwitch,
  };
}
