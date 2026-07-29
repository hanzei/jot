import React, { useState, useEffect, useRef, useCallback, useMemo, useContext } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  StyleSheet,
  Alert,
  ScrollView,
} from 'react-native';
import { ArrowLeft, Plus, Search, X } from 'lucide-react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { searchUsers } from '../api/users';
import { useNoteShares, useShareNote, useUnshareNote } from '../hooks/useNotes';
import UserAvatar from '../components/UserAvatar';
import { useTheme } from '../theme/ThemeContext';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { isServerReachable } from '../api/serverReachability';
import { useUsers } from '../store/UsersContext';
import type { User, NoteShare } from '@jot/shared';
import type { RootStackParamList } from '../navigation/RootNavigator';

type ShareRouteProp = RouteProp<RootStackParamList, 'Share'>;

const SEARCH_DEBOUNCE_MS = 300;

export default function ShareScreen() {
  const navigation = useNavigation();
  const route = useRoute<ShareRouteProp>();
  const { noteId } = route.params;
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useContext(SafeAreaInsetsContext) ?? { top: 0, right: 0, bottom: 0, left: 0 };

  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { isConnected } = useNetworkStatus();
  const { usersById } = useUsers();

  const [pendingUserIds, setPendingUserIds] = useState<Set<string>>(new Set());
  const pendingUserIdsRef = useRef<Set<string>>(new Set());

  const { data: currentShares, isLoading: isLoadingShares, isError: isSharesError } = useNoteShares(noteId);
  const shareMutation = useShareNote();
  const unshareMutation = useUnshareNote();

  // Stable mutation refs to avoid recreating callbacks on every render
  const shareMutateRef = useRef(shareMutation.mutateAsync);
  shareMutateRef.current = shareMutation.mutateAsync;
  const unshareMutateRef = useRef(unshareMutation.mutateAsync);
  unshareMutateRef.current = unshareMutation.mutateAsync;

  // Debounce search query
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(searchQuery.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery]);

  // Fetch search results when debounced query changes (local filter when
  // offline or the server is known-unreachable, mirroring the writes' gate).
  useEffect(() => {
    if (!debouncedQuery) {
      // Grandfathered: resets search state when the debounced query is cleared.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsSearching(false);
      setSearchResults([]);
      setSearchError(false);
      return;
    }

    const filterLocalUsers = () => {
      const q = debouncedQuery.toLowerCase();
      return Array.from(usersById.values()).filter(
        (u) =>
          u.username.toLowerCase().includes(q) ||
          u.first_name.toLowerCase().includes(q) ||
          u.last_name.toLowerCase().includes(q),
      );
    };

    if (!isConnected || !isServerReachable()) {
      setIsSearching(false);
      setSearchResults(filterLocalUsers());
      setSearchError(false);
      return;
    }

    let cancelled = false;
    setIsSearching(true);
    setSearchError(false);

    searchUsers(debouncedQuery)
      .then((users) => {
        if (!cancelled) setSearchResults(users);
      })
      .catch(() => {
        if (cancelled) return;
        // A doomed request against a server that just turned out to be
        // unreachable (marked by the client's response interceptor) falls
        // back to the local filter as a staleness signal; the error state is
        // reserved for a genuine failure against a reachable server.
        if (!isServerReachable()) {
          setSearchResults(filterLocalUsers());
        } else {
          setSearchError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setIsSearching(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, isConnected, usersById]);

  const sharedUserIds = useMemo(
    () => new Set((currentShares ?? []).map((s) => s.shared_with_user_id)),
    [currentShares],
  );

  const filteredResults = useMemo(
    () => searchResults.filter((u) => !sharedUserIds.has(u.id)),
    [searchResults, sharedUserIds],
  );

  const handleShare = useCallback(
    async (user: User) => {
      if (pendingUserIdsRef.current.has(user.id)) return;
      pendingUserIdsRef.current.add(user.id);
      setPendingUserIds(new Set(pendingUserIdsRef.current));
      try {
        await shareMutateRef.current({ noteId, user });
      } catch {
        Alert.alert(t('common.error'), t('share.failedShare'));
      } finally {
        pendingUserIdsRef.current.delete(user.id);
        setPendingUserIds(new Set(pendingUserIdsRef.current));
      }
    },
    [noteId, t],
  );

  const handleUnshare = useCallback(
    async (share: NoteShare) => {
      try {
        await unshareMutateRef.current({ noteId, userId: share.shared_with_user_id });
      } catch {
        Alert.alert(t('common.error'), t('share.failedUnshare'));
      }
    },
    [noteId, t],
  );

  const isUnsharing = unshareMutation.isPending;

  const renderSearchResult = useCallback(
    ({ item }: { item: User }) => (
      <TouchableOpacity
        style={[styles.userRow, { borderBottomColor: colors.borderLight }]}
        onPress={() => handleShare(item)}
        disabled={pendingUserIds.has(item.id)}
        testID={`search-result-${item.id}`}
      >
        <UserAvatar userId={item.id} username={item.username} hasProfileIcon={item.has_profile_icon} iconVersion={item.updated_at} size="medium" />
        <View style={styles.userInfo}>
          {(item.first_name || item.last_name) && (
            <Text style={[styles.userName, { color: colors.text }]}>{[item.first_name, item.last_name].filter(Boolean).join(' ')}</Text>
          )}
          <Text style={[styles.userHandle, { color: colors.textSecondary }]}>@{item.username}</Text>
        </View>
        <Plus size={22} color={colors.primary} />
      </TouchableOpacity>
    ),
    [handleShare, pendingUserIds, colors],
  );

  const renderSharedUser = useCallback(
    ({ item }: { item: NoteShare }) => (
      <View style={[styles.userRow, { borderBottomColor: colors.borderLight }]} testID={`shared-user-${item.shared_with_user_id}`}>
        <UserAvatar
          userId={item.shared_with_user_id}
          username={item.username ?? item.shared_with_user_id}
          hasProfileIcon={item.has_profile_icon}
          iconVersion={item.updated_at}
          size="medium"
        />
        <View style={styles.userInfo}>
          {(item.first_name || item.last_name) && (
            <Text style={[styles.userName, { color: colors.text }]}>{[item.first_name, item.last_name].filter(Boolean).join(' ')}</Text>
          )}
          <Text style={[styles.userHandle, { color: colors.textSecondary }]}>@{item.username ?? item.shared_with_user_id}</Text>
        </View>
        <TouchableOpacity
          onPress={() => handleUnshare(item)}
          testID={`remove-share-${item.shared_with_user_id}`}
          disabled={isUnsharing}
          accessibilityRole="button"
          accessibilityLabel={t('share.removeAccessFor', { username: item.username ?? item.shared_with_user_id })}
        >
          <X size={22} color={colors.error} />
        </TouchableOpacity>
      </View>
    ),
    [colors, handleUnshare, isUnsharing, t],
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.surface, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: colors.borderLight }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          testID="share-screen-back"
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
        >
          <ArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('note.share')}</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={[styles.searchContainer, { backgroundColor: colors.inputBackground, borderColor: colors.searchBorder }]}>
        <Search size={18} color={colors.iconMuted} style={styles.searchIcon} />
        <TextInput
          style={[styles.searchInput, { color: colors.text }]}
          placeholder={t('share.searchUsersPlaceholder')}
          placeholderTextColor={colors.placeholder}
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          testID="share-search-input"
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity
            onPress={() => setSearchQuery('')}
            testID="clear-share-search"
            accessibilityRole="button"
            accessibilityLabel={t('common.clearSearch')}
          >
            <X size={18} color={colors.iconMuted} />
          </TouchableOpacity>
        )}
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: insets.bottom }}>
        {debouncedQuery.length > 0 && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>{t('share.results')}</Text>
            {isSearching ? (
              <ActivityIndicator size="small" color={colors.primary} style={styles.spinner} />
            ) : searchError ? (
              <Text style={[styles.errorText, { color: colors.error }]}>{t('share.searchFailed')}</Text>
            ) : filteredResults.length === 0 ? (
              <Text style={[styles.emptyText, { color: colors.textMuted }]}>{t('share.noUsersFound')}</Text>
            ) : (
              <FlatList
                data={filteredResults}
                keyExtractor={(u) => u.id}
                renderItem={renderSearchResult}
                scrollEnabled={false}
                testID="share-search-results"
              />
            )}
          </View>
        )}

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>
            {t('share.sharedWith', { count: currentShares?.length ?? 0 })}
          </Text>
          {isLoadingShares ? (
            <ActivityIndicator size="small" color={colors.primary} style={styles.spinner} />
          ) : isSharesError ? (
            <Text style={[styles.errorText, { color: colors.error }]}>{t('share.failedLoad')}</Text>
          ) : !currentShares || currentShares.length === 0 ? (
            <Text style={[styles.emptyText, { color: colors.textMuted }]}>{t('share.notSharedYet')}</Text>
          ) : (
            <FlatList
              data={currentShares}
              keyExtractor={(s) => s.id}
              renderItem={renderSharedUser}
              scrollEnabled={false}
              testID="shared-users-list"
            />
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  headerSpacer: {
    width: 24,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: 16,
    marginBottom: 8,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    height: 44,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 0,
  },
  section: {
    marginTop: 16,
    paddingHorizontal: 16,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    gap: 12,
    borderBottomWidth: 1,
  },
  userInfo: {
    flex: 1,
  },
  userName: {
    fontSize: 15,
    fontWeight: '500',
  },
  userHandle: {
    fontSize: 13,
  },
  emptyText: {
    fontSize: 14,
    paddingVertical: 8,
  },
  errorText: {
    fontSize: 14,
    paddingVertical: 8,
  },
  spinner: {
    paddingVertical: 8,
    alignSelf: 'flex-start',
  },
});
