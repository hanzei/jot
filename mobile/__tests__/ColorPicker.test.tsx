import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import ColorPicker from '../src/components/ColorPicker';

describe('ColorPicker', () => {
  it('renders color swatches', () => {
    const { getAllByRole } = render(
      <ColorPicker currentColor="#ffffff" onSelect={jest.fn()} />
    );
    // 12 colors in the palette
    expect(getAllByRole('button').length).toBe(12);
  });

  it('calls onSelect with the chosen color', () => {
    const onSelect = jest.fn();
    const { getByAccessibilityLabel } = render(
      <ColorPicker currentColor="#ffffff" onSelect={onSelect} />
    );
    fireEvent.press(getByAccessibilityLabel('Select color #f28b82'));
    expect(onSelect).toHaveBeenCalledWith('#f28b82');
  });
});
