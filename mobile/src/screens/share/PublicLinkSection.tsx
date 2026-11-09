import { useRef, useState, useSyncExternalStore } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Share } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Link2, Share2 } from 'lucide-react-native';
import { userDisplayName, type PublicLink, type User } from '@jot/shared';
import { useTheme } from '../../theme/ThemeContext';
import { useConfirm } from '../../hooks/useConfirm';
import { useNetworkStatus } from '../../hooks/useNetworkStatus';
import { useServerConfig } from '../../hooks/useServerConfig';
import { useActiveServerBaseUrl } from '../../hooks/useActiveServerBaseUrl';
import { usePublicLinkActions } from '../../hooks/usePublicLink';
import { isOnlineWriteAllowed, isServerReachable, subscribeToServerReachability } from '../../api/serverReachability';
import { displayMessage, errorMessageKey, getCurrentLocale } from '../../i18n/utils';
import {
  PUBLIC_LINK_EXPIRY_CHOICES,
  isPublicLinkActive,
  publicLinkExpiresAt,
  publicLinkUrl,
  type PublicLinkExpiryChoice,
} from '../../utils/publicLink';
import FormatRadioGroup, { type FormatOption } from '../settings/FormatRadioGroup';

interface PublicLinkSectionProps {
  noteId: string;
  /** The note's cached link, which SSE `note_updated` events keep current. */
  publicLink: PublicLink | null | undefined;
  currentUserId: string | undefined;
  /** The user directory, to name who created the link. */
  usersById: ReadonlyMap<string, User>;
}

const EXPIRY_OPTIONS: FormatOption<PublicLinkExpiryChoice>[] = PUBLIC_LINK_EXPIRY_CHOICES.map((value) => ({
  value,
  labelKey: {
    never: 'publicLink.expiryNever',
    '7d': 'publicLink.expiry7Days',
    '30d': 'publicLink.expiry30Days',
    '3m': 'publicLink.expiry3Months',
  }[value],
}));

/**
 * The share screen's "Public link" section, for the owner and collaborators
 * alike: create a read-only link with an expiry, share it, change the expiry
 * (same URL), or revoke it for everyone. Mirrors the webapp's
 * PublicLinkSection. Changes are online-only one-shot requests, never queued:
 * while the server can't be reached the section says so instead.
 */
