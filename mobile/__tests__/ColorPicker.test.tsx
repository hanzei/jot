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

  it('keeps the no-colour glyph on Default when selected and adds a check badge', async () => {
    const { getByTestId, queryByTestId, rerender } = await renderPicker('#ffffff');
    expect(getByTestId('color-swatch-default-selected')).toBeTruthy();

    await rerender(<ColorPicker visible={true} currentColor="#f28b82" onSelect={jest.fn()} onClose={jest.fn()} />);
    expect(queryByTestId('color-swatch-default-selected')).toBeNull();
  });

  it('selects the default colour value when Default is pressed', async () => {
    const onSelect = jest.fn();
    const { getByTestId } = await renderPicker('#f28b82', onSelect);

    await fireEvent.press(getByTestId('color-swatch-ffffff'));
    expect(onSelect).toHaveBeenCalledWith('#ffffff');
  });
});
