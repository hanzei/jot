/**
 * Drives the masonry drag pipeline through the real `Gesture.Pan()` so the layer
 * between the gesture callbacks and the pure `masonry.ts` helpers is covered —
 * the finger-coordinate → helper-argument translation that `masonry.test.ts`
 * cannot reach. See #978.
 */
import { render, fireEvent, act } from '@testing-library/react-native';
import type { Note } from '@jot/shared';
// The default RNGH mock in jest.setup.js replaces Gesture.Pan() with an inert
// chainable; unmock it and install the library's own jest setup so a real
// handler can be driven in-process via getByGestureTestId. The side-effect
// import registers RNGH's internal native-module mock before the library loads.
import 'react-native-gesture-handler/jestSetup';

jest.unmock('react-native-gesture-handler');

// Controllable auto-scroll surface shared with the reanimated mock below.
// `mockScrollOffset` stands in for the ScrollView offset shared value so the
// test can advance it directly and via scrollTo; `mockFrame.cb` captures the
// useFrameCallback worklet so the test can tick auto-scroll frames by hand.
const mockScrollOffset = { current: 0 };
const mockFrame: { cb: (() => void) | null } = { cb: null };
// Screen-space top of the dragged section at scrollOffset 0. measure() reports
// pageY = sectionTop - scrollOffset, mirroring a section sliding up the screen
// as the list scrolls down.
const mockSection = { top: 0, height: 1000 };

jest.mock('react-native-reanimated', () => {
  // A self-contained reanimated mock — deliberately NOT reanimated's own
  // /mock entry, which pulls the real index and crashes on the native
  // worklets runtime under jest. It provides just what the component and the
  // real GestureDetector need: useEvent + useSharedValue (with the .get()/.set()
  // API), plus controllable useFrameCallback / useScrollViewOffset / scrollTo /
  // measure so the test can drive auto-scroll frames deterministically.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run before imports resolve and can't close over module-scope imports.
  const RN = require('react-native');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above.
  const React = require('react');
  const makeSharedValue = (init: unknown) => {
    let current: unknown = init;
    return {
      get value() {
        return current;
      },
      set value(next: unknown) {
        current = next;
      },
      get: () => current,
      set: (next: unknown) => {
        current = next;
      },
    };
  };
  const scrollShared = {
    get value() {
      return mockScrollOffset.current;
    },
    set value(n: number) {
      mockScrollOffset.current = n;
    },
    get: () => mockScrollOffset.current,
    set: (n: number) => {
      mockScrollOffset.current = n;
    },
  };
  return {
    __esModule: true,
    default: {
      call: () => {},
      createAnimatedComponent: (component: unknown) => component,
      addWhitelistedNativeProps: () => {},
      addWhitelistedUIProps: () => {},
      View: RN.View,
      ScrollView: RN.ScrollView,
    },
    useAnimatedStyle: () => ({}),
    useAnimatedReaction: () => {},
    useEvent: () => () => {},
    // Stable across renders, like the real hook — otherwise a re-render would
    // hand the gesture and the frame callback different shared-value objects.
    useSharedValue: (init: unknown) => React.useRef(makeSharedValue(init)).current,
    useAnimatedRef: () => ({ current: {} }),
    useDerivedValue: (fn: unknown) => makeSharedValue(typeof fn === 'function' ? undefined : fn),
    withTiming: (val: unknown) => val,
    withSpring: (val: unknown) => val,
    runOnJS:
      (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        fn(...args),
    cancelAnimation: () => {},
    Easing: { linear: () => {}, ease: () => {} },
    FadeIn: { duration: () => ({ build: () => ({}) }) },
    FadeOut: { duration: () => ({ build: () => ({}) }) },
    Layout: { springify: () => ({}) },
    LinearTransition: { duration: () => ({ build: () => ({}) }) },
    useScrollViewOffset: () => scrollShared,
    useFrameCallback: (cb: () => void) => {
      mockFrame.cb = cb;
      return { setActive: () => {}, isActive: true };
    },
    scrollTo: (_ref: unknown, _x: number, y: number) => {
      mockScrollOffset.current = y;
    },
    measure: () => ({
      x: 0,
      y: 0,
      width: 400,
      height: mockSection.height,
      pageX: 0,
      pageY: mockSection.top - mockScrollOffset.current,
    }),
  };
});

import { DeviceEventEmitter } from 'react-native';
import { State } from 'react-native-gesture-handler';
import DraggableMasonry from '../src/screens/notesList/DraggableMasonry';
import { getByGestureTestId, fireGestureHandler } from 'react-native-gesture-handler/jest-utils';
import type { NoteSection } from '../src/screens/notesList/noteListUtils';

function makeNote(id: string): Note {
  return {
    id,
    title: id,
    content: id,
    color: null,
    pinned: false,
    archived: false,
    labels: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  } as unknown as Note;
}

const CARD_HEIGHT = 100;
const CONTENT_WIDTH = 400;

type TreeNode = { props?: Record<string, unknown>; children?: (TreeNode | string)[] };

function collectLayoutNodes(node: TreeNode | string, acc: TreeNode[]): TreeNode[] {
  if (typeof node !== 'object' || node === null) return acc;
  if (typeof node.props?.onLayout === 'function') acc.push(node);
  for (const child of node.children ?? []) collectLayoutNodes(child, acc);
  return acc;
}

function fireAllLayouts(root: unknown, width: number, height: number) {
  const nodes = collectLayoutNodes(root as TreeNode, []);
  for (const node of nodes) {
    fireEvent(node as unknown as Parameters<typeof fireEvent>[0], 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width, height } },
    });
  }
}

