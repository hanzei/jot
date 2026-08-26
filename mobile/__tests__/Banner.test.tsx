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

async function renderBanner(props: { visible: boolean; applyTopInset: boolean }) {
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
  const view = await render(ui(props));
  return { ...view, update: (next: { visible: boolean; applyTopInset: boolean }) => view.rerender(ui(next)) };
}

/** Resolves the container height, which is an animated node once measured. */
function heightOf(element: { props: Record<string, unknown> }): number {
  const { height } = StyleSheet.flatten(element.props.style as never) as { height: unknown };
  if (typeof height === 'number') return height;
  return (height as { __getValue: () => number }).__getValue();
}

async function measureRow(getByTestId: (id: string) => unknown) {
  await fireEvent(getByTestId('banner-row') as never, 'layout', {
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

  it('does not render at all while hidden', async () => {
    const { queryByTestId } = await renderBanner({ visible: false, applyTopInset: false });
    expect(queryByTestId('banner')).toBeNull();
  });

  // The two assertions below are the "no jump" contract with ContentSafeArea:
  // the strip the banner adds and the top inset the content drops are the same
  // size and change on the same commit, so they cancel out.
  it('opens from exactly the top inset, which the content drops on the same commit', async () => {
    const { getByTestId, update } = await renderBanner({ visible: false, applyTopInset: false });

    // Becoming visible mounts the banner closed, before the row is measured.
    await update({ visible: true, applyTopInset: true });

    expect(heightOf(getByTestId('banner'))).toBe(TOP_INSET);
  });

  it('sheds the top inset on the same commit the content takes it back', async () => {
    const { getByTestId, update } = await renderBanner({ visible: true, applyTopInset: true });
    await measureRow(getByTestId);
    expect(heightOf(getByTestId('banner'))).toBe(TOP_INSET + ROW_HEIGHT + BORDER_WIDTH);

    // A banner that stops being visible also stops being the topmost visible
    // banner, so it loses the inset in the same render.
    await update({ visible: false, applyTopInset: false });

    expect(heightOf(getByTestId('banner'))).toBe(ROW_HEIGHT + BORDER_WIDTH);
  });

  it('stays mounted while animating closed, then unmounts', async () => {
    const { getByTestId, queryByTestId, update } = await renderBanner({ visible: true, applyTopInset: true });
    await measureRow(getByTestId);

    await update({ visible: false, applyTopInset: false });
    expect(queryByTestId('banner')).not.toBeNull();

    await act(() => {
      jest.advanceTimersByTime(ANIMATION_DURATION_MS * 2);
    });

    expect(queryByTestId('banner')).toBeNull();
  });

  it('applies the top inset to the row only when it owns it', async () => {
    const { getByTestId, update } = await renderBanner({ visible: true, applyTopInset: true });
    expect(StyleSheet.flatten(getByTestId('banner-row').props.style).marginTop).toBe(TOP_INSET);

    // Stacked below another banner: the one above already padded the safe area.
    await update({ visible: true, applyTopInset: false });
    expect(StyleSheet.flatten(getByTestId('banner-row').props.style).marginTop).toBe(0);
  });

  it('clips the row instead of reflowing it while the height animates', async () => {
    const { getByTestId } = await renderBanner({ visible: true, applyTopInset: true });
    expect(StyleSheet.flatten(getByTestId('banner').props.style).overflow).toBe('hidden');
  });

  it('does not intercept touches while animating closed', async () => {
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
    const { getByTestId, rerender } = await render(ui(true));
    expect(getByTestId('banner').props.pointerEvents).toBe('auto');

    await rerender(ui(false));
    expect(getByTestId('banner').props.pointerEvents).toBe('none');
  });
});
