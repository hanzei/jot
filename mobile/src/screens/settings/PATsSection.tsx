import { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Share,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../theme/ThemeContext';
import { listPATs, createPAT, revokePAT } from '../../api/settings';
import { subscribeToClientActiveServerChanges } from '../../api/client';
import { getActiveServer } from '../../store/serverAccounts';
import { displayMessage, getCurrentLocale } from '../../i18n/utils';
import { useConfirm } from '../../hooks/useConfirm';
import { VALIDATION } from '@jot/shared';
import type { PersonalAccessToken } from '@jot/shared';
import { styles } from './styles';

export default function PATsSection() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { confirm } = useConfirm();
  const isMountedRef = useRef(true);
  const previousServerUrlRef = useRef<string | null | undefined>(undefined);

  const [pats, setPats] = useState<PersonalAccessToken[]>([]);
  const [patsLoading, setPatsLoading] = useState(true);
  const [patsError, setPatsError] = useState('');
  const [newPATName, setNewPATName] = useState('');
  const [creatingPAT, setCreatingPAT] = useState(false);
  const [revokingPATId, setRevokingPATId] = useState<string | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    const loadPATs = async () => {
      try {
        const activeServer = await getActiveServer();
        if (!mounted) return;
        const nextServerUrl = activeServer?.serverUrl ?? null;
        if (previousServerUrlRef.current !== nextServerUrl) {
          previousServerUrlRef.current = nextServerUrl;
          const serverUrl = nextServerUrl;
          setPats([]);
          setPatsError('');
          setPatsLoading(true);
          void listPATs()
            .then((nextPATs) => {
              if (mounted && previousServerUrlRef.current === serverUrl) setPats(nextPATs);
            })
            .catch(() => {
              if (mounted && previousServerUrlRef.current === serverUrl) setPatsError('settings.patsLoadError');
            })
            .finally(() => {
              if (mounted && previousServerUrlRef.current === serverUrl) setPatsLoading(false);
            });
        }
      } catch {
        if (!mounted) return;
        previousServerUrlRef.current = null;
        setPats([]);
        setPatsLoading(false);
        setPatsError('settings.patsLoadError');
      }
    };

    void loadPATs();
    const unsubscribe = subscribeToClientActiveServerChanges(() => {
      void loadPATs();
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const handleCreatePAT = useCallback(async () => {
    const name = newPATName.trim();
    if (!name || creatingPAT) return;
    setCreatingPAT(true);
    setPatsError('');
    try {
      const pat = await createPAT({ name });
      if (!isMountedRef.current) return;
      setPats(prev => [pat, ...prev]);
      setNewPATName('');
      if (pat.token) {
        void Share.share({
          message: pat.token,
          title: t('settings.patsNewTokenTitle'),
        });
      }
    } catch {
      if (!isMountedRef.current) return;
      setPatsError('settings.patsCreateError');
    } finally {
      if (isMountedRef.current) setCreatingPAT(false);
    }
  }, [newPATName, creatingPAT, t]);

  const handleRevokePAT = useCallback(async (id: string, name: string) => {
    const confirmed = await confirm({
      title: t('settings.patsRevokeConfirmTitle'),
      message: t('settings.patsRevokeConfirmMessage', { name }),
      confirmLabel: t('settings.patsRevoke'),
      destructive: true,
    });
    if (!confirmed) return;
    setRevokingPATId(id);
    try {
      await revokePAT(id);
      if (!isMountedRef.current) return;
      setPats(prev => prev.filter(p => p.id !== id));
    } catch {
      if (!isMountedRef.current) return;
      setPatsError('settings.patsRevokeError');
    } finally {
      if (isMountedRef.current) setRevokingPATId(null);
    }
  }, [confirm, t]);

  const currentLocale = getCurrentLocale();

  return (
    <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('settings.patsSection')}</Text>
      <Text style={[styles.sectionDescription, { color: colors.textSecondary }]}>
        {t('settings.patsDescription')}
      </Text>
      <View style={styles.patCreateRow}>
        <TextInput
          style={[styles.patNameInput, { backgroundColor: colors.inputBackground, borderColor: colors.border, color: colors.text }]}
          value={newPATName}
          onChangeText={setNewPATName}
          placeholder={t('settings.patsNamePlaceholder')}
          placeholderTextColor={colors.textMuted}
          // maxLength counts UTF-16 units while the server counts code points, so
          // astral input is cut early. Accepted here: the limit is generous and a
          // silently shortened token name is a smaller cost than hand-rolling the
          // input-level enforcement TextInput gives for free (see issue #772).
          maxLength={VALIDATION.PAT_NAME_MAX_LENGTH}
          returnKeyType="done"
          onSubmitEditing={() => { void handleCreatePAT(); }}
        />
        <TouchableOpacity
          style={[styles.patCreateButton, { backgroundColor: colors.primary }, (creatingPAT || !newPATName.trim()) && styles.buttonDisabled]}
          onPress={() => { void handleCreatePAT(); }}
          disabled={creatingPAT || !newPATName.trim()}
          accessibilityRole="button"
          accessibilityLabel={t('settings.patsCreate')}
        >
          <Text style={styles.patCreateButtonText}>
            {creatingPAT ? t('settings.patsCreating') : t('settings.patsCreate')}
          </Text>
        </TouchableOpacity>
      </View>
      {patsError !== '' && (
        <Text style={[styles.errorText, { color: colors.error }]}>{displayMessage(t, patsError)}</Text>
      )}
      {patsLoading ? (
        <ActivityIndicator size="small" color={colors.primary} style={styles.sectionLoader} />
      ) : pats.length === 0 ? (
        <Text style={[styles.sectionDescription, { color: colors.textSecondary }]}>
          {t('settings.patsNone')}
        </Text>
      ) : (
        <View style={styles.sessionsList}>
          {pats.map((pat: PersonalAccessToken) => (
            <View key={pat.id} style={[styles.sessionItem, { borderColor: colors.border }]}>
              <View style={styles.sessionInfo}>
                <Text style={[styles.sessionBrowser, { color: colors.text }]}>{pat.name}</Text>
                <Text style={[styles.sessionDate, { color: colors.textMuted }]}>
                  {new Date(pat.created_at).toLocaleDateString(currentLocale, {
                    year: 'numeric', month: 'short', day: 'numeric',
                  })}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => handleRevokePAT(pat.id, pat.name)}
                disabled={revokingPATId === pat.id}
                style={styles.revokeButton}
                accessibilityRole="button"
                accessibilityLabel={t('settings.patsRevoke')}
              >
                <Text style={[
                  styles.revokeText,
                  { color: colors.error },
                  revokingPATId === pat.id && styles.buttonDisabled,
                ]}>
                  {revokingPATId === pat.id ? t('settings.patsRevoking') : t('settings.patsRevoke')}
                </Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