async function renderMasonry(ids: string[], onSectionReorder = jest.fn()) {
  const sections: NoteSection[] = [{ key: 'notes', title: null, data: ids.map(makeNote) }];
  const utils = await render(
    <DraggableMasonry
      sections={sections}
      onSectionReorder={onSectionReorder}
      renderCard={() => null}
      contentBottomPadding={0}
      topInset={0}
      columns={1}
    />,
  );
  // Cards render in stages: the content View's onLayout sets the width, then the
  // off-screen height-measurer cards' onLayout commits their heights, which
  // finally renders the positioned, draggable cards. Each stage is a state
  // update, so flush layouts inside act() and repeat until the gestures appear.
  for (let pass = 0; pass < 4; pass++) {
    await act(async () => {
      fireAllLayouts(utils.root, CONTENT_WIDTH, CARD_HEIGHT);
    });
  }
  return { utils, onSectionReorder };
}

// Emits a single gesture event straight onto the bus the real GestureDetector
// listens on — the same channel fireGestureHandler uses. Emitting the phases
// separately (rather than as one fireGestureHandler call, which always appends
// END/FINALIZE) lets the test keep the gesture ACTIVE and tick auto-scroll
// frames in between, which is precisely the scroll-without-pan-events case.
function emitGesture(
  handlerTag: number,
  event: Record<string, number> & { state: number; oldState?: number },
) {
  const name = event.oldState != null ? 'onGestureHandlerStateChange' : 'onGestureHandlerEvent';
  DeviceEventEmitter.emit(name, { handlerTag, ...event });
}

const PAN = {
  x: 0,
  y: 0,
  translationX: 0,
  translationY: 0,
  velocityX: 0,
  velocityY: 0,
  numberOfPointers: 1,
};

function lastReorder(onSectionReorder: jest.Mock): string[] | null {
  const calls = onSectionReorder.mock.calls;
  if (calls.length === 0) return null;
  const data = calls[calls.length - 1]![1] as Note[];
  return data.map((n) => n.id);
}

