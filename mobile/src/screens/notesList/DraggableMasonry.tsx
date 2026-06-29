import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  type LayoutChangeEvent,
  type RefreshControlProps,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useAnimatedRef,
  useScrollViewOffset,
  useFrameCallback,
  withTiming,
  runOnJS,
  scrollTo,
  measure,
  type SharedValue,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import type { Note } from '@jot/shared';
import { useTheme } from '../../theme/ThemeContext';
import { styles as listStyles } from './styles';
import type { NoteSection } from './noteListUtils';
import { packColumns, reorderForPointer, type PlacedItem } from './masonry';
import {
  MASONRY_COLUMN_GAP,
  MASONRY_ROW_GAP,
  MASONRY_HORIZONTAL_PADDING,
} from './MasonryGrid';

const DEFAULT_COLUMNS = 2;
const ESTIMATED_CARD_HEIGHT = 140;
const LONG_PRESS_MS = 220;
// Edge band (in screen px) within which dragging auto-scrolls, and the per-frame
// scroll step. These are the values most likely to need on-device tuning.
const AUTO_SCROLL_EDGE = 96;
const AUTO_SCROLL_SPEED = 9;

interface SharedDragState {
  activeId: SharedValue<string | null>;
  activeSection: SharedValue<number>;
  dragTX: SharedValue<number>;
  dragTY: SharedValue<number>;
  startX: SharedValue<number>;
  startY: SharedValue<number>;
  startAbsX: SharedValue<number>;
  startAbsY: SharedValue<number>;
  startScroll: SharedValue<number>;
  fingerAbsY: SharedValue<number>;
  scrollOffset: SharedValue<number>;
}

interface DraggableMasonryProps {
  sections: NoteSection[];
  /** Called with the section key and its reordered notes when a drag commits. */
  onSectionReorder: (sectionKey: string, newData: Note[]) => void;
  onDragStart?: () => void;
  renderCard: (note: Note) => React.ReactNode;
  refreshControl?: React.ReactElement<RefreshControlProps>;
  contentBottomPadding: number;
  topInset: number;
  /** Number of columns: 1 for the list layout, 2 for the grid. Defaults to 2. */
  columns?: number;
}

