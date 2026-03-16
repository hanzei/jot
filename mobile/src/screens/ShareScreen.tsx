import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  StyleSheet,
  Alert,
  SafeAreaView,
  ScrollView,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { searchUsers } from '../api/users';
import { useNoteShares, useShareNote, useUnshareNote } from '../hooks/useNotes';
import UserAvatar from '../components/UserAvatar';
import type { User, NoteShare } from '@jot/shared';
import type { RootStackParamList } from '../navigation/RootNavigator';

type ShareRouteProp = RouteProp<RootStackParamList, 'Share'>;

const SEARCH_DEBOUNCE_MS = 300;

export default function ShareScreen() {
  const navigation = useNavigation();
  const route = useRoute<ShareRouteProp>();
  const { noteId } = route.params;

  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Fetch search results when debounced query changes
  useEffect(() => {
    if (!debouncedQuery) {
      setSearchResults([]);
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
        if (!cancelled) setSearchError(true);
      })
      .finally(() => {
        if (!cancelled) setIsSearching(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

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
        await shareMutateRef.current({ noteId, userId: user.id });
      } catch {
        Alert.alert('Error', 'Failed to share note');
      } finally {
        pendingUserIdsRef.current.delete(user.id);
        setPendingUserIds(new Set(pendingUserIdsRef.current));
      }
    },
    [noteId],
  );

  const handleUnshare = useCallback(
    async (share: NoteShare) => {
      try {
        await unshareMutateRef.current({ noteId, userId: share.shared_with_user_id });
      } catch {
        Alert.alert('Error', 'Failed to remove share');
      }
    },
    [noteId],
  );

  const isUnsharing = unshareMutation.isPending;

  const renderSearchResult = useCallback(
    ({ item }: { item: User }) => (
      <TouchableOpacity
        style={styles.userRow}
        onPress={() => handleShare(item)}
        disabled={pendingUserIds.has(item.id)}
        testID={`search-result-${item.id}`}
      >
        <UserAvatar userId={item.id} username={item.username} hasProfileIcon={item.has_profile_icon} size="medium" />
        <View style={styles.userInfo}>
          {(item.first_name || item.last_name) && (
            <Text style={styles.userName}>{[item.first_name, item.last_name].filter(Boolean).join(' ')}</Text>
          )}
          <Text style={styles.userHandle}>@{item.username}</Text>
        </View>
        <Ionicons name="add-circle-outline" size={22} color="#2563eb" />
      </TouchableOpacity>
    ),
    [handleShare, pendingUserIds],
  );

  const renderSharedUser = useCallback(
    ({ item }: { item: NoteShare }) => (
      <View style={styles.userRow} testID={`shared-user-${item.shared_with_user_id}`}>
        <UserAvatar
          userId={item.shared_with_user_id}
          username={item.username ?? item.shared_with_user_id}
          hasProfileIcon={item.has_profile_icon}
          size="medium"
        />
        <View style={styles.userInfo}>
          {(item.first_name || item.last_name) && (
            <Text style={styles.userName}>{[item.first_name, item.last_name].filter(Boolean).join(' ')}</Text>
          )}
          <Text style={styles.userHandle}>@{item.username ?? item.shared_with_user_id}</Text>
        </View>
        <TouchableOpacity
          onPress={() => handleUnshare(item)}
          testID={`remove-share-${item.shared_with_user_id}`}
          disabled={isUnsharing}
          accessibilityRole="button"
          accessibilityLabel={`Remove share for ${item.username ?? item.shared_with_user_id}`}
          accessibilityHint="Removes this shared item"
        >
          <Ionicons name="close-circle-outline" size={22} color="#ef4444" />
        </TouchableOpacity>
      </View>
    ),
    [handleUnshare, isUnsharing],
  );

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          testID="share-screen-back"
          accessibilityRole="button"
          accessibilityLabel="Back"
          accessibilityHint="Goes back to the previous screen"
        >
          <Ionicons name="arrow-back" size={24} color="#1a1a1a" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Share note</Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* Search field */}
      <View style={styles.searchContainer}>
        <Ionicons name="search" size={18} color="#999" style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search by username..."
          placeholderTextColor="#999"
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
            accessibilityLabel="Clear search"
            accessibilityHint="Clears the search input"
          >
            <Ionicons name="close-circle" size={18} color="#999" />
          </TouchableOpacity>
        )}
      </View>

      <ScrollView keyboardShouldPersistTaps="handled">
        {/* Search results */}
        {debouncedQuery.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Results</Text>
            {isSearching ? (
              <ActivityIndicator size="small" color="#2563eb" style={styles.spinner} />
            ) : searchError ? (
              <Text style={styles.errorText}>Search failed. Please try again.</Text>
            ) : filteredResults.length === 0 ? (
              <Text style={styles.emptyText}>No users found</Text>
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

        {/* Shared with section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Shared with</Text>
          {isLoadingShares ? (
            <ActivityIndicator size="small" color="#2563eb" style={styles.spinner} />
          ) : isSharesError ? (
            <Text style={styles.errorText}>Failed to load shares</Text>
          ) : !currentShares || currentShares.length === 0 ? (
            <Text style={styles.emptyText}>Not shared with anyone yet</Text>
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: '600',
    color: '#1a1a1a',
    textAlign: 'center',
  },
  headerSpacer: {
    width: 24,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f9fafb',
    margin: 16,
    marginBottom: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    paddingHorizontal: 12,
    height: 44,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: '#1a1a1a',
    paddingVertical: 0,
  },
  section: {
    marginTop: 16,
    paddingHorizontal: 16,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#999',
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
    borderBottomColor: '#f9fafb',
  },
  userInfo: {
    flex: 1,
  },
  userName: {
    fontSize: 15,
    fontWeight: '500',
    color: '#1a1a1a',
  },
  userHandle: {
    fontSize: 13,
    color: '#666',
  },
  emptyText: {
    fontSize: 14,
    color: '#999',
    paddingVertical: 8,
  },
  errorText: {
    fontSize: 14,
    color: '#ef4444',
    paddingVertical: 8,
  },
  spinner: {
    paddingVertical: 8,
    alignSelf: 'flex-start',
  },
});
