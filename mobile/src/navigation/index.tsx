import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../store/authStore';

import LoginScreen from '../screens/LoginScreen';
import RegisterScreen from '../screens/RegisterScreen';
import NotesListScreen from '../screens/NotesListScreen';
import ArchivedScreen from '../screens/ArchivedScreen';
import TrashScreen from '../screens/TrashScreen';

export type AuthStackParamList = {
  Login: undefined;
  Register: undefined;
};

export type NotesStackParamList = {
  NotesList: undefined;
  NoteEditor: { noteId?: string };
  Share: { noteId: string };
};

export type ArchivedStackParamList = {
  ArchivedList: undefined;
};

export type TrashStackParamList = {
  TrashList: undefined;
};

export type TabParamList = {
  NotesTab: undefined;
  ArchivedTab: undefined;
  TrashTab: undefined;
};

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const NotesStack = createNativeStackNavigator<NotesStackParamList>();
const ArchivedStack = createNativeStackNavigator<ArchivedStackParamList>();
const TrashStack = createNativeStackNavigator<TrashStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

const NotesStackNavigator = () => (
  <NotesStack.Navigator>
    <NotesStack.Screen
      name="NotesList"
      component={NotesListScreen}
      options={{ headerShown: false }}
    />
  </NotesStack.Navigator>
);

const ArchivedStackNavigator = () => (
  <ArchivedStack.Navigator>
    <ArchivedStack.Screen
      name="ArchivedList"
      component={ArchivedScreen}
      options={{ title: 'Archive' }}
    />
  </ArchivedStack.Navigator>
);

const TrashStackNavigator = () => (
  <TrashStack.Navigator>
    <TrashStack.Screen
      name="TrashList"
      component={TrashScreen}
      options={{ title: 'Trash' }}
    />
  </TrashStack.Navigator>
);

const MainTabs = () => (
  <Tab.Navigator
    screenOptions={({ route }) => ({
      tabBarIcon: ({ focused, color, size }) => {
        let iconName: keyof typeof Ionicons.glyphMap;
        if (route.name === 'NotesTab') {
          iconName = focused ? 'document-text' : 'document-text-outline';
        } else if (route.name === 'ArchivedTab') {
          iconName = focused ? 'archive' : 'archive-outline';
        } else {
          iconName = focused ? 'trash' : 'trash-outline';
        }
        return <Ionicons name={iconName} size={size} color={color} />;
      },
      headerShown: false,
    })}
  >
    <Tab.Screen name="NotesTab" component={NotesStackNavigator} options={{ title: 'Notes' }} />
    <Tab.Screen name="ArchivedTab" component={ArchivedStackNavigator} options={{ title: 'Archive' }} />
    <Tab.Screen name="TrashTab" component={TrashStackNavigator} options={{ title: 'Trash' }} />
  </Tab.Navigator>
);

export const AppNavigator = () => {
  const { user, isLoading } = useAuthStore();

  if (isLoading) {
    return null;
  }

  return (
    <NavigationContainer>
      {user ? (
        <MainTabs />
      ) : (
        <AuthStack.Navigator screenOptions={{ headerShown: false }}>
          <AuthStack.Screen name="Login" component={LoginScreen} />
          <AuthStack.Screen name="Register" component={RegisterScreen} />
        </AuthStack.Navigator>
      )}
    </NavigationContainer>
  );
};
