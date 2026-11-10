import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Check, Link2, Pencil } from 'lucide-react';
import {
  PUBLIC_LINK_EXPIRY_CHOICES,
  isPublicLinkActive,
  publicLinkExpiresAt,
  publicLinkUrl,
  userDisplayName,
  type Note,
  type PublicLink,
  type PublicLinkExpiryChoice,
  type User,
} from '@jot/shared';
import { notes } from '@/utils/api';
import { apiErrorMessage } from '@/utils/apiError';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import ConfirmDialog from '@/components/ConfirmDialog';
import { shortPublicLinkUrl, type PublicLinksConfig } from '@/utils/publicLink';

interface PublicLinkSectionProps {
  note: Note;
  config: PublicLinksConfig;
  currentUserId?: string | undefined;
  /** The user directory, to name who created the link. */
  users: User[];
  /** Called with the note's new link (null once revoked), to update cached copies of the note. */
  onChange?: ((noteId: string, link: PublicLink | null) => void) | undefined;
}

const EXPIRY_LABEL_KEYS = {
  never: 'publicLink.expiryNever',
  '7d': 'publicLink.expiry7Days',
  '30d': 'publicLink.expiry30Days',
  '3m': 'publicLink.expiry3Months',
} as const satisfies Record<PublicLinkExpiryChoice, string>;

/**
 * The share dialog's "Public link" section, for the owner and collaborators
 * alike: create a read-only link with an expiry, copy it, change the expiry
 * (same URL), or revoke it for everyone. It renders `note.public_link` as the
 * caller holds it, so a change made elsewhere (arriving over SSE) shows here too.
 *
 * The link is shown shortened (`shortPublicLinkUrl`): its token is the only key
 * to the note, so the full one stays out of screenshots and screen shares. Copy
 * link copies it in full.
 */
