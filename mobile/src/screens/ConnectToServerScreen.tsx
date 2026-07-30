import React, { useContext, useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { CircleCheck, CircleX, TriangleAlert, X } from 'lucide-react-native';
import { useSQLiteContext } from 'expo-sqlite';
import { useQueryClient } from '@tanstack/react-query';
import { useTheme } from '../theme/ThemeContext';
import { probeServerReachability } from '../api/client';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { USERNAME_EDGE_PATTERN, USERNAME_PATTERN, VALIDATION } from '@jot/shared';
import { displayMessage } from '../i18n/utils';
import {
  registerOnServer,
  runPreflightChecks,
  seedReplayQueue,
  configureMigrationApiClient,
  runMigrationDrainPass,
  flipToServerMode,
  runBackgroundReconcileScopes,
} from '../store/upgradeToServer';
import type { PreflightFailReason, UpgradeSession } from '../store/upgradeToServer';
import { getLocalIdentity } from '../store/localMode';
import { getDeadLetterCount } from '../db/syncQueue';
import { useAuth } from '../store/AuthContext';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { retrySync } from '../utils/retryWithBackoff';
import { notesLocalQueryScopeKey, labelsQueryKey } from '../hooks/queryKeys';
import FadeInView from '../components/FadeInView';

const DRAIN_BACKOFF_BASE_MS = 1000;
const DRAIN_BACKOFF_MAX_MS = 60000;
const MAX_DRAIN_RETRIES = 6;

type Step =
  | { name: 'serverUrl' }
  | { name: 'register'; serverUrl: string }
  | { name: 'checking'; serverUrl: string }
  | { name: 'seeding'; session: UpgradeSession }
  | { name: 'migrating'; session: UpgradeSession; processed: number; total: number }
  | { name: 'deadLetter'; session: UpgradeSession; processed: number; total: number; deadLetterCount: number }
  | { name: 'migrationComplete' }
  | { name: 'error'; reason: PreflightFailReason | 'REGISTRATION_FAILED' | 'UNREACHABLE' | 'INVALID_SERVER' | 'MIGRATION_FAILED' | string };

type ReconcileState = 'pending' | 'success' | 'failed';

export default function ConnectToServerScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useContext(SafeAreaInsetsContext) ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const { completeServerUpgrade } = useAuth();
  const { isConnected } = useNetworkStatus();
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  const [step, setStep] = useState<Step>({ name: 'serverUrl' });
  const [serverUrlInput, setServerUrlInput] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reconcileState, setReconcileState] = useState<ReconcileState>('pending');

  const isMountedRef = useRef(true);
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Whether the user can dismiss the screen (not during active migration).
  const isDismissable =
    step.name !== 'seeding' &&
    step.name !== 'migrating' &&
    step.name !== 'deadLetter';

  // Re-read the dead-letter count whenever the screen regains focus so the
  // "Retry migration" button reflects resolutions made in SyncFailuresScreen.
  useFocusEffect(
    useCallback(() => {
      if (step.name !== 'deadLetter') return;
      getDeadLetterCount(db)
        .then((count) => {
          if (!isMountedRef.current) return;
          setStep((prev) =>
            prev.name === 'deadLetter' ? { ...prev, deadLetterCount: count } : prev,
          );
        })
        .catch(() => {});
    }, [step.name, db]),
  );

  const performBackgroundReconcile = useCallback(async () => {
    try {
      await retrySync(() => runBackgroundReconcileScopes(db), {
        isConnected: () => isConnectedRef.current,
      });
      if (!isMountedRef.current) return;
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: labelsQueryKey() });
      setReconcileState('success');
    } catch {
      if (!isMountedRef.current) return;
      setReconcileState('failed');
    }
  }, [db, queryClient]);

  // Shared Phase 4 completion: verify clean drain, flip, update auth, and
  // kick off background reconcile. Used by both the drain-loop success path
  // and the zero-enqueued fast path.
  const performCompletionFlow = useCallback(async () => {
    const flipResult = await flipToServerMode(db);
    if (!isMountedRef.current) return;
    if (!flipResult.ok) {
      setStep({ name: 'error', reason: 'MIGRATION_FAILED' });
      return;
    }
    await completeServerUpgrade();
    if (!isMountedRef.current) return;
    setStep({ name: 'migrationComplete' });
    setReconcileState('pending');
    void performBackgroundReconcile();
  }, [db, completeServerUpgrade, performBackgroundReconcile]);

  const runDrainLoop = useCallback(
    async (session: UpgradeSession, total: number) => {
      let retryDelay = DRAIN_BACKOFF_BASE_MS;

      for (let attempt = 0; attempt < MAX_DRAIN_RETRIES; attempt++) {
        if (!isMountedRef.current) return;

        const result = await runMigrationDrainPass(db, total);

        if (!isMountedRef.current) return;

        if (result.status === 'success') {
          await performCompletionFlow();
          return;
        }

        if (result.status === 'dead_letter') {
          setStep({
            name: 'deadLetter',
            session,
            processed: result.processed,
            total,
            deadLetterCount: result.deadLetterCount,
          });
          return;
        }

        // Stalled (transient failure) — update progress and retry with backoff.
        setStep({ name: 'migrating', session, processed: result.processed, total });

        if (attempt < MAX_DRAIN_RETRIES - 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, retryDelay));
          retryDelay = Math.min(retryDelay * 2, DRAIN_BACKOFF_MAX_MS);
        }
      }

      if (isMountedRef.current) {
        setStep({ name: 'error', reason: 'MIGRATION_FAILED' });
      }
    },
    [db, performCompletionFlow],
  );

  const startMigration = useCallback(
    async (session: UpgradeSession) => {
      try {
        const identity = await getLocalIdentity();
        if (!identity) {
          if (isMountedRef.current) setStep({ name: 'error', reason: 'MIGRATION_FAILED' });
          return;
        }

        await configureMigrationApiClient(session);
        const { totalEnqueued } = await seedReplayQueue(db, identity);

        if (!isMountedRef.current) return;

        if (totalEnqueued === 0) {
          // Nothing to drain — still run Phase 4 (flip + auth update + reconcile).
          await performCompletionFlow();
          return;
        }

        setStep({ name: 'migrating', session, processed: 0, total: totalEnqueued });
        await runDrainLoop(session, totalEnqueued);
      } catch (err) {
        console.warn('Migration failed during setup or seeding:', err);
        if (isMountedRef.current) {
          setStep({ name: 'error', reason: 'MIGRATION_FAILED' });
        }
      }
    },
    [db, runDrainLoop, performCompletionFlow],
  );

  const handleCheckServer = async () => {
    setFieldError('');
    const trimmed = serverUrlInput.trim();
    if (!trimmed) {
      setFieldError(t('auth.serverUrlRequired'));
      return;
    }
    setBusy(true);
    try {
      const probe = await probeServerReachability(trimmed);
      if (!probe.ok) {
        if (probe.reason === 'INVALID_URL') {
          setFieldError(t('auth.serverUrlProtocol'));
        } else if (probe.reason === 'AUTH_ENDPOINT_UNAVAILABLE') {
          setFieldError(t('auth.serverSetupConnectionInvalidServer'));
        } else {
          setFieldError(t('auth.serverSetupConnectionFailed'));
        }
        return;
      }
      setServerUrlInput(probe.canonicalUrl);
      setStep({ name: 'register', serverUrl: probe.canonicalUrl });
    } catch {
      setFieldError(t('auth.serverSetupConnectionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const validateRegistration = (): string | null => {
    const trimmedUsername = username.trim();
    if (!trimmedUsername) return t('auth.usernameRequired');
    if (trimmedUsername.length < VALIDATION.USERNAME_MIN_LENGTH) return t('auth.usernameMin');
    if (trimmedUsername.length > VALIDATION.USERNAME_MAX_LENGTH) return t('auth.usernameMax');
    if (!USERNAME_PATTERN.test(trimmedUsername)) return t('auth.usernameChars');
    if (USERNAME_EDGE_PATTERN.test(trimmedUsername)) return t('auth.usernameEdge');
    if (!password.trim()) return t('auth.passwordRequired');
    if ([...password].length < VALIDATION.PASSWORD_MIN_LENGTH) {
      return t('auth.passwordMin', { min: VALIDATION.PASSWORD_MIN_LENGTH });
    }
    return null;
  };

  const handleRegister = async () => {
    if (step.name !== 'register') return;
    const validationError = validateRegistration();
    if (validationError) {
      setFieldError(validationError);
      return;
    }
    setFieldError('');
    setBusy(true);
    const serverUrl = step.serverUrl;
    try {
      const session = await registerOnServer(serverUrl, username.trim(), password);
      setStep({ name: 'checking', serverUrl });
      const result = await runPreflightChecks(session);
      if (result.ok) {
        setStep({ name: 'seeding', session });
        void startMigration(session);
      } else {
        setStep({ name: 'error', reason: result.reason });
      }
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'USERNAME_TAKEN') {
        setFieldError(t('upgrade.usernameTaken'));
        setStep({ name: 'register', serverUrl });
      } else if (code === 'INVALID_URL' || code === 'NO_SESSION') {
        setStep({ name: 'error', reason: 'UNREACHABLE' });
      } else {
        setStep({ name: 'error', reason: 'REGISTRATION_FAILED' });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleRetryMigration = useCallback(async () => {
    if (step.name !== 'deadLetter') return;
    const count = await getDeadLetterCount(db).catch(() => 1);
    if (count > 0 || !isMountedRef.current) return;
    const { session, processed, total } = step;
    setStep({ name: 'migrating', session, processed, total });
    try {
      await runDrainLoop(session, total);
    } catch (err) {
      console.warn('Migration retry failed unexpectedly:', err);
      if (isMountedRef.current) {
        setStep({ name: 'deadLetter', session, processed, total, deadLetterCount: 0 });
      }
    }
  }, [step, db, runDrainLoop]);

  function preflightErrorMessage(reason: string): string {
    switch (reason) {
      case 'CLIENT_ID_NOT_HONORED':
      case 'DEDUP_409_MISSING':
      case 'ENDPOINT_SHAPE_ERROR':
        return t('upgrade.capabilityFailed');
      case 'NOTES_NOT_EMPTY':
      case 'LABELS_NOT_EMPTY':
        return t('upgrade.emptinessFailed');
      case 'FETCH_FAILED':
        return t('upgrade.fetchFailed');
      case 'UNREACHABLE':
        return t('auth.serverSetupConnectionFailed');
      case 'INVALID_SERVER':
        return t('auth.serverSetupConnectionInvalidServer');
      case 'MIGRATION_FAILED':
        return t('upgrade.migrationFailed');
      default:
        return displayMessage(t, reason);
    }
  }

  const renderContent = () => {
    if (step.name === 'serverUrl') {
      return (
        <>
          <Text style={[styles.title, { color: colors.text }]}>{t('upgrade.title')}</Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{t('upgrade.subtitle')}</Text>

          {fieldError ? (
            <FadeInView>
              <Text style={[styles.error, { color: colors.error }]} accessibilityRole="alert" accessibilityLiveRegion="polite">
                {fieldError}
              </Text>
            </FadeInView>
          ) : null}

          <Text style={[styles.label, { color: colors.textSecondary }]}>{t('upgrade.serverUrlLabel')}</Text>
          <TextInput
            style={[styles.input, { backgroundColor: colors.inputBackground, borderColor: colors.inputBorder, color: colors.text }]}
            placeholder={t('upgrade.serverUrlPlaceholder')}
            placeholderTextColor={colors.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            value={serverUrlInput}
            onChangeText={setServerUrlInput}
            testID="upgrade-server-url-input"
            accessibilityLabel={t('upgrade.serverUrlLabel')}
          />

          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: colors.primary }, busy && styles.buttonDisabled]}
            onPress={handleCheckServer}
            disabled={busy}
            testID="upgrade-server-url-submit"
            accessibilityRole="button"
            accessibilityLabel={busy ? t('common.loading') : t('upgrade.continue')}
            accessibilityState={{ disabled: busy, busy }}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>{t('upgrade.continue')}</Text>}
          </TouchableOpacity>
        </>
      );
    }

    if (step.name === 'register') {
      return (
        <>
          <Text style={[styles.title, { color: colors.text }]}>{t('upgrade.registerTitle')}</Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{step.serverUrl}</Text>

          {fieldError ? (
            <FadeInView>
              <Text style={[styles.error, { color: colors.error }]} accessibilityRole="alert" accessibilityLiveRegion="polite">
                {fieldError}
              </Text>
            </FadeInView>
          ) : null}

          <TextInput
            style={[styles.input, { backgroundColor: colors.inputBackground, borderColor: colors.inputBorder, color: colors.text }]}
            placeholder={t('auth.usernamePlaceholderLong')}
            placeholderTextColor={colors.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            value={username}
            onChangeText={setUsername}
            testID="upgrade-username-input"
            accessibilityLabel={t('settings.usernameLabel')}
          />

          <TextInput
            style={[styles.input, { backgroundColor: colors.inputBackground, borderColor: colors.inputBorder, color: colors.text }]}
            placeholder={t('auth.passwordPlaceholderLong')}
            placeholderTextColor={colors.placeholder}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            value={password}
            onChangeText={setPassword}
            testID="upgrade-password-input"
            accessibilityLabel={t('auth.passwordPlaceholder')}
          />

          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: colors.primary }, busy && styles.buttonDisabled]}
            onPress={handleRegister}
            disabled={busy}
            testID="upgrade-register-button"
            accessibilityRole="button"
            accessibilityLabel={busy ? t('auth.creatingAccount') : t('auth.createAccount')}
            accessibilityState={{ disabled: busy, busy }}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>{t('auth.createAccount')}</Text>}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.backLink}
            onPress={() => { setFieldError(''); setStep({ name: 'serverUrl' }); }}
            testID="upgrade-back-to-server-url"
            accessibilityRole="button"
          >
            <Text style={[styles.backLinkText, { color: colors.primary }]}>{t('upgrade.changeServer')}</Text>
          </TouchableOpacity>
        </>
      );
    }

    if (step.name === 'checking' || step.name === 'seeding') {
      return (
        <View style={styles.centeredState}>
          <ActivityIndicator size="large" color={colors.primary} style={styles.checkingSpinner} />
          <Text style={[styles.checkingTitle, { color: colors.text }]}>
            {step.name === 'seeding' ? t('upgrade.seedingTitle') : t('upgrade.checkingTitle')}
          </Text>
          <Text style={[styles.checkingSubtitle, { color: colors.textSecondary }]}>
            {step.name === 'seeding' ? step.session.serverUrl : step.serverUrl}
          </Text>
        </View>
      );
    }

    if (step.name === 'migrating') {
      const progress = step.total > 0 ? step.processed / step.total : 0;
      return (
        <View style={styles.centeredState}>
          <Text style={[styles.checkingTitle, { color: colors.text }]}>{t('upgrade.migratingTitle')}</Text>
          <Text style={[styles.checkingSubtitle, { color: colors.textSecondary }]}>
            {t('upgrade.migratingProgress', { processed: step.processed, total: step.total })}
          </Text>
          <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
            <View
              style={[
                styles.progressFill,
                {
                  width: `${Math.min(Math.round(progress * 100), 100)}%`,
                  backgroundColor: colors.primary,
                },
              ]}
            />
          </View>
        </View>
      );
    }

    if (step.name === 'deadLetter') {
      const allResolved = step.deadLetterCount === 0;
      return (
        <View style={styles.centeredState}>
          <TriangleAlert size={64} color={colors.warningText} style={styles.resultIcon} />
          <Text style={[styles.resultTitle, { color: colors.text }]}>{t('upgrade.deadLetterTitle')}</Text>
          <Text style={[styles.resultSubtitle, { color: colors.textSecondary }]}>
            {t('upgrade.deadLetterSubtitle', { count: step.deadLetterCount })}
          </Text>
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: colors.primary }]}
            onPress={() => navigation.navigate('SyncFailures')}
            testID="upgrade-review-failures"
            accessibilityRole="button"
            accessibilityLabel={t('upgrade.reviewFailedChanges')}
          >
            <Text style={styles.primaryButtonText}>{t('upgrade.reviewFailedChanges')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.primaryButton,
              styles.retryButton,
              { borderColor: colors.primary },
              !allResolved && styles.buttonDisabled,
            ]}
            onPress={() => { void handleRetryMigration(); }}
            disabled={!allResolved}
            testID="upgrade-retry-migration"
            accessibilityRole="button"
            accessibilityLabel={t('upgrade.retryMigration')}
            accessibilityState={{ disabled: !allResolved }}
          >
            <Text style={[styles.retryButtonText, { color: colors.primary }]}>{t('upgrade.retryMigration')}</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (step.name === 'migrationComplete') {
      return (
        <View style={styles.centeredState}>
          <CircleCheck size={64} color={colors.success} style={styles.resultIcon} />
          <Text style={[styles.resultTitle, { color: colors.text }]}>{t('upgrade.migrationCompleteTitle')}</Text>
          <Text style={[styles.resultSubtitle, { color: colors.textSecondary }]}>{t('upgrade.migrationCompleteSubtitle')}</Text>

          {reconcileState === 'pending' && (
            <View style={styles.reconcileRow}>
              <ActivityIndicator size="small" color={colors.primary} style={styles.reconcileSpinner} />
              <Text style={[styles.reconcileText, { color: colors.textSecondary }]}>{t('upgrade.reconciling')}</Text>
            </View>
          )}
          {reconcileState === 'failed' && (
            <View style={styles.reconcileRow}>
              <Text style={[styles.reconcileText, { color: colors.textSecondary }]}>{t('upgrade.reconcileFailed')}</Text>
              <TouchableOpacity
                onPress={() => {
                  setReconcileState('pending');
                  void performBackgroundReconcile();
                }}
                testID="upgrade-resync-button"
                accessibilityRole="button"
                accessibilityLabel={t('upgrade.resync')}
              >
                <Text style={[styles.resyncLink, { color: colors.primary }]}>{t('upgrade.resync')}</Text>
              </TouchableOpacity>
            </View>
          )}

          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: colors.primary }]}
            onPress={() => navigation.goBack()}
            testID="upgrade-migration-done"
            accessibilityRole="button"
            accessibilityLabel={t('common.done')}
          >
            <Text style={styles.primaryButtonText}>{t('common.done')}</Text>
          </TouchableOpacity>
        </View>
      );
    }

    // error step
    return (
      <View style={styles.centeredState}>
        <CircleX size={64} color={colors.error} style={styles.resultIcon} />
        <Text style={[styles.resultTitle, { color: colors.text }]}>{t('upgrade.errorTitle')}</Text>
        <Text style={[styles.resultSubtitle, { color: colors.textSecondary }]}>
          {preflightErrorMessage(step.reason)}
        </Text>
        <TouchableOpacity
          style={[styles.primaryButton, { backgroundColor: colors.primary }]}
          onPress={() => navigation.goBack()}
          testID="upgrade-error-cancel"
          accessibilityRole="button"
          accessibilityLabel={t('common.cancel')}
        >
          <Text style={styles.primaryButtonText}>{t('common.cancel')}</Text>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.surface }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={[styles.header, { paddingTop: insets.top, borderBottomColor: colors.borderLight, backgroundColor: colors.surface }]}>
        <TouchableOpacity
          onPress={isDismissable ? () => navigation.goBack() : undefined}
          style={styles.closeButton}
          testID="upgrade-close"
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
          disabled={!isDismissable}
        >
          <X size={24} color={isDismissable ? colors.text : colors.iconMuted} />
        </TouchableOpacity>
      </View>
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}
        keyboardShouldPersistTaps="handled"
      >
        {renderContent()}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  closeButton: {
    padding: 8,
  },
  scrollContent: {
    flexGrow: 1,
    padding: 24,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 20,
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    marginBottom: 12,
  },
  primaryButton: {
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  retryButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
  },
  retryButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  error: {
    textAlign: 'center',
    marginBottom: 16,
    fontSize: 14,
  },
  backLink: {
    marginTop: 16,
    alignItems: 'center',
  },
  backLinkText: {
    fontSize: 14,
  },
  centeredState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 32,
  },
  checkingSpinner: {
    marginBottom: 24,
  },
  checkingTitle: {
    fontSize: 20,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 8,
  },
  checkingSubtitle: {
    fontSize: 14,
    textAlign: 'center',
  },
  resultIcon: {
    marginBottom: 20,
  },
  resultTitle: {
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
  },
  resultSubtitle: {
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 32,
    lineHeight: 22,
    paddingHorizontal: 16,
  },
  progressTrack: {
    width: '100%',
    height: 8,
    borderRadius: 4,
    marginTop: 24,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 4,
    minWidth: 4,
  },
  reconcileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    paddingHorizontal: 16,
    flexWrap: 'wrap',
    gap: 6,
  },
  reconcileSpinner: {
    marginRight: 6,
  },
  reconcileText: {
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
  resyncLink: {
    fontSize: 13,
    fontWeight: '600',
  },
});
