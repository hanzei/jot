import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import Ionicons from '@expo/vector-icons/Ionicons';
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

const tabIcons: Record<string, keyof typeof Ionicons.glyphMap> = {
  Notes: 'document-text-outline',
  Archived: 'archive-outline',
  Trash: 'trash-outline',
};

export default function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: true,
        tabBarIcon: ({ color, size }) => (
          <Ionicons name={tabIcons[route.name] || 'help-outline'} size={size} color={color} />
        ),
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
