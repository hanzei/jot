import { createDrawerNavigator } from '@react-navigation/drawer';
import type { RouteProp } from '@react-navigation/native';
import { useRoute } from '@react-navigation/native';
import NotesListScreen from '../screens/NotesListScreen';
import DrawerContent from '../components/DrawerContent';
import ScreenErrorBoundary from '../components/ScreenErrorBoundary';

export type MainDrawerParamList = {
  Notes: { labelId?: string; labelName?: string } | undefined;
  MyTasks: undefined;
  Archived: undefined;
  Trash: undefined;
};

const Drawer = createDrawerNavigator<MainDrawerParamList>();

function NotesScreen() {
  const route = useRoute<RouteProp<MainDrawerParamList, 'Notes'>>();
  return (
    <ScreenErrorBoundary name="notes-list">
      <NotesListScreen variant="notes" labelId={route.params?.labelId} labelName={route.params?.labelName} />
    </ScreenErrorBoundary>
  );
}

function MyTasksScreen() {
  return (
    <ScreenErrorBoundary name="notes-list">
      <NotesListScreen variant="my-tasks" />
    </ScreenErrorBoundary>
  );
}

function ArchivedScreen() {
  return (
    <ScreenErrorBoundary name="notes-list">
      <NotesListScreen variant="archived" />
    </ScreenErrorBoundary>
  );
}

function TrashScreen() {
  return (
    <ScreenErrorBoundary name="notes-list">
      <NotesListScreen variant="trash" />
    </ScreenErrorBoundary>
  );
}

export default function MainDrawer() {
  // Every screen renders its own header via NotesListHeader (search row plus a
  // context strip for the view title / label filter), so the native drawer
  // header stays off across the board — one header system, not two.
  return (
    <Drawer.Navigator
      drawerContent={(props) => <DrawerContent {...props} />}
      screenOptions={{ headerShown: false, drawerType: 'front' }}
    >
      <Drawer.Screen name="Notes" component={NotesScreen} />
      <Drawer.Screen name="MyTasks" component={MyTasksScreen} />
      <Drawer.Screen name="Archived" component={ArchivedScreen} />
      <Drawer.Screen name="Trash" component={TrashScreen} />
    </Drawer.Navigator>
  );
}
