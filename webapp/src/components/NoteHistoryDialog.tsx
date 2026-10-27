import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { Check, History, Square, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { userDisplayName, type NoteRevision, type NoteRevisionSummary, type User } from '@jot/shared';
import { notes } from '@/utils/api';
import { renderMarkdown } from '@/utils/markdown';
import InlineMarkdown from '@/components/InlineMarkdown';
import {
  compareRevision,
  isUnchanged,
  revisionListItems,
  type CurrentNoteContent,
  type ItemChange,
} from '@/utils/revisionDiff';
import type { DiffLine } from '@/utils/lineDiff';

// Mounted only while shown, so every opening starts from fresh state.
interface NoteHistoryDialogProps {
  noteId: string;
  /** The note as the editor holds it now, for the comparison view. */
  current: CurrentNoteContent;
  usersById?: Map<string, User> | undefined;
  onClose: () => void;
  /**
   * Restores `revision`. Resolves once the note shows the restored content;
   * rejects to keep the dialog open (the caller reports the error).
   */
  onRestore: (revision: NoteRevisionSummary) => Promise<void>;
}

type View = 'preview' | 'compare';

const SEGMENT_BASE = 'px-3 py-1.5 text-sm font-medium rounded-md transition-colors';
const SEGMENT_ON = `${SEGMENT_BASE} bg-white text-gray-900 shadow-sm dark:bg-slate-600 dark:text-white`;
const SEGMENT_OFF = `${SEGMENT_BASE} text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white`;

/**
 * The note's version history: a timeline of revisions, a preview of the
 * selected one, how it differs from the current note, and Restore. A restore
 * is an ordinary content write that keeps what it replaces in history, so it
 * needs no confirmation.
 */
export default function NoteHistoryDialog({ noteId, current, usersById, onClose, onRestore }: NoteHistoryDialogProps) {
  const { t, i18n } = useTranslation();
  const [revisions, setRevisions] = useState<NoteRevisionSummary[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, NoteRevision>>({});
  // The revision whose details failed to load; selecting it again retries.
  const [failedId, setFailedId] = useState<string | null>(null);
  // Bumped by Retry to refetch the list.
  const [listRequest, setListRequest] = useState(0);
  const [view, setView] = useState<View>('preview');
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    notes.listRevisions(noteId)
      .then(list => {
        if (cancelled) return;
        setRevisions(list);
        setSelectedId(list[0]?.id ?? null);
      })
      .catch((error: unknown) => {
        console.error('Failed to load note history:', error);
        if (!cancelled) setLoadFailed(true);
      });
    return () => { cancelled = true; };
  }, [noteId, listRequest]);

  const retryList = () => {
    setLoadFailed(false);
    setRevisions(null);
    setListRequest(n => n + 1);
  };

  const selected = selectedId ? details[selectedId] ?? null : null;
  const detailFailed = selectedId !== null && failedId === selectedId;
  useEffect(() => {
    if (!selectedId || details[selectedId] || failedId === selectedId) return;
    let cancelled = false;
    notes.getRevision(noteId, selectedId)
      .then(rev => {
        if (!cancelled) setDetails(prev => ({ ...prev, [rev.id]: rev }));
      })
      .catch((error: unknown) => {
        console.error('Failed to load note revision:', error);
        if (!cancelled) setFailedId(selectedId);
      });
    return () => { cancelled = true; };
  }, [noteId, selectedId, details, failedId]);

  const selectRevision = (id: string) => {
    setSelectedId(id);
    if (failedId === id) setFailedId(null);
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString(i18n.resolvedLanguage, { dateStyle: 'medium', timeStyle: 'short' });
  const authorName = (actorId: string | null): string | null => {
    const user = actorId ? usersById?.get(actorId) : undefined;
    return user ? userDisplayName(user) : null;
  };

  const handleRestore = async () => {
    if (!selected || restoring) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      await onRestore(selected);
    } catch (error) {
      // The dialog covers the note modal's own error banner, so report here
      // and stay open for a retry.
      const status = (error as { response?: { status?: number } })?.response?.status;
      setRestoreError(status === 409 ? t('history.restoreConflict') : t('history.restoreFailed'));
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Dialog
      open
      onClose={restoring ? () => {} : onClose}
      className="relative z-[60]"
      onKeyDown={(e) => {
        // Portaled, but React still bubbles synthetic events through the note
        // modal, whose single-key shortcuts (delete, duplicate, ...) must not
        // fire from in here. Stopping the native event also stops headlessui's
        // own Escape handling, so dismiss here instead (mirrors ConfirmDialog).
        e.stopPropagation();
        if (e.key === 'Escape' && !restoring) onClose();
      }}
    >
      <DialogBackdrop transition aria-hidden="true" className="fixed inset-0 bg-black/30 dark:bg-black/50 transition duration-200 ease-out data-[closed]:opacity-0 motion-reduce:transition-none" />
      <div className="fixed inset-0 flex items-center justify-center p-2 sm:p-4">
        <DialogPanel
          transition
          data-testid="note-history-dialog"
          className="flex h-[85vh] w-full max-w-4xl flex-col rounded-lg border border-gray-200 bg-white shadow-xl transition duration-200 ease-out data-[closed]:scale-95 data-[closed]:opacity-0 motion-reduce:transition-none dark:border-slate-700 dark:bg-slate-800"
        >
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-slate-700">
            <DialogTitle className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-white">
              <History className="h-5 w-5" aria-hidden="true" />
              {t('history.title')}
            </DialogTitle>
            <button
              type="button"
              onClick={onClose}
              disabled={restoring}
              aria-label={t('common.close')}
              className="rounded-full p-1 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-slate-700"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>

          {loadFailed ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm text-gray-700 dark:text-gray-200">
              <p role="alert">{t('history.loadFailed')}</p>
              <button type="button" onClick={retryList} className="rounded-md border border-gray-300 px-3 py-1.5 font-medium hover:bg-gray-100 dark:border-slate-600 dark:hover:bg-slate-700">
                {t('history.retry')}
              </button>
            </div>
          ) : revisions === null ? (
            <p className="flex flex-1 items-center justify-center p-6 text-sm text-gray-700 dark:text-gray-200" role="status">
              {t('history.loading')}
            </p>
          ) : revisions.length === 0 ? (
            <p className="flex flex-1 items-center justify-center p-6 text-center text-sm text-gray-700 dark:text-gray-200" data-testid="note-history-empty">
              {t('history.empty')}
            </p>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
              <nav aria-label={t('history.versions')} className="max-h-48 shrink-0 overflow-y-auto border-b border-gray-200 md:max-h-none md:w-64 md:border-b-0 md:border-r dark:border-slate-700">
                <ol className="p-2" data-testid="note-history-timeline">
                  {revisions.map(rev => {
                    const isSelected = rev.id === selectedId;
                    const name = authorName(rev.actor_id);
                    return (
                      <li key={rev.id}>
                        <button
                          type="button"
                          aria-pressed={isSelected}
                          onClick={() => selectRevision(rev.id)}
                          data-testid="note-history-entry"
                          className={`w-full rounded-md px-3 py-2 text-left text-sm ${isSelected
                            ? 'bg-blue-100 text-blue-950 dark:bg-blue-900 dark:text-blue-50'
                            : 'text-gray-800 hover:bg-gray-100 dark:text-gray-100 dark:hover:bg-slate-700'}`}
                        >
                          <span className="block font-medium">{formatDate(rev.edited_at)}</span>
                          {name && <span className="block text-xs opacity-90">{name}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </nav>

              <section aria-label={t('history.selectedVersion')} className="flex min-h-0 flex-1 flex-col">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-4 py-2 dark:border-slate-700">
                  <div className="inline-flex rounded-lg bg-gray-100 p-1 dark:bg-slate-900" role="group" aria-label={t('history.viewMode')}>
                    <button type="button" aria-pressed={view === 'preview'} onClick={() => setView('preview')} className={view === 'preview' ? SEGMENT_ON : SEGMENT_OFF}>
                      {t('history.preview')}
                    </button>
                    <button type="button" aria-pressed={view === 'compare'} onClick={() => setView('compare')} className={view === 'compare' ? SEGMENT_ON : SEGMENT_OFF}>
                      {t('history.compare')}
                    </button>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-4 text-gray-900 dark:text-white" data-testid="note-history-content">
                  {detailFailed && !selected ? (
                    <p role="alert" className="text-sm">{t('history.loadFailed')}</p>
                  ) : !selected ? (
                    <p role="status" className="text-sm text-gray-700 dark:text-gray-200">{t('history.loading')}</p>
                  ) : view === 'preview' ? (
                    <RevisionPreview revision={selected} />
                  ) : (
                    <RevisionComparisonView revision={selected} current={current} />
                  )}
                </div>

                {restoreError && (
                  <p
                    role="alert"
                    data-testid="note-history-error"
                    className="mx-4 mt-3 rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-50"
                  >
                    {restoreError}
                  </p>
                )}
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 px-4 py-3 dark:border-slate-700">
                  <p className="text-xs text-gray-700 dark:text-gray-300">{t('history.restoreHint')}</p>
                  <button
                    type="button"
                    onClick={() => void handleRestore()}
                    disabled={!selected || restoring}
                    data-testid="note-history-restore"
                    className="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-60 dark:bg-blue-600 dark:hover:bg-blue-700"
                  >
                    {restoring ? t('history.restoring') : t('history.restore')}
                  </button>
                </div>
              </section>
            </div>
          )}
        </DialogPanel>
      </div>
    </Dialog>
  );
}

function RevisionPreview({ revision }: { revision: NoteRevision }) {
  const { t } = useTranslation();
  const html = useMemo(() => (revision.note_type === 'text' ? renderMarkdown(revision.content) : ''), [revision]);
  const items = useMemo(() => revisionListItems(revision), [revision]);

  if (revision.note_type === 'text') {
    return revision.content.trim()
      ? <div className="markdown-content" data-testid="note-history-preview" dangerouslySetInnerHTML={{ __html: html }} />
      : <p className="text-sm italic text-gray-700 dark:text-gray-300" data-testid="note-history-preview">{t('history.emptyVersion')}</p>;
  }
  return (
    <div data-testid="note-history-preview">
      {revision.title && <h3 className="mb-2 text-lg font-medium">{revision.title}</h3>}
      {items.length === 0 ? (
        <p className="text-sm italic text-gray-700 dark:text-gray-300">{t('history.emptyVersion')}</p>
      ) : (
        <ul className="space-y-1">
          {items.map(item => (
            <li key={item.id} className={`flex items-start gap-2 text-sm ${item.parentId ? 'ml-6' : ''}`}>
              {item.completed
                ? <Check className="mt-0.5 h-4 w-4 shrink-0" aria-label={t('history.checked')} role="img" />
                : <Square className="mt-0.5 h-4 w-4 shrink-0" aria-label={t('history.unchecked')} role="img" />}
              <InlineMarkdown text={item.text} className={item.completed ? 'line-through text-gray-700 dark:text-gray-300' : ''} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RevisionComparisonView({ revision, current }: { revision: NoteRevision; current: CurrentNoteContent }) {
  const { t } = useTranslation();
  const comparison = useMemo(() => compareRevision(revision, current), [revision, current]);

  if (isUnchanged(comparison)) {
    return <p className="text-sm text-gray-700 dark:text-gray-200" data-testid="note-history-diff">{t('history.noChanges')}</p>;
  }

  return (
    <div className="space-y-3 text-sm" data-testid="note-history-diff">
      <DiffLegend />
      {comparison.kind === 'converted' && (
        <p className="rounded-md bg-gray-100 px-3 py-2 dark:bg-slate-900">
          {comparison.revisionType === 'list' ? t('history.wasList') : t('history.wasText')}
        </p>
      )}
      {comparison.kind === 'list' ? (
        <>
          {comparison.titleBefore !== comparison.titleAfter && (
            <p>{t('history.titleChanged', { before: comparison.titleBefore || t('history.noTitle'), after: comparison.titleAfter || t('history.noTitle') })}</p>
          )}
          <ul className="space-y-1">
            {comparison.changes.map((change, index) => (
              <ItemChangeRow key={index} change={change} />
            ))}
          </ul>
        </>
      ) : (
        <LineDiff lines={comparison.lines} />
      )}
    </div>
  );
}

function DiffLegend() {
  const { t } = useTranslation();
  return (
    <p className="flex flex-wrap gap-3 text-xs text-gray-700 dark:text-gray-300">
      <span className="inline-flex items-center gap-1">
        <span aria-hidden="true" className="inline-block h-3 w-3 rounded-sm bg-red-200 dark:bg-red-900" />
        {t('history.onlyInVersion')}
      </span>
      <span className="inline-flex items-center gap-1">
        <span aria-hidden="true" className="inline-block h-3 w-3 rounded-sm bg-green-200 dark:bg-green-900" />
        {t('history.onlyInCurrent')}
      </span>
    </p>
  );
}

const REMOVED_CLASS = 'bg-red-100 text-red-950 dark:bg-red-950 dark:text-red-50';
const ADDED_CLASS = 'bg-green-100 text-green-950 dark:bg-green-950 dark:text-green-50';

function LineDiff({ lines }: { lines: DiffLine[] }) {
  const { t } = useTranslation();
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-gray-200 font-mono text-xs dark:border-slate-700">
      {lines.map((line, index) => (
        <div
          key={index}
          data-diff={line.kind}
          className={`px-2 ${line.kind === 'removed' ? REMOVED_CLASS : line.kind === 'added' ? ADDED_CLASS : ''}`}
        >
          {line.kind !== 'same' && (
            <span className="sr-only">{line.kind === 'removed' ? t('history.onlyInVersion') : t('history.onlyInCurrent')}: </span>
          )}
          <span aria-hidden="true" className="mr-2 select-none">{line.kind === 'removed' ? '−' : line.kind === 'added' ? '+' : ' '}</span>
          {line.text || ' '}
        </div>
      ))}
    </pre>
  );
}

function ItemChangeRow({ change }: { change: ItemChange }) {
  const { t } = useTranslation();
  // Literal keys, so the translation check sees each one used.
  const label = (kind: 'removed' | 'added' | 'checked' | 'unchecked' | 'moved' | 'reassigned'): string => {
    switch (kind) {
      case 'removed': return t('history.change.removed');
      case 'added': return t('history.change.added');
      case 'checked': return t('history.change.checked');
      case 'unchecked': return t('history.change.unchecked');
      case 'moved': return t('history.change.moved');
      case 'reassigned': return t('history.change.reassigned');
    }
  };
  if (change.kind === 'reordered') {
    return <li className="px-2 py-1">{t('history.change.reordered')}</li>;
  }
  if (change.kind === 'edited') {
    return (
      <li className="px-2 py-1" data-change="edited">
        <span className="font-medium">{t('history.change.edited')}: </span>
        <span className={`${REMOVED_CLASS} rounded px-1`}>{change.before}</span>
        {' → '}
        <span className={`${ADDED_CLASS} rounded px-1`}>{change.after}</span>
      </li>
    );
  }
  const tone = change.kind === 'removed' ? REMOVED_CLASS : change.kind === 'added' ? ADDED_CLASS : '';
  return (
    <li className={`rounded px-2 py-1 ${tone}`} data-change={change.kind}>
      <span className="font-medium">{label(change.kind)}: </span>
      {change.text}
    </li>
  );
}
