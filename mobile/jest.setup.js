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

jest.mock('expo-share-intent', () => ({
  ShareIntentProvider: ({ children }) => children,
  useShareIntentContext: () => ({
    hasShareIntent: false,
    shareIntent: { text: null, webUrl: null, files: null, type: null },
    resetShareIntent: jest.fn(),
    error: null,
  }),
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
  const RN = require('react-native');
  return {
    __esModule: true,
    default: {
      call: jest.fn(),
      createAnimatedComponent: (component) => component,
      addWhitelistedNativeProps: jest.fn(),
      addWhitelistedUIProps: jest.fn(),
      View: RN.View,
      ScrollView: RN.ScrollView,
    },
    useAnimatedStyle: () => ({}),
    useAnimatedReaction: jest.fn(),
    useSharedValue: (init) => ({ value: init }),
    useAnimatedRef: () => ({ current: null }),
    useScrollViewOffset: () => ({ value: 0 }),
    useFrameCallback: () => ({ setActive: jest.fn(), isActive: false }),
    useDerivedValue: (fn) => ({ value: typeof fn === 'function' ? undefined : fn }),
    withTiming: (val) => val,
    withSpring: (val) => val,
    runOnJS: (fn) => fn,
    scrollTo: jest.fn(),
    measure: jest.fn(() => null),
    cancelAnimation: jest.fn(),
    Easing: { linear: jest.fn(), ease: jest.fn() },
    FadeIn: { duration: () => ({ build: () => ({}) }) },
    FadeOut: { duration: () => ({ build: () => ({}) }) },
    Layout: { springify: () => ({}) },
    LinearTransition: { duration: () => ({ build: () => ({}) }) },
  };
});

jest.mock('react-native-gesture-handler', () => {
  const RN = require('react-native');
  const createGesture = () => {
    const gesture = {};
    const chain = () => gesture;
    [
      'activateAfterLongPress',
      'onBegin',
      'onStart',
      'onUpdate',
      'onChange',
      'onEnd',
      'onFinalize',
      'enabled',
      'minDistance',
      'activeOffsetX',
      'activeOffsetY',
      'failOffsetX',
      'failOffsetY',
      'withRef',
    ].forEach((method) => {
      gesture[method] = chain;
    });
    return gesture;
  };
  return {
    GestureHandlerRootView: RN.View,
    GestureDetector: ({ children }) => children,
    Gesture: {
      Pan: createGesture,
      Tap: createGesture,
      LongPress: createGesture,
    },
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

// Single source of truth for the react-native-reorderable-list mock, used by
// every test that renders the note editor. Renders each row synchronously so
// tests can query list items without FlatList virtualization timing.
jest.mock('react-native-reorderable-list', () => {
  const React = require('react');
  const { View, ScrollView } = require('react-native');
  function ReorderableList(props) {
    const data = props.data || [];
    return React.createElement(
      View,
      null,
      data.map((item, index) =>
        React.createElement(React.Fragment, { key: item.id }, props.renderItem({ item, index })),
      ),
    );
  }
  ReorderableList.displayName = 'ReorderableList';
  const ScrollViewContainer = React.forwardRef(function ScrollViewContainer(props, ref) {
    return React.createElement(ScrollView, { ...props, ref });
  });
  return {
    __esModule: true,
    default: ReorderableList,
    ReorderableList,
    NestedReorderableList: ReorderableList,
    ScrollViewContainer,
    useReorderableDrag: () => () => {},
    useReorderableDragStart: () => () => {},
    useReorderableDragEnd: () => () => {},
    useIsActive: () => false,
    reorderItems: (arr, from, to) => {
      const copy = [...arr];
      const [moved] = copy.splice(from, 1);
      copy.splice(to, 0, moved);
      return copy;
    },
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

jest.mock('@expo/vector-icons/MaterialIcons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const MockMaterialIcons = React.forwardRef(function MockMaterialIcons(props, ref) {
    return React.createElement(Text, { ...props, ref, testID: props.testID || `icon-${props.name}` }, props.name);
  });
  MockMaterialIcons.glyphMap = {};
  return { __esModule: true, default: MockMaterialIcons };
});

const i18n = require('./src/i18n').default;
void i18n.changeLanguage('en');

// axios 1.15.0 probes for fetch adapter support by constructing a Request with
// a ReadableStream body. Expo's polyfill internally calls stream.cancel() on a
// stream that already has a reader, which returns a rejected Promise. In
// Node.js 24, that unhandled rejection crashes the Jest worker. Intercept the
// rejection so the probe fails silently and axios falls back to http/xhr.
if (global.ReadableStream) {
  const originalCancel = global.ReadableStream.prototype.cancel;
  global.ReadableStream.prototype.cancel = function (reason) {
    const result = originalCancel.call(this, reason);
    if (result && typeof result.catch === 'function') {
      return result.catch((e) => {
        if (e && e.message === 'Cannot cancel a stream that already has a reader') {
          return undefined;
        }
        return Promise.reject(e);
      });
    }
    return result;
  };
}