export default function PublicLinkSection({ note, config, currentUserId, users, onChange }: PublicLinkSectionProps) {
  const { t, i18n } = useTranslation();
  const headingId = useId();
  const expiryId = useId();
  const [createExpiry, setCreateExpiry] = useState<PublicLinkExpiryChoice>('never');
  // The open expiry editor: the choice so far ('' until one is made, so Save
  // never re-times the link with whatever the select happened to show), and
  // the link it was opened for.
  const [editing, setEditing] = useState<{ choice: PublicLinkExpiryChoice | ''; linkKey: string } | null>(null);
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const { copied, copy } = useCopyToClipboard();
  const changeRef = useRef<HTMLButtonElement>(null);
  const editorSelectRef = useRef<HTMLSelectElement>(null);
  const wasEditing = useRef(false);

  const link = isPublicLinkActive(note.public_link) ? note.public_link : null;
  const linkKey = link ? `${link.token} ${link.expires_at ?? 'never'}` : null;

  // The link changed or went away elsewhere (over SSE) while the editor was
  // open: close it and say so, rather than keep a choice made against a link
  // that no longer looks like that. Skipped while our own request is in
  // flight, since its SSE echo can arrive before its response.
  if (editing && !busy && editing.linkKey !== linkKey) {
    setEditing(null);
    setChangedElsewhere(true);
  }

  const isEditing = editing !== null;
  // Opening the editor moves focus to its select; closing it returns focus to
  // Change when it went nowhere (the focused control was removed).
  useEffect(() => {
    if (isEditing && !wasEditing.current) {
      editorSelectRef.current?.focus();
    } else if (!isEditing && wasEditing.current) {
      const active = document.activeElement;
      if (!active || active === document.body) changeRef.current?.focus();
    }
    wasEditing.current = isEditing;
  }, [isEditing]);

  if (!config.enabled) return null;

  // Creating and changing the expiry are the same request: PUT creates a link
  // when there is none and only moves the expiry of an active one.
  const setPublicLink = async (choice: PublicLinkExpiryChoice) => {
    setBusy(true);
    setError('');
    setChangedElsewhere(false);
    try {
      const updated = await notes.setPublicLink(note.id, { expires_at: publicLinkExpiresAt(choice) });
      setCreateExpiry('never');
      setEditing(null);
      onChange?.(note.id, updated);
    } catch (err) {
      setError(apiErrorMessage(err, t, 'publicLink.failed'));
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async () => {
    setBusy(true);
    setError('');
    setChangedElsewhere(false);
    try {
      await notes.deletePublicLink(note.id);
      setConfirmingRevoke(false);
      onChange?.(note.id, null);
    } catch (err) {
      setConfirmingRevoke(false);
      setError(apiErrorMessage(err, t, 'publicLink.failed'));
    } finally {
      setBusy(false);
    }
  };

  const openEditor = () => {
    if (!linkKey) return;
    setChangedElsewhere(false);
    setEditing({ choice: '', linkKey });
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString(i18n.resolvedLanguage, { dateStyle: 'medium' });

  const creatorLabel = (createdBy: string | null) => {
    if (createdBy === null) return t('publicLink.createdByFormer');
    if (createdBy === currentUserId) return t('publicLink.createdByYou');
    const creator = users.find(user => user.id === createdBy);
    return creator ? t('publicLink.createdBy', { name: userDisplayName(creator) }) : null;
  };

  const url = link ? publicLinkUrl(link, config.publicUrl, window.location.origin) : '';
  const createdBy = link ? creatorLabel(link.created_by) : null;

  const buttonClassName = 'px-3 py-1.5 text-sm rounded-md border border-gray-300 dark:border-slate-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-slate-700 disabled:opacity-50';
  const selectClassName = 'rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-gray-100 px-2 py-1.5 text-sm';
  const expiryOptions = PUBLIC_LINK_EXPIRY_CHOICES.map(choice => (
    <option key={choice} value={choice}>{t(EXPIRY_LABEL_KEYS[choice])}</option>
  ));

  return (
    <section
      aria-labelledby={headingId}
      data-testid="public-link-section"
      className="mt-6 border-t border-gray-200 dark:border-slate-700 pt-4"
    >
      <h4 id={headingId} className="flex items-center text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        <Link2 aria-hidden="true" className="h-4 w-4 mr-2" />
        {t('publicLink.heading')}
      </h4>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        {t('publicLink.description')}
      </p>

      {error && (
        <div role="alert" className="mb-3 p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
          {error}
        </div>
      )}

      <div role="status">
        {changedElsewhere && (
          <p className="mb-3 p-2 bg-amber-50 border border-amber-200 rounded text-sm text-amber-800">
            {t('publicLink.changedElsewhere')}
          </p>
        )}
      </div>

      {link && (
        <div className="mb-3">
          {/* One grid for both rows, so Copy link and Change share a column and a width. */}
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
            <p
              data-testid="public-link-url"
              className="truncate rounded-md border border-gray-300 dark:border-slate-600 bg-gray-50 dark:bg-slate-700 text-gray-900 dark:text-gray-100 px-3 py-1.5 text-sm"
            >
              <span className="sr-only">{t('publicLink.urlLabel')}: </span>
              {shortPublicLinkUrl(url)}
            </p>
            <button type="button" onClick={() => void copy(url)} className={`${buttonClassName} flex items-center justify-center`}>
              {copied
                ? <Check aria-hidden="true" className="h-4 w-4 mr-1" />
                : <Copy aria-hidden="true" className="h-4 w-4 mr-1" />}
              {copied ? t('publicLink.copied') : t('publicLink.copy')}
            </button>
            <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="public-link-details">
              {link.expires_at
                ? t('publicLink.expiresOn', { date: formatDate(link.expires_at) })
                : t('publicLink.neverExpires')}
              {createdBy && <> · {createdBy}</>}
            </p>
            {!editing && (
              <button
                ref={changeRef}
                type="button"
                onClick={openEditor}
                disabled={busy}
                aria-label={t('publicLink.changeExpiry')}
                className={`${buttonClassName} flex items-center justify-center`}
              >
                <Pencil aria-hidden="true" className="h-4 w-4 mr-1" />
                {t('publicLink.change')}
              </button>
            )}
          </div>
        </div>
      )}

      {!link && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={expiryId} className="text-sm text-gray-700 dark:text-gray-300">
            {t('publicLink.expiry')}
          </label>
          <select
            id={expiryId}
            value={createExpiry}
            onChange={(e) => setCreateExpiry(e.target.value as PublicLinkExpiryChoice)}
            disabled={busy}
            className={selectClassName}
          >
            {expiryOptions}
          </select>
          <button type="button" onClick={() => void setPublicLink(createExpiry)} disabled={busy} className={buttonClassName}>
            {t('publicLink.create')}
          </button>
        </div>
      )}

      {link && editing && (
        <div
          className="flex flex-wrap items-center gap-2"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            // Close only the editor: the share dialog ignores an Escape whose
            // default was prevented.
            e.preventDefault();
            e.stopPropagation();
            setEditing(null);
          }}
        >
          <label htmlFor={expiryId} className="text-sm text-gray-700 dark:text-gray-300">
            {t('publicLink.newExpiry')}
          </label>
          <select
            ref={editorSelectRef}
            id={expiryId}
            value={editing.choice}
            onChange={(e) => setEditing({ ...editing, choice: e.target.value as PublicLinkExpiryChoice })}
            disabled={busy}
            className={selectClassName}
          >
            {editing.choice === '' && <option value="" disabled>{t('publicLink.chooseExpiry')}</option>}
            {expiryOptions}
          </select>
          <button
            type="button"
            onClick={() => { if (editing.choice) void setPublicLink(editing.choice); }}
            disabled={busy || !editing.choice}
            className={buttonClassName}
          >
            {t('publicLink.save')}
          </button>
          <button type="button" onClick={() => setEditing(null)} disabled={busy} className={buttonClassName}>
            {t('common.cancel')}
          </button>
        </div>
      )}

      {link && !editing && (
        <button
          type="button"
          onClick={() => setConfirmingRevoke(true)}
          disabled={busy}
          className="px-0 py-1.5 text-sm text-red-700 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 disabled:opacity-50"
        >
          {t('publicLink.revoke')}
        </button>
      )}

      <ConfirmDialog
        open={confirmingRevoke}
        title={t('publicLink.revokeTitle')}
        message={t('publicLink.revokeMessage')}
        confirmLabel={t('publicLink.revokeConfirm')}
        onConfirm={handleRevoke}
        onCancel={() => setConfirmingRevoke(false)}
      />
    </section>
  );
}
