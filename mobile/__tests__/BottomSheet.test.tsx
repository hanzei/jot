import { Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { render, fireEvent, type RenderResult } from '@testing-library/react-native';
import BottomSheet from '../src/components/BottomSheet';

jest.mock('../src/theme/ThemeContext', () => ({
  __esModule: true,
  useTheme: () => ({
    colors: { overlay: 'rgba(0,0,0,0.4)', sheetBackground: '#fff', handleColor: '#ddd', text: '#111' },
  }),
}));

type Instance = ReturnType<RenderResult['getByTestId']>;

function sheetPaddingBottom(backdrop: Instance): unknown {
  // The sheet is the backdrop's first child view.
  const sheet = backdrop.children[0] as Instance;
  return StyleSheet.flatten(sheet.props.style as StyleProp<ViewStyle>).paddingBottom;
}

describe('BottomSheet', () => {
  it('pads the bottom by the safe-area inset plus a fixed gap', async () => {
    const { getByTestId } = await render(
      <SafeAreaInsetsContext.Provider value={{ top: 0, right: 0, bottom: 34, left: 0 }}>
        <BottomSheet visible onClose={jest.fn()} testID="sheet"><Text>Row</Text></BottomSheet>
      </SafeAreaInsetsContext.Provider>,
    );
    expect(sheetPaddingBottom(getByTestId('sheet-backdrop'))).toBe(42);
  });

  it('keeps the same gap on a device without a home indicator', async () => {
    const { getByTestId } = await render(
      <SafeAreaInsetsContext.Provider value={{ top: 0, right: 0, bottom: 0, left: 0 }}>
        <BottomSheet visible onClose={jest.fn()} testID="sheet"><Text>Row</Text></BottomSheet>
      </SafeAreaInsetsContext.Provider>,
    );
    expect(sheetPaddingBottom(getByTestId('sheet-backdrop'))).toBe(8);
  });

  // RNTL bubbles a press to the nearest onPress, so it cannot show the inner
  // Pressable swallowing taps on the sheet; only the backdrop side is tested.
  it('renders the title and closes on a backdrop tap', async () => {
    const onClose = jest.fn();
    const { getByTestId, getByText } = await render(
      <BottomSheet visible onClose={onClose} title="Title" testID="sheet"><Text>Row</Text></BottomSheet>,
    );
    expect(getByText('Title')).toBeTruthy();
    await fireEvent.press(getByTestId('sheet-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
