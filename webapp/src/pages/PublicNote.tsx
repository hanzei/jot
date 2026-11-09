import { Fragment, useEffect, useId, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Square, SquareCheck, FileQuestion } from 'lucide-react';
import { VALIDATION, groupNoteItems, type PublicListNote, type PublicNote as PublicNoteData, type PublicNoteItem } from '@jot/shared';
import { publicNoteImages, publicNotes } from '@/utils/api';
import { httpStatus } from '@/utils/apiError';
import { inlineMarkdownToText, renderMarkdown } from '@/utils/markdown';
import InlineMarkdown from '@/components/InlineMarkdown';
import NoteImageGallery from '@/components/NoteImageGallery';

type LoadState =
  | { status: 'loading' }
  | { status: 'loaded'; note: PublicNoteData }
  | { status: 'not_found' }
  | { status: 'error' };

/**
 * The page behind a public note link (`/share/{token}`): a read-only snapshot
 * of the note as it was when the page loaded. It renders the same for every
 * visitor, signed in or not, and calls only the unauthenticated public API.
 */
export default function PublicNote() {
  const { token } = useParams<{ token: string }>();
  const { t } = useTranslation();
  // Keyed by token, so a stale response can never show under another token.
  const [result, setResult] = useState<{ token: string; state: LoadState } | null>(null);
  const state: LoadState = !token
    ? { status: 'not_found' }
    : result?.token === token ? result.state : { status: 'loading' };

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    publicNotes.get(token)
      .then(note => { if (!cancelled) setResult({ token, state: { status: 'loaded', note } }); })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Every dead link is the same 404 on the server — unknown, revoked,
        // expired, trashed or switched off — and the page keeps it that way.
        setResult({ token, state: { status: httpStatus(err) === 404 ? 'not_found' : 'error' } });
      });
    return () => { cancelled = true; };
  }, [token]);

  const note = state.status === 'loaded' ? state.note : null;
  const pageTitle = note?.note_type === 'list' && note.title ? note.title : t('publicNote.pageTitle');
  useEffect(() => {
    document.title = state.status === 'not_found' ? t('publicNote.notFoundTitle') : pageTitle;
  }, [state.status, pageTitle, t]);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-900 px-4 py-8 sm:py-12">
      <main className="mx-auto max-w-2xl">
        {state.status === 'loading' && (
          <div role="status" aria-label={t('publicNote.loading')} className="flex justify-center py-16">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-500" />
          </div>
        )}
        {state.status === 'not_found' && (
          <Message title={t('publicNote.notFoundTitle')} body={t('publicNote.notFoundBody')} />
        )}
        {state.status === 'error' && (
          <Message title={t('publicNote.errorTitle')} body={t('publicNote.errorBody')} />
        )}
        {note && token && <PublicNoteView note={note} token={token} />}
      </main>
    </div>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-8 text-center shadow-sm" data-testid="public-note-message">
      <FileQuestion aria-hidden="true" className="mx-auto mb-4 h-10 w-10 text-gray-400 dark:text-gray-500" />
      <h1 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">{title}</h1>
      <p className="text-sm text-gray-600 dark:text-gray-300">{body}</p>
    </div>
  );
}

function PublicNoteView({ note, token }: { note: PublicNoteData; token: string }) {
  const { t, i18n } = useTranslation();
  const imageUrls = useMemo(() => publicNoteImages(token), [token]);
  // The response carries image IDs only, so the gallery gets a numbered name
  // for each and no size (it frames unsized images at 4:3).
  const images = useMemo(
    () => note.image_ids.map((id, index) => ({
      id,
      filename: t('publicNote.imageAlt', { number: index + 1 }),
      width: 0,
      height: 0,
    })),
    [note.image_ids, t],
  );
  const contentHtml = useMemo(
    () => (note.note_type === 'text' ? renderMarkdown(note.content) : ''),
    [note],
  );
  const title = note.note_type === 'list' ? note.title : '';

  return (
    <article className="rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-sm overflow-hidden" data-testid="public-note">
      {images.length > 0 && (
        <div className="p-2 pb-0">
          <NoteImageGallery images={images} urls={imageUrls} />
        </div>
      )}
      <div className="p-6">
        {/* A text note has no title, but the page still needs a heading. */}
        <h1 className={title ? 'text-xl font-semibold text-gray-900 dark:text-white mb-4 break-words' : 'sr-only'}>
          {title || t('publicNote.pageTitle')}
        </h1>
        {note.note_type === 'text' ? (
          <div
            className="markdown-content text-gray-900 dark:text-white break-words"
            data-testid="public-note-content"
            dangerouslySetInnerHTML={{ __html: contentHtml }}
          />
        ) : (
          <PublicListItems note={note} />
        )}
      </div>
      <footer className="border-t border-gray-200 dark:border-slate-700 px-6 py-3 text-xs text-gray-600 dark:text-gray-300">
        {t('publicNote.footer', {
          date: new Date(note.updated_at).toLocaleString(i18n.resolvedLanguage, { dateStyle: 'medium', timeStyle: 'short' }),
        })}
      </footer>
    </article>
  );
}

