import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text } from 'react-native';
import NotesListScreen from '../screens/NotesListScreen';

export type MainTabsParamList = {
  Notes: undefined;
  Archived: undefined;
  Trash: undefined;
};

const Tab = createBottomTabNavigator<MainTabsParamList>();

function NotesTab() {
  return <NotesListScreen variant="notes" />;
}

function ArchivedTab() {
  return <NotesListScreen variant="archived" />;
}

function TrashTab() {
  return <NotesListScreen variant="trash" />;
}

function TabIcon({ label, color }: { label: string; color: string }) {
  const icons: Record<string, string> = {
    Notes: '\u{1F4DD}',
    Archived: '\u{1F4E6}',
    Trash: '\u{1F5D1}',
  };
  return <Text style={{ fontSize: 20, color }}>{icons[label] || '?'}</Text>;
}

export default function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: true,
        tabBarIcon: ({ color }) => <TabIcon label={route.name} color={color} />,
        tabBarActiveTintColor: '#2563eb',
        tabBarInactiveTintColor: '#999',
      })}
    >
      <Tab.Screen name="Notes" component={NotesTab} />
      <Tab.Screen name="Archived" component={ArchivedTab} />
      <Tab.Screen name="Trash" component={TrashTab} />
    </Tab.Navigator>
  );
}
