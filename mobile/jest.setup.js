jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

// In-memory expo-file-system. `src/utils/fs.ts` is the only module that imports
// the real package, so this backs every filesystem operation in tests and lets
// modules built on it (notably the logger's rotation) run their real logic.
// Tests reach it through `global.mockFileSystem`.
const fsFiles = new Map();
const fsDirs = new Set(['file:///docs', 'file:///cache']);

const normalizeUri = (uri) => String(uri).replace(/\/+$/, '');
const joinUris = (uris) =>
  normalizeUri(uris.map((u) => (typeof u === 'string' ? u : u.uri)).join('/'));

class MockFile {
  constructor(...uris) {
    this.uri = joinUris(uris);
  }
  get exists() {
    return fsFiles.has(this.uri);
  }
  get size() {
    return fsFiles.has(this.uri) ? Buffer.byteLength(fsFiles.get(this.uri), 'utf8') : 0;
  }
  get name() {
    return this.uri.slice(this.uri.lastIndexOf('/') + 1);
  }
  textSync() {
    if (!fsFiles.has(this.uri)) throw new Error(`ENOENT: ${this.uri}`);
    return fsFiles.get(this.uri);
  }
  text() {
    return Promise.resolve(this.textSync());
  }
  create({ overwrite = false } = {}) {
    if (global.mockFileSystem.failWrites) throw new Error('ENOSPC: no space left on device');
    if (fsFiles.has(this.uri) && !overwrite) throw new Error(`EEXIST: ${this.uri}`);
    fsFiles.set(this.uri, '');
  }
  write(content, { append = false } = {}) {
    if (global.mockFileSystem.failWrites) throw new Error('ENOSPC: no space left on device');
    const previous = append ? (fsFiles.get(this.uri) ?? '') : '';
    fsFiles.set(this.uri, previous + content);
  }
  delete() {
    if (!fsFiles.has(this.uri)) throw new Error(`ENOENT: ${this.uri}`);
    fsFiles.delete(this.uri);
  }
  copySync(destination, { overwrite = false } = {}) {
    if (!fsFiles.has(this.uri)) throw new Error(`ENOENT: ${this.uri}`);
    if (fsFiles.has(destination.uri) && !overwrite) throw new Error(`EEXIST: ${destination.uri}`);
    fsFiles.set(destination.uri, fsFiles.get(this.uri));
  }
  copy(destination, options) {
    return Promise.resolve(this.copySync(destination, options));
  }
  moveSync(destination, options) {
    this.copySync(destination, options);
    fsFiles.delete(this.uri);
    this.uri = destination.uri;
  }
  move(destination, options) {
    return Promise.resolve(this.moveSync(destination, options));
  }
  static downloadFileAsync(url, destination, options) {
    return global.mockFileSystem.downloadFileAsync(url, destination, options);
  }
}

class MockDirectory {
  constructor(...uris) {
    this.uri = joinUris(uris);
  }
  get exists() {
    return fsDirs.has(this.uri);
  }
  get name() {
    return this.uri.slice(this.uri.lastIndexOf('/') + 1);
  }
  create({ intermediates = false, idempotent = false } = {}) {
    if (fsDirs.has(this.uri) && !idempotent) throw new Error(`EEXIST: ${this.uri}`);
    if (intermediates) {
      const parts = this.uri.split('/');
      for (let i = 4; i <= parts.length; i++) fsDirs.add(parts.slice(0, i).join('/'));
    }
    fsDirs.add(this.uri);
  }
  list() {
    if (!fsDirs.has(this.uri)) throw new Error(`ENOENT: ${this.uri}`);
    const prefix = `${this.uri}/`;
    return [...fsFiles.keys()]
      .filter((uri) => uri.startsWith(prefix) && !uri.slice(prefix.length).includes('/'))
      .map((uri) => new MockFile(uri));
  }
}

jest.mock('expo-file-system', () => ({
  File: MockFile,
  Directory: MockDirectory,
  Paths: {
    get document() {
      return new MockDirectory('file:///docs');
    },
    get cache() {
      return new MockDirectory('file:///cache');
    },
  },
}));

global.mockFileSystem = {
  files: fsFiles,
  dirs: fsDirs,
  /** Set to true to make every file create/write throw, simulating a full disk. */
  failWrites: false,
  /**
   * Overridable by tests; resolves by default so downloads "succeed" with empty
   * content. Models the real API's refusal to overwrite an existing destination
   * unless `idempotent` is set, so a caller that forgets to pass it fails here.
   */
  downloadFileAsync: jest.fn((url, destination, options) => {
    if (fsFiles.has(destination.uri) && !options?.idempotent) {
      return Promise.reject(new Error(`DestinationAlreadyExists: ${destination.uri}`));
    }
    fsFiles.set(destination.uri, '');
    return Promise.resolve(destination);
  }),
  reset() {
    this.failWrites = false;
    fsFiles.clear();
    fsDirs.clear();
    fsDirs.add('file:///docs');
    fsDirs.add('file:///cache');
    this.downloadFileAsync.mockClear();
  },
};

jest.mock('expo-localization', () => ({
  getLocales: jest.fn(() => [{ languageTag: 'en-US', languageCode: 'en' }]),
}));

jest.mock('expo-quick-actions', () => ({
  __esModule: true,
  initial: undefined,
  maxCount: 4,
  setItems: jest.fn().mockResolvedValue(undefined),
  isSupported: jest.fn().mockResolvedValue(true),
  addListener: jest.fn(() => ({ remove: jest.fn() })),
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

// Mock every lucide-react-native icon component with a lightweight stand-in so
// tests can identify a rendered icon by its component name (e.g. `icon-Trash2`)
// without depending on react-native-svg internals.
jest.mock('lucide-react-native', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === '__esModule') return true;
        if (typeof prop !== 'string') return undefined;
        const MockIcon = React.forwardRef(function MockIcon(props, ref) {
          return React.createElement(Text, { ...props, ref, testID: props.testID || `icon-${prop}` }, prop);
        });
        MockIcon.displayName = prop;
        return MockIcon;
      },
    },
  );
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