export default function DraggableMasonry({
  sections,
  onSectionReorder,
  onDragStart,
  renderCard,
  refreshControl,
  contentBottomPadding,
  topInset,
  columns = DEFAULT_COLUMNS,
}: DraggableMasonryProps) {
  const { colors } = useTheme();
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollOffset = useScrollViewOffset(scrollRef);
  // One measure ref per section (drag never spans more than the pinned + other
  // sections, so two is always enough).
  const section0Ref = useAnimatedRef<Animated.View>();
  const section1Ref = useAnimatedRef<Animated.View>();
  const sectionRefs = useMemo(() => [section0Ref, section1Ref], [section0Ref, section1Ref]);

  // Seed from the window width (the content container spans the full width) so
  // cards render correctly on the very first frame instead of flashing blank
  // until onLayout fires; the layout pass then refines it.
  const [contentWidth, setContentWidth] = useState(() => Dimensions.get('window').width);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [orders, setOrders] = useState<Record<string, string[]>>({});
  const [isDragging, setIsDragging] = useState(false);

  // Shared values are stable across renders, but the wrapper object passed to
  // each card must be too — otherwise the cards' gesture handlers (which depend
  // on `shared`) get rebuilt on every hover-driven re-render and can interrupt
  // an active drag.
  const activeId = useSharedValue<string | null>(null);
  const activeSection = useSharedValue(-1);
  const dragTX = useSharedValue(0);
  const dragTY = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const startAbsX = useSharedValue(0);
  const startAbsY = useSharedValue(0);
  const startScroll = useSharedValue(0);
  const fingerAbsY = useSharedValue(0);
  const shared: SharedDragState = useMemo(
    () => ({
      activeId,
      activeSection,
      dragTX,
      dragTY,
      startX,
      startY,
      startAbsX,
      startAbsY,
      startScroll,
      fingerAbsY,
      scrollOffset,
    }),
    [activeId, activeSection, dragTX, dragTY, startX, startY, startAbsX, startAbsY, startScroll, fingerAbsY, scrollOffset],
  );

  // contentWidth is the measured border-box width of the padded container, so
  // subtract the horizontal padding on both sides to get the usable width that
  // the absolutely-positioned cards actually live in.
  const usableWidth = contentWidth - MASONRY_HORIZONTAL_PADDING * 2;
  const columnWidth = usableWidth > 0 ? (usableWidth - MASONRY_COLUMN_GAP * (columns - 1)) / columns : 0;

  // Map id -> Note for rendering by id, and sync per-section order from props
  // (skipped mid-drag so an in-flight reorder isn't clobbered by a re-render).
  const notesById = useMemo(() => {
    const map = new Map<string, Note>();
    sections.forEach((s) => s.data.forEach((n) => map.set(n.id, n)));
    return map;
  }, [sections]);

  useEffect(() => {
    if (isDragging) return;
    const next: Record<string, string[]> = {};
    sections.forEach((s) => {
      next[s.key] = s.data.map((n) => n.id);
    });
    setOrders(next);
  }, [sections, isDragging]);

  // Pack each section and keep the latest placements in refs for the hover math.
  const packedBySection = useMemo(() => {
    const result: Record<string, { placed: PlacedItem[]; containerHeight: number }> = {};
    sections.forEach((s) => {
      const order = orders[s.key] ?? s.data.map((n) => n.id);
      result[s.key] = packColumns(order, heights, {
        columnWidth,
        columnGap: MASONRY_COLUMN_GAP,
        rowGap: MASONRY_ROW_GAP,
        columns,
        estimatedHeight: ESTIMATED_CARD_HEIGHT,
      });
    });
    return result;
  }, [sections, orders, heights, columnWidth, columns]);

  const placedRef = useRef(packedBySection);
  placedRef.current = packedBySection;
  const ordersRef = useRef(orders);
  ordersRef.current = orders;
  const activeIdRef = useRef<string | null>(null);
  const columnWidthRef = useRef(columnWidth);
  columnWidthRef.current = columnWidth;
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const sectionKeysRef = useRef(sections.map((s) => s.key));
  sectionKeysRef.current = sections.map((s) => s.key);

  const handleMeasureHeight = useCallback((id: string, height: number) => {
    setHeights((prev) => (prev[id] === height ? prev : { ...prev, [id]: height }));
  }, []);

  const beginDrag = useCallback((id: string) => {
    activeIdRef.current = id;
    setIsDragging(true);
    onDragStart?.();
  }, [onDragStart]);

  const handleHover = useCallback((sectionIndex: number, cx: number, cy: number) => {
    const key = sectionKeysRef.current[sectionIndex];
    const activeId = activeIdRef.current;
    if (!key || !activeId) return;
    const packed = placedRef.current[key];
    const order = ordersRef.current[key];
    if (!packed || !order) return;
    const nextOrder = reorderForPointer(order, packed.placed, activeId, cx, cy, {
      columnWidth: columnWidthRef.current,
      columnGap: MASONRY_COLUMN_GAP,
      columns: columnsRef.current,
    });
    const changed = nextOrder.length !== order.length || nextOrder.some((v, i) => v !== order[i]);
    if (changed) {
      // Write back synchronously so a drop (or a subsequent hover) that fires
      // before React re-renders sees the latest ordering rather than the stale
      // ref value.
      const updated = { ...ordersRef.current, [key]: nextOrder };
      ordersRef.current = updated;
      setOrders(updated);
    }
  }, []);

  const commitDrop = useCallback((sectionIndex: number) => {
    const key = sectionKeysRef.current[sectionIndex];
    const order = ordersRef.current[key];
    if (!key || !order) return;
    const data = order.map((id) => notesById.get(id)).filter((n): n is Note => !!n);
    onSectionReorder(key, data);
  }, [notesById, onSectionReorder]);

  const endDrag = useCallback(() => {
    activeIdRef.current = null;
    setIsDragging(false);
  }, []);

  // Auto-scroll while a card is held near the top/bottom edge of the screen.
  const windowHeight = Dimensions.get('window').height;
  const topZone = topInset + AUTO_SCROLL_EDGE;
  const bottomZone = windowHeight - AUTO_SCROLL_EDGE;
  useFrameCallback(() => {
    'worklet';
    if (shared.activeId.value === null) return;
    const y = shared.fingerAbsY.value;
    if (y < topZone) {
      scrollTo(scrollRef, 0, Math.max(0, shared.scrollOffset.value - AUTO_SCROLL_SPEED), false);
    } else if (y > bottomZone) {
      scrollTo(scrollRef, 0, shared.scrollOffset.value + AUTO_SCROLL_SPEED, false);
    }
  }, true);

  const handleContentLayout = useCallback((e: LayoutChangeEvent) => {
    const width = e.nativeEvent.layout.width;
    setContentWidth((prev) => (prev === width ? prev : width));
  }, []);

  return (
    <Animated.ScrollView
      ref={scrollRef}
      scrollEnabled={!isDragging}
      keyboardShouldPersistTaps="always"
      refreshControl={refreshControl}
      contentContainerStyle={{ paddingBottom: contentBottomPadding }}
      testID="notes-masonry-draggable"
    >
      <View style={styles.content} onLayout={handleContentLayout}>
        {columnWidth > 0 &&
          sections.map((section, sectionIndex) => {
            const packed = packedBySection[section.key];
            if (!packed) return null;
            return (
              <View key={section.key}>
                {section.title ? (
                  <Text style={[listStyles.sectionHeader, { color: colors.textMuted }]}>{section.title}</Text>
                ) : null}
                <Animated.View
                  ref={sectionRefs[sectionIndex]}
                  style={{ height: packed.containerHeight, position: 'relative' }}
                >
                  {packed.placed.map((item) => {
                    const note = notesById.get(item.id);
                    if (!note) return null;
                    return (
                      <DraggableCard
                        key={item.id}
                        id={item.id}
                        sectionIndex={sectionIndex}
                        width={columnWidth}
                        x={item.x}
                        y={item.y}
                        sectionRef={sectionRefs[sectionIndex]}
                        shared={shared}
                        onMeasureHeight={handleMeasureHeight}
                        onBeginDrag={beginDrag}
                        onHover={handleHover}
                        onCommit={commitDrop}
                        onEndDrag={endDrag}
                      >
                        {renderCard(note)}
                      </DraggableCard>
                    );
                  })}
                </Animated.View>
              </View>
            );
          })}
      </View>
    </Animated.ScrollView>
  );
}