function PublicListItems({ note }: { note: PublicListNote }) {
  const { t } = useTranslation();
  const completedListId = useId();
  // Starts as the note's owner left it; toggling is this visitor's own view
  // only, sends nothing, and a reload goes back to the note's state.
  const [collapsed, setCollapsed] = useState(note.checked_items_collapsed);

  const { active, completed, completedRows } = useMemo(() => {
    const ordered = groupNoteItems(note.items);
    const itemsById = new Map(ordered.map(item => [item.id, item]));
    const completed = ordered.filter(item => item.completed);
    // As in the editor: a completed child whose parent is still active is
    // shown under a muted copy of that parent, so it never leaves its group.
    const completedRows: { item: PublicNoteItem; ghostParent: PublicNoteItem | null }[] = [];
    let lastGhostParentId: string | null = null;
    for (const item of completed) {
      const parent = item.parent_id ? itemsById.get(item.parent_id) : undefined;
      const activeParent = parent && !parent.completed ? parent : null;
      completedRows.push({ item, ghostParent: activeParent && activeParent.id !== lastGhostParentId ? activeParent : null });
      lastGhostParentId = activeParent?.id ?? null;
    }
    return { active: ordered.filter(item => !item.completed), completed, completedRows };
  }, [note.items]);

  return (
    <div>
      {active.length > 0 && (
        <ul className="space-y-2" data-testid="public-note-items">
          {active.map(item => <ItemRow key={item.id} item={item} />)}
        </ul>
      )}
      {completed.length > 0 && (
        <div className={`border-t border-gray-200 dark:border-slate-700 pt-3 ${active.length > 0 ? 'mt-4' : ''}`}>
          <button
            type="button"
            onClick={() => setCollapsed(c => !c)}
            aria-expanded={!collapsed}
            aria-controls={completedListId}
            className="flex items-center space-x-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white mb-2"
          >
            <ChevronDown aria-hidden="true" className={`h-4 w-4 transition-transform ${collapsed ? '-rotate-90' : 'rotate-0'}`} />
            <span>{t('note.completedItems', { count: completed.length })}</span>
          </button>
          <ul id={completedListId} hidden={collapsed} className="space-y-2" data-testid="public-note-completed-items">
            {completedRows.map(({ item, ghostParent }) => (
              <Fragment key={item.id}>
                {ghostParent && <ItemRow item={ghostParent} ghost />}
                <ItemRow item={item} />
              </Fragment>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ItemRow({ item, ghost = false }: { item: PublicNoteItem; ghost?: boolean }) {
  const { t } = useTranslation();
  const Box = item.completed ? SquareCheck : Square;
  const textClass = item.completed
    ? 'line-through text-gray-600 dark:text-gray-300'
    : ghost
      ? 'font-semibold text-gray-600 dark:text-gray-300'
      : 'text-gray-900 dark:text-white';
  return (
    <li
      className="flex items-start gap-2 min-w-0"
      style={{ marginLeft: item.parent_id ? VALIDATION.INDENT_PX_PER_LEVEL : 0 }}
      data-completed={item.completed}
      // The copy of a still-active parent heads its completed children; say so,
      // since its look alone does not.
      aria-label={ghost ? t('note.completedItemGroup', { title: inlineMarkdownToText(item.text) }) : undefined}
    >
      <Box aria-hidden="true" className="h-4 w-4 mt-1 flex-shrink-0 text-gray-500 dark:text-gray-400" />
      <InlineMarkdown text={item.text} className={`min-w-0 whitespace-pre-wrap break-words ${textClass}`} />
    </li>
  );
}
