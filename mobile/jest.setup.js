jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn().mockResolvedValue({ exists: false, isDirectory: false }),
  moveAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-localization', () => ({
  getLocales: jest.fn(() => [{ languageTag: 'en-US', languageCode: 'en' }]),
}));

const mockDb = {
  execAsync: jest.fn().mockResolvedValue(undefined),
  runAsync: jest.fn().mockResolvedValue({ lastInsertRowId: 1, changes: 1 }),
  getFirstAsync: jest.fn().mockResolvedValue(null),
  getAllAsync: jest.fn().mockResolvedValue([]),
  closeAsync: jest.fn().mockResolvedValue(undefined),
};

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
  openDatabaseAsync: jest.fn().mockResolvedValue(mockDb),
  backupDatabaseAsync: jest.fn().mockResolvedValue(undefined),
  defaultDatabaseDirectory: 'file:///db',
}));

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
  const RN = require('react-native');
  return {
    GestureHandlerRootView: RN.View,
    Swipeable: RN.View,
    DrawerLayout: RN.View,
    State: {},
    TouchableOpacity: RN.TouchableOpacity,
    ScrollView: RN.ScrollView,
    FlatList: RN.FlatList,
    gestureHandlerRootHOC: (component) => component,
    Directions: {},
  };
});

jest.mock('react-native-draggable-flatlist', () => {
  const React = require('react');
  const { FlatList, ScrollView } = require('react-native');
  function DraggableFlatList(props) {
    return React.createElement(FlatList, {
      ...props,
      renderItem: (info) =>
        props.renderItem({ ...info, drag: jest.fn(), isActive: false }),
    });
  }
  DraggableFlatList.displayName = 'DraggableFlatList';
  function NestableDraggableFlatList(props) {
    return React.createElement(FlatList, {
      ...props,
      renderItem: (info) =>
        props.renderItem({ ...info, drag: jest.fn(), isActive: false }),
    });
  }
  NestableDraggableFlatList.displayName = 'NestableDraggableFlatList';
  const NestableScrollContainer = React.forwardRef(function NestableScrollContainer(props, ref) {
    return React.createElement(ScrollView, { ...props, ref });
  });
  function ScaleDecorator({ children }) {
    return children;
  }
  return {
    __esModule: true,
    default: DraggableFlatList,
    ScaleDecorator,
    NestableDraggableFlatList,
    NestableScrollContainer,
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

jest.mock('@expo/vector-icons/Ionicons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const MockIonicons = React.forwardRef(function MockIonicons(props, ref) {
    return React.createElement(Text, { ...props, ref, testID: props.testID || `icon-${props.name}` }, props.name);
  });
  MockIonicons.glyphMap = {};
  return { __esModule: true, default: MockIonicons };
});

const i18n = require('./src/i18n').default;
void i18n.changeLanguage('en');

// axios 1.15.0 probes for fetch adapter support at module load time by calling
// ReadableStream.cancel() on a stream that already has a reader. Expo's
// ReadableStream polyfill throws in that case. Swallow the error so the probe
// fails gracefully and axios falls back to the http/xhr adapter.
if (global.ReadableStream) {
  const originalCancel = global.ReadableStream.prototype.cancel;
  global.ReadableStream.prototype.cancel = function (reason) {
    try {
      return originalCancel.call(this, reason);
    } catch (e) {
      if (e && e.message === 'Cannot cancel a stream that already has a reader') {
        return Promise.resolve();
      }
      throw e;
    }
  };
}

