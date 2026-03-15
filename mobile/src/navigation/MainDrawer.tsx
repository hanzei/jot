import React from 'react';
import { TouchableOpacity, StyleSheet } from 'react-native';
import { createDrawerNavigator } from '@react-navigation/drawer';
import Ionicons from '@expo/vector-icons/Ionicons';
import NotesListScreen from '../screens/NotesListScreen';
import DrawerContent from '../components/DrawerContent';

export type MainDrawerParamList = {
  Notes: undefined;
  Archived: undefined;
  Trash: undefined;
};

const Drawer = createDrawerNavigator<MainDrawerParamList>();

function NotesScreen() {
  return <NotesListScreen variant="notes" />;
}

function ArchivedScreen() {
  return <NotesListScreen variant="archived" />;
}

function TrashScreen() {
  return <NotesListScreen variant="trash" />;
}

export default function MainDrawer() {
  return (
    <Drawer.Navigator
      drawerContent={(props) => <DrawerContent {...props} />}
      screenOptions={({ navigation }) => ({
        headerShown: true,
        headerTitleStyle: styles.headerTitle,
        headerShadowVisible: false,
        headerStyle: styles.header,
        drawerType: 'front',
        headerLeft: () => (
          <TouchableOpacity
            onPress={() => navigation.toggleDrawer()}
            style={styles.menuButton}
            testID="drawer-toggle"
            accessibilityLabel="Open menu"
            accessibilityRole="button"
          >
            <Ionicons name="menu" size={24} color="#1a1a1a" />
          </TouchableOpacity>
        ),
      })}
    >
      <Drawer.Screen name="Notes" component={NotesScreen} />
      <Drawer.Screen name="Archived" component={ArchivedScreen} />
      <Drawer.Screen name="Trash" component={TrashScreen} />
    </Drawer.Navigator>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: '#f9fafb',
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  menuButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
});
