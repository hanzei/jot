import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

interface NotesListScreenProps {
  variant?: 'notes' | 'archived' | 'trash';
}

export default function NotesListScreen({ variant = 'notes' }: NotesListScreenProps) {
  const titles: Record<string, string> = {
    notes: 'Notes',
    archived: 'Archived',
    trash: 'Trash',
  };

  return (
    <View style={styles.container}>
      <Text style={styles.text}>{titles[variant]}</Text>
      <Text style={styles.subtext}>No notes yet</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  text: {
    fontSize: 20,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  subtext: {
    fontSize: 14,
    color: '#999',
    marginTop: 8,
  },
});
