import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Check, Link2 } from 'lucide-react';
import {
  PUBLIC_LINK_EXPIRY_CHOICES,
  isPublicLinkActive,
  publicLinkExpiresAt,
  publicLinkUrl,
  shortPublicLinkUrl,
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
import type { PublicLinksConfig } from '@/utils/publicLink';

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
 */
export default function PublicLinkSection({ note, config, currentUserId, users, onChange }: PublicLinkSectionProps) {
  const { t, i18n } = useTranslation();
  const expiryId = useId();
  const urlId = useId();
  // '' is "not chosen yet"; see `selectedExpiry` below.
  const [expiry, setExpiry] = useState<PublicLinkExpiryChoice | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  // Copying failed (no Clipboard API and execCommand refused): show the full
  // URL in a selectable field, the only other way to get it.
  const [copyFailed, setCopyFailed] = useState(false);
  const { copied, copy } = useCopyToClipboard();

  if (!config.enabled) return null;

  const link = isPublicLinkActive(note.public_link) ? note.public_link : null;
  // Creating defaults to no expiry. Changing starts unchosen, so the button
  // cannot quietly replace the link's current expiry with whatever the select
  // happened to show.
  const selectedExpiry = expiry || (link ? '' : 'never');

  // Creating and changing the expiry are the same request: PUT creates a link
  // when there is none and only moves the expiry of an active one.
  const handleSet = async () => {
    if (!selectedExpiry) return;
    setBusy(true);
    setError('');
    try {
      const updated = await notes.setPublicLink(note.id, { expires_at: publicLinkExpiresAt(selectedExpiry) });
      setExpiry('');
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
    try {
      await notes.deletePublicLink(note.id);
      setConfirmingRevoke(false);
      setExpiry('');
      setCopyFailed(false);
      onChange?.(note.id, null);
    } catch (err) {
      setConfirmingRevoke(false);
      setError(apiErrorMessage(err, t, 'publicLink.failed'));
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    setCopyFailed(!(await copy(url)));
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
  const shortUrl = shortPublicLinkUrl(url);
  const createdBy = link ? creatorLabel(link.created_by) : null;

  const buttonClassName = 'px-3 py-1.5 text-sm rounded-md border border-gray-300 dark:border-slate-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-slate-700 disabled:opacity-50';

  return (
    <section
      aria-labelledby={`${expiryId}-heading`}
      data-testid="public-link-section"
      className="mt-6 border-t border-gray-200 dark:border-slate-700 pt-4"
    >
      <h4 id={`${expiryId}-heading`} className="flex items-center text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
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

      {link && (
        <div className="mb-3">
          <div className="flex gap-2">
            {/* Shortened so the token, the only key to the note, stays out of
                screenshots and screen shares; Copy link copies the full URL. */}
            <p
              data-testid="public-link-url"
              className="min-w-0 flex-1 truncate rounded-md border border-gray-300 dark:border-slate-600 bg-gray-50 dark:bg-slate-700 text-gray-900 dark:text-gray-100 px-3 py-1.5 text-sm"
            >
              <span className="sr-only">{t('publicLink.urlA11y', { url: shortUrl })}</span>
              <span aria-hidden="true">{shortUrl}</span>
            </p>
            <button type="button" onClick={() => void handleCopy()} className={`${buttonClassName} flex items-center`}>
              {copied
                ? <Check aria-hidden="true" className="h-4 w-4 mr-1" />
                : <Copy aria-hidden="true" className="h-4 w-4 mr-1" />}
              {copied ? t('publicLink.copied') : t('publicLink.copy')}
            </button>
          </div>
          {copyFailed && (
            <div className="mt-2">
              <p role="alert" className="mb-1 text-sm text-red-700 dark:text-red-400">{t('publicLink.copyFailed')}</p>
              <label htmlFor={urlId} className="sr-only">{t('publicLink.urlLabel')}</label>
              <input
                id={urlId}
                type="text"
                readOnly
                autoFocus
                value={url}
                onFocus={(e) => e.currentTarget.select()}
                data-testid="public-link-full-url"
                className="w-full rounded-md border border-gray-300 dark:border-slate-600 bg-gray-50 dark:bg-slate-700 text-gray-900 dark:text-gray-100 px-3 py-1.5 text-sm"
              />
            </div>
          )}
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400" data-testid="public-link-details">
            {link.expires_at
              ? t('publicLink.expiresOn', { date: formatDate(link.expires_at) })
              : t('publicLink.neverExpires')}
            {createdBy && <> · {createdBy}</>}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={expiryId} className="text-sm text-gray-700 dark:text-gray-300">
          {link ? t('publicLink.newExpiry') : t('publicLink.expiry')}
        </label>
        <select
          id={expiryId}
          value={selectedExpiry}
          onChange={(e) => setExpiry(e.target.value as PublicLinkExpiryChoice)}
          disabled={busy}
          className="rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-gray-100 px-2 py-1.5 text-sm"
        >
          {selectedExpiry === '' && <option value="" disabled>{t('publicLink.chooseExpiry')}</option>}
          {PUBLIC_LINK_EXPIRY_CHOICES.map(choice => (
            <option key={choice} value={choice}>{t(EXPIRY_LABEL_KEYS[choice])}</option>
          ))}
        </select>
        <button type="button" onClick={() => void handleSet()} disabled={busy || !selectedExpiry} className={buttonClassName}>
          {link ? t('publicLink.changeExpiry') : t('publicLink.create')}
        </button>
        {link && (
          <button
            type="button"
            onClick={() => setConfirmingRevoke(true)}
            disabled={busy}
            className="px-3 py-1.5 text-sm text-red-700 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 disabled:opacity-50"
          >
            {t('publicLink.revoke')}
          </button>
        )}
      </div>

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
