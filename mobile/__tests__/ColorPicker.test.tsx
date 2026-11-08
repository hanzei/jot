import { render, fireEvent } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import ColorPicker from '../src/components/ColorPicker';
import { lightColors } from '../src/theme/colors';

async function renderPicker(currentColor: string, onSelect = jest.fn()) {
  return render(
    <ColorPicker visible={true} currentColor={currentColor} onSelect={onSelect} onClose={jest.fn()} />,
  );
}

describe('ColorPicker', () => {
  it('names the no-colour swatch Default and fills it with the theme surface, not white', async () => {
    const { getByTestId, getByLabelText } = await renderPicker('#f28b82');

    const swatch = getByTestId('color-swatch-ffffff');
    expect(getByLabelText('Default')).toBe(swatch);
    expect(StyleSheet.flatten(swatch.props.style).backgroundColor).toBe(lightColors.surface);
  });

  it.each(['#ffffff', '#FFFFFF', ''])('marks Default selected for an uncoloured note (%j)', async (color) => {
    const { getByTestId } = await renderPicker(color);

    expect(getByTestId('color-swatch-ffffff').props.accessibilityState).toEqual({ selected: true });
    expect(getByTestId('color-swatch-f28b82').props.accessibilityState).toEqual({ selected: false });
  });

  it('marks a real colour selected and leaves Default unselected', async () => {
    const { getByTestId } = await renderPicker('#f28b82');

    expect(getByTestId('color-swatch-f28b82').props.accessibilityState).toEqual({ selected: true });
    expect(getByTestId('color-swatch-ffffff').props.accessibilityState).toEqual({ selected: false });
  });

  it.each([['#ffffff', 'ffffff'], ['#f28b82', 'f28b82']])('rings the selected swatch in the primary colour (%s)', async (color, id) => {
    const { getByTestId } = await renderPicker(color);

    expect(StyleSheet.flatten(getByTestId(`color-swatch-${id}`).props.style)).toMatchObject({
      borderColor: lightColors.primary,
      borderWidth: 3,
    });
    expect(StyleSheet.flatten(getByTestId('color-swatch-fbbc04').props.style).borderColor).not.toBe(lightColors.primary);
  });

  it('selects the default colour value when Default is pressed', async () => {
    const onSelect = jest.fn();
    const { getByTestId } = await renderPicker('#f28b82', onSelect);

    await fireEvent.press(getByTestId('color-swatch-ffffff'));
    expect(onSelect).toHaveBeenCalledWith('#ffffff');
  });
});