interface DraggableCardProps {
  id: string;
  sectionIndex: number;
  width: number;
  x: number;
  y: number;
  sectionRef: ReturnType<typeof useAnimatedRef<Animated.View>>;
  shared: SharedDragState;
  onMeasureHeight: (id: string, height: number) => void;
  onBeginDrag: (id: string) => void;
  onHover: (sectionIndex: number, cx: number, cy: number) => void;
  onCommit: (sectionIndex: number) => void;
  onEndDrag: () => void;
  children: React.ReactNode;
}

function DraggableCard({
  id,
  sectionIndex,
  width,
  x,
  y,
  sectionRef,
  shared,
  onMeasureHeight,
  onBeginDrag,
  onHover,
  onCommit,
  onEndDrag,
  children,
}: DraggableCardProps) {
  // The card's current slot lives in shared values so the gesture can read the
  // start position without depending on x/y — which change mid-drag as the card
  // moves through the order and would otherwise recreate the active gesture.
  const posX = useSharedValue(x);
  const posY = useSharedValue(y);
  useEffect(() => {
    posX.value = x;
    posY.value = y;
  }, [x, y, posX, posY]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activateAfterLongPress(LONG_PRESS_MS)
        .onStart((e) => {
          'worklet';
          shared.activeId.value = id;
          shared.activeSection.value = sectionIndex;
          shared.startX.value = posX.value;
          shared.startY.value = posY.value;
          shared.startAbsX.value = e.absoluteX;
          shared.startAbsY.value = e.absoluteY;
          shared.startScroll.value = shared.scrollOffset.value;
          shared.dragTX.value = 0;
          shared.dragTY.value = 0;
          shared.fingerAbsY.value = e.absoluteY;
          runOnJS(onBeginDrag)(id);
        })
        .onUpdate((e) => {
          'worklet';
          shared.dragTX.value = e.absoluteX - shared.startAbsX.value;
          shared.dragTY.value =
            e.absoluteY - shared.startAbsY.value + (shared.scrollOffset.value - shared.startScroll.value);
          shared.fingerAbsY.value = e.absoluteY;
          const m = measure(sectionRef);
          if (m !== null) {
            runOnJS(onHover)(sectionIndex, e.absoluteX - m.pageX, e.absoluteY - m.pageY);
          }
        })
        .onEnd(() => {
          'worklet';
          runOnJS(onCommit)(sectionIndex);
        })
        .onFinalize(() => {
          'worklet';
          shared.activeId.value = null;
          shared.activeSection.value = -1;
          shared.dragTX.value = 0;
          shared.dragTY.value = 0;
          runOnJS(onEndDrag)();
        }),
    [id, sectionIndex, posX, posY, sectionRef, shared, onBeginDrag, onHover, onCommit, onEndDrag],
  );

  const animatedStyle = useAnimatedStyle(() => {
    const isActive = shared.activeId.value === id && shared.activeSection.value === sectionIndex;
    if (isActive) {
      return {
        transform: [
          { translateX: shared.startX.value + shared.dragTX.value },
          { translateY: shared.startY.value + shared.dragTY.value },
          { scale: 1.03 },
        ],
        zIndex: 999,
        elevation: 8,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
      };
    }
    return {
      transform: [
        { translateX: withTiming(x, { duration: 180 }) },
        { translateY: withTiming(y, { duration: 180 }) },
        { scale: 1 },
      ],
      zIndex: 0,
      elevation: 0,
      shadowOpacity: 0,
    };
  });

  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => onMeasureHeight(id, e.nativeEvent.layout.height),
    [id, onMeasureHeight],
  );

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        onLayout={handleLayout}
        style={[styles.cardContainer, { width }, animatedStyle]}
      >
        {children}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: MASONRY_HORIZONTAL_PADDING,
  },
  cardContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
});