export default function PublicLinkSection({ noteId, publicLink, currentUserId, usersById }: PublicLinkSectionProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { confirm } = useConfirm();
  const config = useServerConfig();
  const serverUrl = useActiveServerBaseUrl();
  const { isConnected } = useNetworkStatus();
  // Subscribed only to re-render when reachability flips; isOnlineWriteAllowed reads it.
  useSyncExternalStore(subscribeToServerReachability, isServerReachable);
  const online = isOnlineWriteAllowed(isConnected);
  const { setLink, revoke } = usePublicLinkActions(noteId);
  // '' is "not chosen yet"; see `selectedExpiry` below.
  const [expiry, setExpiry] = useState<PublicLinkExpiryChoice | ''>('');
  const [busy, setBusy] = useState(false);
  // Set synchronously, so a second tap before `busy` re-renders is ignored.
  const busyRef = useRef(false);
  // An i18n key or a server message, for displayMessage.
  const [error, setError] = useState('');

  // Off on this server, or a server too old to know public links.
  if (config.public_links_enabled !== true) return null;

  const link = isPublicLinkActive(publicLink) ? publicLink : null;
  // Creating defaults to no expiry. Changing starts unchosen, so the button
  // cannot quietly replace the link's current expiry with whatever was shown.
  const selectedExpiry = expiry || (link ? '' : 'never');
  const controlsDisabled = busy || !online;
  const submitDisabled = controlsDisabled || !selectedExpiry;

  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
      setExpiry('');
    } catch (err) {
      setError(errorMessageKey(err) ?? 'publicLink.failed');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // Creating and changing the expiry are the same request: PUT creates a link
  // when there is none and only moves the expiry of an active one.
  const handleSet = () => {
    if (!selectedExpiry) return;
    void run(() => setLink(publicLinkExpiresAt(selectedExpiry)));
  };

  const handleRevoke = async () => {
    if (busyRef.current) return;
    const confirmed = await confirm({
      title: t('publicLink.revokeTitle'),
      message: t('publicLink.revokeMessage'),
      confirmLabel: t('publicLink.revokeConfirm'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    });
    if (confirmed) await run(revoke);
  };

  const url = link ? publicLinkUrl(link, config.public_url, serverUrl) : '';

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString(getCurrentLocale(), { year: 'numeric', month: 'short', day: 'numeric' });

  const creatorLabel = (createdBy: string | null) => {
    if (createdBy === null) return t('publicLink.createdByFormer');
    if (createdBy === currentUserId) return t('publicLink.createdByYou');
    const creator = usersById.get(createdBy);
    return creator ? t('publicLink.createdBy', { name: userDisplayName(creator) }) : null;
  };
  const createdBy = link ? creatorLabel(link.created_by) : null;

  return (
    <View style={[styles.section, { borderTopColor: colors.borderLight }]} testID="public-link-section">
      <View style={styles.titleRow}>
        <Link2 size={14} color={colors.textMuted} />
        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>{t('publicLink.heading')}</Text>
      </View>
      <Text style={[styles.description, { color: colors.textSecondary }]}>{t('publicLink.description')}</Text>

      {link && (
        <View style={styles.linkBlock}>
          <View style={[styles.urlRow, { borderColor: colors.border, backgroundColor: colors.inputBackground }]}>
            <Text selectable style={[styles.url, { color: colors.text }]} testID="public-link-url">{url}</Text>
          </View>
          <Text style={[styles.details, { color: colors.textMuted }]} testID="public-link-details">
            {link.expires_at
              ? t('publicLink.expiresOn', { date: formatDate(link.expires_at) })
              : t('publicLink.neverExpires')}
            {createdBy && ` · ${createdBy}`}
          </Text>
          {/* No clipboard module in the app: the system share sheet offers Copy
              alongside every app the link can be sent to. */}
          <TouchableOpacity
            onPress={() => void Share.share({ message: url }).catch(() => {})}
            style={[styles.button, styles.shareButton, { borderColor: colors.border }]}
            testID="public-link-share"
            accessibilityRole="button"
          >
            <Share2 size={16} color={colors.primary} />
            <Text style={[styles.buttonText, { color: colors.primary }]}>{t('publicLink.share')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {!online && (
        <Text style={[styles.description, { color: colors.textMuted }]} testID="public-link-offline">
          {t('publicLink.offline')}
        </Text>
      )}
      {error !== '' && (
        <Text style={[styles.error, { color: colors.error }]} testID="public-link-error" accessibilityRole="alert">
          {displayMessage(t, error)}
        </Text>
      )}

      <FormatRadioGroup<PublicLinkExpiryChoice | ''>
        labelKey={link ? 'publicLink.newExpiry' : 'publicLink.expiry'}
        options={EXPIRY_OPTIONS}
        value={selectedExpiry}
        onChange={setExpiry}
        disabled={controlsDisabled}
        testIDPrefix="public-link-expiry"
      />
      <View style={styles.actions}>
        <TouchableOpacity
          onPress={handleSet}
          disabled={submitDisabled}
          style={[
            styles.button,
            { backgroundColor: colors.primary, borderColor: colors.primary },
            submitDisabled && styles.disabled,
          ]}
          testID="public-link-submit"
          accessibilityRole="button"
          accessibilityState={{ disabled: submitDisabled, busy }}
        >
          <Text style={[styles.buttonText, styles.primaryButtonText]}>
            {link ? t('publicLink.changeExpiry') : t('publicLink.create')}
          </Text>
        </TouchableOpacity>
        {link && (
          <TouchableOpacity
            onPress={() => void handleRevoke()}
            disabled={controlsDisabled}
            style={[styles.button, controlsDisabled && styles.disabled]}
            testID="public-link-revoke"
            accessibilityRole="button"
            accessibilityState={{ disabled: controlsDisabled }}
          >
            <Text style={[styles.buttonText, { color: colors.error }]}>{t('publicLink.revoke')}</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: 24,
    paddingTop: 16,
    paddingHorizontal: 16,
    borderTopWidth: 1,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  description: {
    fontSize: 13,
    marginBottom: 12,
  },
  linkBlock: {
    marginBottom: 12,
  },
  urlRow: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  url: {
    fontSize: 14,
  },
  details: {
    fontSize: 13,
    marginTop: 6,
  },
  error: {
    fontSize: 13,
    marginBottom: 12,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: 'transparent',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  shareButton: {
    alignSelf: 'flex-start',
    marginTop: 10,
  },
  buttonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  primaryButtonText: {
    color: '#fff',
  },
  disabled: {
    opacity: 0.5,
  },
});
