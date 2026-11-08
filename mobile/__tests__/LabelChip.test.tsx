import { render, fireEvent } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import LabelChip from '../src/components/LabelChip';
import { lightColors } from '../src/theme/colors';

describe('LabelChip', () => {
  it('uses the theme chip colours on an uncoloured note', async () => {
    const { getByTestId, getByText } = await render(<LabelChip name="personal" hasNoteColor={false} testID="chip" />);

    expect(StyleSheet.flatten(getByTestId('chip').props.style).backgroundColor).toBe(lightColors.chipBackground);
    expect(StyleSheet.flatten(getByText('personal').props.style).color).toBe(lightColors.chipText);
  });

  it('uses the fixed overlay colours on a coloured note', async () => {
    const { getByTestId, getByText } = await render(<LabelChip name="personal" hasNoteColor testID="chip" />);

    expect(StyleSheet.flatten(getByTestId('chip').props.style).backgroundColor).toBe('rgba(0,0,0,0.08)');
    expect(StyleSheet.flatten(getByText('personal').props.style).color).toBe('#444');
  });

  it('is a button only when it has an onPress', async () => {
    const onPress = jest.fn();
    const { getByRole, rerender, queryByRole } = await render(
      <LabelChip name="personal" hasNoteColor={false} onPress={onPress} accessibilityLabel="Labels: personal" />,
    );

    await fireEvent.press(getByRole('button', { name: 'Labels: personal' }));
    expect(onPress).toHaveBeenCalledTimes(1);

    await rerender(<LabelChip name="personal" hasNoteColor={false} />);
    expect(queryByRole('button')).toBeNull();
  });
});