describe('DraggableMasonry gesture pipeline', () => {
  beforeEach(() => {
    mockScrollOffset.current = 0;
    mockFrame.cb = null;
    mockSection.top = 0;
    mockSection.height = 1000;
  });

  it('registers the pan gesture for each card under a stable test id', async () => {
    await renderMasonry(['a', 'b', 'c', 'd']);
    expect(() => getByGestureTestId('masonry-card-a')).not.toThrow();
    expect(() => getByGestureTestId('masonry-card-d')).not.toThrow();
  });

  it('reorders through the real pan gesture driven by fireGestureHandler', async () => {
    // Section pinned to the top of the screen so screen-Y equals content-Y.
    mockSection.top = 0;
    const { onSectionReorder } = await renderMasonry(['a', 'b', 'c', 'd']);
    // Cards (h100, gap12): a[0..100] b[112..212] c[224..324] d[336..436].
    // Lift 'a' (center y50) and drag down onto 'b' (center y162).
    fireGestureHandler(getByGestureTestId('masonry-card-a'), [
      { ...PAN, state: State.BEGAN, absoluteX: 100, absoluteY: 50 },
      { ...PAN, state: State.ACTIVE, absoluteX: 100, absoluteY: 50 },
      { ...PAN, state: State.ACTIVE, absoluteX: 100, absoluteY: 190, translationY: 140 },
      { ...PAN, state: State.END, absoluteX: 100, absoluteY: 190 },
    ]);
    // 'a' lands after 'b'.
    expect(lastReorder(onSectionReorder)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('leaves the order unchanged when a held card is not auto-scrolled', async () => {
    // Section pushed down so 'a' sits at the bottom edge; the finger holds over
    // its own slot and never moves. Without auto-scroll frames the order stays.
    mockSection.top = 1200;
    const { onSectionReorder } = await renderMasonry(['a', 'b', 'c', 'd']);
    const tag = getByGestureTestId('masonry-card-a').handlerTag;
    // finger at absoluteY 1250 → content-Y = 1250 - 1200 = 50 (over 'a').
    emitGesture(tag, { ...PAN, state: State.BEGAN, oldState: State.UNDETERMINED, absoluteX: 100, absoluteY: 1250 });
    emitGesture(tag, { ...PAN, state: State.ACTIVE, oldState: State.BEGAN, absoluteX: 100, absoluteY: 1250 });
    emitGesture(tag, { ...PAN, state: State.ACTIVE, absoluteX: 100, absoluteY: 1250 });
    emitGesture(tag, { ...PAN, state: State.END, oldState: State.ACTIVE, absoluteX: 100, absoluteY: 1250 });
    expect(lastReorder(onSectionReorder)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('re-evaluates the drop target while auto-scroll runs without pan events', async () => {
    // Same held drag as above, but auto-scroll frames run while the finger is
    // stationary in the bottom edge band. Each frame scrolls the list down, so
    // lower cards slide up under the finger; the drop target must follow.
    // Regression test for #978 — fails before the frame-callback recompute.
    mockSection.top = 1200;
    const { onSectionReorder } = await renderMasonry(['a', 'b', 'c', 'd']);
    const tag = getByGestureTestId('masonry-card-a').handlerTag;
    emitGesture(tag, { ...PAN, state: State.BEGAN, oldState: State.UNDETERMINED, absoluteX: 100, absoluteY: 1250 });
    emitGesture(tag, { ...PAN, state: State.ACTIVE, oldState: State.BEGAN, absoluteX: 100, absoluteY: 1250 });
    emitGesture(tag, { ...PAN, state: State.ACTIVE, absoluteX: 100, absoluteY: 1250 });
    // Tick auto-scroll frames with no further pan events. bottomZone = 1334-96
    // = 1238, finger at 1250 → +9/frame. 30 frames → scrollOffset 270, so
    // content-Y under the finger moves 50 → 320 (past 'c', center 274).
    expect(mockFrame.cb).not.toBeNull();
    for (let i = 0; i < 30; i++) mockFrame.cb!();
    expect(mockScrollOffset.current).toBe(270);
    emitGesture(tag, { ...PAN, state: State.END, oldState: State.ACTIVE, absoluteX: 100, absoluteY: 1250 });
    const order = lastReorder(onSectionReorder);
    expect(order).not.toBeNull();
    // The lifted card is no longer at its original slot — the scroll moved it.
    expect(order![0]).not.toBe('a');
    expect(order![2]).toBe('a');
  });
});
