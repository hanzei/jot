import React from 'react';
import { StyleSheet } from 'react-native';
import { CloudOff } from 'lucide-react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaInsetsContext, type EdgeInsets } from 'react-native-safe-area-context';
import Banner from '../src/components/Banner';

const TOP_INSET = 24;
const ROW_HEIGHT = 40;
const BORDER_WIDTH = 1;
const ANIMATION_DURATION_MS = 300;

const INSETS: EdgeInsets = { top: TOP_INSET, right: 0, bottom: 0, left: 0 };

function renderBanner(props: { visible: boolean; applyTopInset: boolean }) {
  const ui = (next: { visible: boolean; applyTopInset: boolean }) => (
    <SafeAreaInsetsContext.Provider value={INSETS}>
      <Banner
        icon={CloudOff}
        text="You're offline."
        backgroundColor="#111827"
        borderColor="#374151"
        textColor="#ffffff"
        testID="banner"
        {...next}
      />
    </SafeAreaInsetsContext.Provider>
  );
  const view = render(ui(props));
  return { ...view, update: (next: { visible: boolean; applyTopInset: boolean }) => view.rerender(ui(next)) };
}

/** Resolves the container height, which is an animated node once measured. */
function heightOf(element: { props: Record<string, unknown> }): number {
  const { height } = StyleSheet.flatten(element.props.style as never) as { height: unknown };
  if (typeof height === 'number') return height;
  return (height as { __getValue: () => number }).__getValue();
}

function measureRow(getByTestId: (id: string) => unknown) {
  fireEvent(getByTestId('banner-row') as never, 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: 320, height: ROW_HEIGHT } },
  });
}

describe('Banner', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not render at all while hidden', () => {
    const { queryByTestId } = renderBanner({ visible: false, applyTopInset: false });
    expect(queryByTestId('banner')).toBeNull();
  });

  // The two assertions below are the "no jump" contract with ContentSafeArea:
  // the strip the banner adds and the top inset the content drops are the same
  // size and change on the same commit, so they cancel out.
  it('opens from exactly the top inset, which the content drops on the same commit', () => {
    const { getByTestId, update } = renderBanner({ visible: false, applyTopInset: false });

    // Becoming visible mounts the banner closed, before the row is measured.
    update({ visible: true, applyTopInset: true });

    expect(heightOf(getByTestId('banner'))).toBe(TOP_INSET);
  });

  it('sheds the top inset on the same commit the content takes it back', () => {
    const { getByTestId, update } = renderBanner({ visible: true, applyTopInset: true });
    measureRow(getByTestId);
    expect(heightOf(getByTestId('banner'))).toBe(TOP_INSET + ROW_HEIGHT + BORDER_WIDTH);

    // A banner that stops being visible also stops being the topmost visible
    // banner, so it loses the inset in the same render.
    update({ visible: false, applyTopInset: false });

    expect(heightOf(getByTestId('banner'))).toBe(ROW_HEIGHT + BORDER_WIDTH);
  });

  it('stays mounted while animating closed, then unmounts', () => {
    const { getByTestId, queryByTestId, update } = renderBanner({ visible: true, applyTopInset: true });
    measureRow(getByTestId);

    update({ visible: false, applyTopInset: false });
    expect(queryByTestId('banner')).not.toBeNull();

    act(() => {
      jest.advanceTimersByTime(ANIMATION_DURATION_MS * 2);
    });

    expect(queryByTestId('banner')).toBeNull();
  });

  it('applies the top inset to the row only when it owns it', () => {
    const { getByTestId, update } = renderBanner({ visible: true, applyTopInset: true });
    expect(StyleSheet.flatten(getByTestId('banner-row').props.style).marginTop).toBe(TOP_INSET);

    // Stacked below another banner: the one above already padded the safe area.
    update({ visible: true, applyTopInset: false });
    expect(StyleSheet.flatten(getByTestId('banner-row').props.style).marginTop).toBe(0);
  });

  it('clips the row instead of reflowing it while the height animates', () => {
    const { getByTestId } = renderBanner({ visible: true, applyTopInset: true });
    expect(StyleSheet.flatten(getByTestId('banner').props.style).overflow).toBe('hidden');
  });

  it('does not intercept touches while animating closed', () => {
    const onPress = jest.fn();
    const ui = (visible: boolean) => (
      <SafeAreaInsetsContext.Provider value={INSETS}>
        <Banner
          icon={CloudOff}
          text="3 changes couldn't be saved"
          backgroundColor="#111827"
          borderColor="#374151"
          textColor="#ffffff"
          testID="banner"
          visible={visible}
          applyTopInset={visible}
          onPress={onPress}
          accessibilityLabel="Review"
        />
      </SafeAreaInsetsContext.Provider>
    );
    const { getByTestId, rerender } = render(ui(true));
    expect(getByTestId('banner').props.pointerEvents).toBe('auto');

    rerender(ui(false));
    expect(getByTestId('banner').props.pointerEvents).toBe('none');
  });
});
