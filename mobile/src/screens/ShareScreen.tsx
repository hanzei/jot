import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  SafeAreaView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { searchUsers } from '../api/users';
import { shareNote, unshareNote, getNoteShares } from '../api/notes';
import UserAvatar from '../components/UserAvatar';
import type { Note, NoteShare, UserInfo } from '../types';

interface Props {
  note: Note;
  onClose: () => void;
}

export default function ShareScreen({ note, onClose }: Props) {
  const [searchText, setSearchText] = useState('');
  const [sharing, setSharing] = useState(false);

  const { data: users, isLoading: usersLoading } = useQuery({
    queryKey: ['users', searchText],
    queryFn: () => searchUsers(searchText || undefined),
    enabled: searchText.length > 0,
  });

  const { data: shares, refetch: refetchShares } = useQuery({
    queryKey: ['shares', note.id],
    queryFn: () => getNoteShares(note.id),
  });

  const handleShare = async (user: UserInfo) => {
    setSharing(true);
    try {
      await shareNote(note.id, user.username);
      await refetchShares();
      setSearchText('');
    } catch (_e) {
      Alert.alert('Error', 'Failed to share note');
    } finally {
      setSharing(false);
    }
  };

  const handleUnshare = async (share: NoteShare) => {
    try {
      await unshareNote(note.id, share.username ?? '');
      await refetchShares();
    } catch (_e) {
      Alert.alert('Error', 'Failed to remove share');
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
          <Ionicons name="close" size={24} color="#333" />
        </TouchableOpacity>
        <Text style={styles.title} accessibilityRole="header">Share note</Text>
        <View style={{ width: 24 }} />
      </View>

      <View style={styles.searchContainer}>
        <Ionicons name="search-outline" size={20} color="#999" />
        <TextInput
          style={styles.searchInput}
          placeholder="Search by username"
          value={searchText}
          onChangeText={setSearchText}
          autoCapitalize="none"
          accessibilityLabel="Search users"
          allowFontScaling
        />
      </View>

      {usersLoading && <ActivityIndicator style={styles.loader} />}

      {searchText.length > 0 && users && (
        <FlatList
          data={users}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.userRow}
              onPress={() => handleShare(item)}
              disabled={sharing}
              accessibilityRole="button"
              accessibilityLabel={`Share with ${item.username}`}
            >
              <UserAvatar user={item} size={40} />
              <View style={styles.userInfo}>
                <Text style={styles.username}>{item.username}</Text>
                <Text style={styles.fullName}>{`${item.first_name} ${item.last_name}`.trim()}</Text>
              </View>
              <Ionicons name="person-add-outline" size={20} color="#1a73e8" />
            </TouchableOpacity>
          )}
          style={styles.usersList}
        />
      )}

      {shares && (Array.isArray(shares) ? shares : []).length > 0 && (
        <View style={styles.sharesSection}>
          <Text style={styles.sectionTitle}>Shared with</Text>
          {(Array.isArray(shares) ? shares : []).map((share: NoteShare) => (
            <View key={share.id} style={styles.shareRow}>
              <UserAvatar
                user={{
                  id: share.shared_with_user_id,
                  username: share.username ?? '',
                  first_name: share.first_name ?? '',
                  last_name: share.last_name ?? '',
                  role: 'user',
                  has_profile_icon: share.has_profile_icon ?? false,
                }}
                size={40}
              />
              <Text style={styles.shareUsername}>{share.username}</Text>
              <TouchableOpacity
                onPress={() => handleUnshare(share)}
                accessibilityRole="button"
                accessibilityLabel={`Remove share with ${share.username}`}
              >
                <Ionicons name="close-circle-outline" size={24} color="#e74c3c" />
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  title: { fontSize: 18, fontWeight: '600' },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: 12,
    padding: 10,
    backgroundColor: '#f5f5f5',
    borderRadius: 12,
    minHeight: 48,
  },
  searchInput: { flex: 1, marginLeft: 8, fontSize: 16 },
  loader: { margin: 16 },
  usersList: { maxHeight: 300 },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
    minHeight: 64,
  },
  userInfo: { flex: 1, marginLeft: 12 },
  username: { fontSize: 16, fontWeight: '500' },
  fullName: { fontSize: 14, color: '#666' },
  sharesSection: { padding: 16 },
  sectionTitle: { fontSize: 16, fontWeight: '600', marginBottom: 12 },
  shareRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    minHeight: 56,
  },
  shareUsername: { flex: 1, marginLeft: 12, fontSize: 16 },
});
