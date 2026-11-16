import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';
import { useTranslation } from 'react-i18next';
import { useAuth } from './AuthContext';
import { useTheme } from '../theme/ThemeContext';
import { claimLocalData } from '../db/accountOwner';
import { isClosedDatabaseError } from '../db/errors';

interface ClaimResult {
  userId: string;
  ok: boolean;
}

/**
 * Holds back everything that reads the local database or drains its queue
 * until the signed-in user owns that data (issue #1264, spec §8.6). When the
 * database belongs to another account — the previous user's session ended
 * with a 401 and someone else signed in — `claimLocalData` wipes it first.
 *
 * Mounted inside the `SQLiteProvider` for `serverId`, around the provider
 * tree that syncs and the screens that read. The check runs once per sign-in:
 * signing out resets it, so the next sign-in, whoever it is, checks again.
 *
 * It applies only when `user` was signed in to this database's server. Right
 * after a server switch `user` can still be the previous server's account
 * until revalidation replaces it, and that id means nothing to this database.
 * Local mode has no server account and is never gated.
 */
export function AccountDataGate({ serverId, children }: { serverId: string | null; children: React.ReactNode }) {
  const { user, userServerId, isLocalMode } = useAuth();
  const db = useSQLiteContext();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [result, setResult] = useState<ClaimResult | null>(null);
  const [attempt, setAttempt] = useState(0);

  const userId = user?.id ?? null;
  const claimUserId = !isLocalMode && userId !== null && serverId !== null && userServerId === serverId ? userId : null;

  useEffect(() => {
    if (claimUserId === null) return;
    let cancelled = false;
    claimLocalData(db, claimUserId).then(
      () => {
        if (!cancelled) setResult({ userId: claimUserId, ok: true });
      },
      (error: unknown) => {
        // A server switch closed this handle; the next provider instance checks its own database.
        if (cancelled || isClosedDatabaseError(error)) return;
        console.warn('Failed to check which account owns the local data:', error);
        setResult({ userId: claimUserId, ok: false });
      },
    );
    return () => {
      cancelled = true;
      // Forget the verdict when the user signs out (or anything else re-runs
      // this), so the next sign-in is checked rather than trusted.
      setResult(null);
    };
  }, [db, claimUserId, attempt]);

  if (claimUserId === null || (result?.userId === claimUserId && result.ok)) {
    return children;
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]} testID="account-data-gate">
      {result?.userId === claimUserId ? (
        <>
          <Text style={[styles.message, { color: colors.text }]}>{t('common.dbOpenError')}</Text>
          <TouchableOpacity
            onPress={() => setAttempt((prev) => prev + 1)}
            style={styles.retry}
            testID="account-data-gate-retry"
          >
            <Text style={{ color: colors.primary }}>{t('common.retry')}</Text>
          </TouchableOpacity>
        </>
      ) : (
        <ActivityIndicator size="large" color={colors.primary} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24 },
  message: { textAlign: 'center', marginBottom: 12 },
  retry: { paddingHorizontal: 14, paddingVertical: 10 },
});
