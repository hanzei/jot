import { getCompletedSectionDividerColor, isWhiteHexColor } from '../src/utils/colorContrast';

describe('getCompletedSectionDividerColor', () => {
  it('returns darker divider for light backgrounds', () => {
    expect(getCompletedSectionDividerColor('#f28b82')).toBe('rgba(0,0,0,0.2)');
    expect(getCompletedSectionDividerColor('#ffffff')).toBe('rgba(0,0,0,0.2)');
    expect(getCompletedSectionDividerColor('#fff')).toBe('rgba(0,0,0,0.2)');
  });

  it('returns lighter divider for dark backgrounds', () => {
    expect(getCompletedSectionDividerColor('#1f2937')).toBe('rgba(255,255,255,0.26)');
    expect(getCompletedSectionDividerColor('#000')).toBe('rgba(255,255,255,0.26)');
  });

  it('uses dark divider when luminance is at threshold boundary', () => {
    expect(getCompletedSectionDividerColor('#b5b5b5')).toBe('rgba(0,0,0,0.2)');
  });

  it('falls back to a safe divider when color format is not supported', () => {
    expect(getCompletedSectionDividerColor('rgb(0,0,0)')).toBe('rgba(0,0,0,0.18)');
    expect(getCompletedSectionDividerColor('invalid')).toBe('rgba(0,0,0,0.18)');
  });
});

describe('isWhiteHexColor', () => {
  it('accepts 3 and 6 digit white hex values with mixed case', () => {
    expect(isWhiteHexColor('#fff')).toBe(true);
    expect(isWhiteHexColor('#FFFFFF')).toBe(true);
    expect(isWhiteHexColor('ffffff')).toBe(true);
  });

  it('returns false for non-white or invalid values', () => {
    expect(isWhiteHexColor('#fefefe')).toBe(false);
    expect(isWhiteHexColor('rgb(255,255,255)')).toBe(false);
    expect(isWhiteHexColor('invalid')).toBe(false);
  });
});
