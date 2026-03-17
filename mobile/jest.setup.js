jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-sqlite', () => ({
  SQLiteProvider: ({ children, onInit }) => {
    // Run onInit asynchronously to simulate DB initialization
    const React = require('react');
    const [ready, setReady] = React.useState(false);
    React.useEffect(() => {
      Promise.resolve(onInit?.(mockDb)).then(() => setReady(true));
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return ready ? children : null;
  },
  useSQLiteContext: () => mockDb,
}));

const mockDb = {
  execAsync: jest.fn().mockResolvedValue(undefined),
  runAsync: jest.fn().mockResolvedValue({ lastInsertRowId: 1, changes: 1 }),
  getFirstAsync: jest.fn().mockResolvedValue(null),
  getAllAsync: jest.fn().mockResolvedValue([]),
};

global.mockDb = mockDb;

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn(() => jest.fn()),
    fetch: jest.fn().mockResolvedValue({ isConnected: true, isInternetReachable: true }),
  },
}));

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));

jest.mock('react-native-reanimated', () => {
  const View = require('react-native').View;
  return {
    __esModule: true,
    default: {
      call: jest.fn(),
      createAnimatedComponent: (component) => component,
      addWhitelistedNativeProps: jest.fn(),
      addWhitelistedUIProps: jest.fn(),
    },
    useAnimatedStyle: () => ({}),
    useSharedValue: (init) => ({ value: init }),
    withTiming: (val) => val,
    withSpring: (val) => val,
    Easing: { linear: jest.fn(), ease: jest.fn() },
    FadeIn: { duration: () => ({ build: () => ({}) }) },
    FadeOut: { duration: () => ({ build: () => ({}) }) },
    Layout: { springify: () => ({}) },
  };
});

jest.mock('react-native-gesture-handler', () => {
  const View = require('react-native').View;
  return {
    GestureHandlerRootView: View,
    Swipeable: View,
    DrawerLayout: View,
    State: {},
    ScrollView: require('react-native').ScrollView,
    FlatList: require('react-native').FlatList,
    gestureHandlerRootHOC: (component) => component,
    Directions: {},
  };
});

jest.mock('react-native-draggable-flatlist', () => {
  const React = require('react');
  const { FlatList } = require('react-native');
  function DraggableFlatList(props) {
    return React.createElement(FlatList, {
      ...props,
      renderItem: (info) =>
        props.renderItem({ ...info, drag: jest.fn(), isActive: false }),
    });
  }
  DraggableFlatList.displayName = 'DraggableFlatList';
  function ScaleDecorator({ children }) {
    return children;
  }
  return {
    __esModule: true,
    default: DraggableFlatList,
    ScaleDecorator,
  };
});

jest.mock('./src/theme/ThemeContext', () => {
  const { lightColors } = require('./src/theme/colors');
  return {
    __esModule: true,
    useTheme: () => ({
      colors: lightColors,
      isDark: false,
    }),
    ThemeProvider: ({ children }) => children,
  };
});

jest.mock('./src/store/AuthContext', () => ({
  __esModule: true,
  useAuth: () => ({
    user: { id: 'current-user', username: 'testuser' },
    isAuthenticated: true,
    isLoading: false,
  }),
  AuthProvider: ({ children }) => children,
}));

jest.mock('./src/store/UsersContext', () => ({
  __esModule: true,
  useUsers: () => ({
    usersById: new Map(),
    refreshUsers: jest.fn(),
  }),
  UsersProvider: ({ children }) => children,
}));

jest.mock('@expo/vector-icons/Ionicons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const MockIonicons = React.forwardRef(function MockIonicons(props, ref) {
    return React.createElement(Text, { ...props, ref, testID: props.testID || `icon-${props.name}` }, props.name);
  });
  MockIonicons.glyphMap = {};
  return { __esModule: true, default: MockIonicons };
});
