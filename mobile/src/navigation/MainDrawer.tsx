import React from 'react';
import { TouchableOpacity, StyleSheet } from 'react-native';
import { createDrawerNavigator } from '@react-navigation/drawer';
import { useRoute, RouteProp } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import NotesListScreen from '../screens/NotesListScreen';
import DrawerContent from '../components/DrawerContent';
import { useTheme } from '../theme/ThemeContext';

export type MainDrawerParamList = {
  Notes: { labelId?: string; labelName?: string } | undefined;
  MyTodo: undefined;
  Archived: undefined;
  Trash: undefined;
};

const Drawer = createDrawerNavigator<MainDrawerParamList>();

function NotesScreen() {
  const route = useRoute<RouteProp<MainDrawerParamList, 'Notes'>>();
  const labelId = route.params?.labelId;
  return <NotesListScreen variant="notes" labelId={labelId} />;
}

function MyTodoScreen() {
  return <NotesListScreen variant="my-todo" />;
}

function ArchivedScreen() {
  return <NotesListScreen variant="archived" />;
}

function TrashScreen() {
  return <NotesListScreen variant="trash" />;
}

export default function MainDrawer() {
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <Drawer.Navigator
      drawerContent={(props) => <DrawerContent {...props} />}
      screenOptions={({ navigation }) => ({
        headerShown: true,
        headerTitleStyle: [styles.headerTitle, { color: colors.text }],
        headerShadowVisible: false,
        headerStyle: {
          backgroundColor: colors.background,
          borderBottomWidth: 1,
          borderBottomColor: colors.borderLight,
        },
        drawerType: 'front',
        headerLeft: () => (
          <TouchableOpacity
            onPress={() => navigation.toggleDrawer()}
            style={styles.menuButton}
            testID="drawer-toggle"
            accessibilityLabel={t('nav.openMenu')}
            accessibilityRole="button"
          >
            <Ionicons name="menu" size={24} color={colors.text} />
          </TouchableOpacity>
        ),
      })}
    >
      <Drawer.Screen
        name="Notes"
        component={NotesScreen}
        options={({ route }) => ({
          title: route.params?.labelName ?? t('dashboard.tabNotes'),
        })}
      />
      <Drawer.Screen
        name="MyTodo"
        component={MyTodoScreen}
        options={{ title: t('dashboard.tabMyTodo') }}
      />
      <Drawer.Screen name="Archived" component={ArchivedScreen} options={{ title: t('dashboard.tabArchive') }} />
      <Drawer.Screen name="Trash" component={TrashScreen} options={{ title: t('dashboard.tabBin') }} />
    </Drawer.Navigator>
  );
}

const styles = StyleSheet.create({
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  menuButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
});
