import { lightColors, darkColors, type ThemeColors } from '../src/theme/colors';
import { getContrastRatio } from '../src/utils/colorContrast';

/** Backgrounds that subtle fills and dividers are drawn on. */
const SURFACES = ['background', 'surface', 'cardBackground', 'sheetBackground'] as const;

/**
 * Minimum ratio for a fill or divider to stay visible against a surface. Light
 * mode's borderLight on its page background (~1.05) sets the floor: subtle,
 * but there. A fill equal to its surface scores exactly 1.
 */
const MIN_FILL_CONTRAST = 1.05;

/** WCAG AA for normal text. */
const MIN_TEXT_CONTRAST = 4.5;

function ratio(a: string, b: string): number {
  const value = getContrastRatio(a, b);
  if (value === null) throw new Error(`not a hex colour: ${a} / ${b}`);
  return value;
}

describe.each([
  ['light', lightColors],
  ['dark', darkColors],
] as const)('%s theme', (_name, colors: ThemeColors) => {
  // borderLight once equalled surface in dark mode, which hid every divider
  // and label chip drawn with it.
  it.each(['borderLight', 'chipBackground'] as const)('%s is distinguishable from every surface', (token) => {
    const tooFaint = SURFACES.filter((surface) => ratio(colors[token], colors[surface]) < MIN_FILL_CONTRAST);
    expect(tooFaint).toEqual([]);
  });

  it('chip text is readable on the chip', () => {
    expect(ratio(colors.chipText, colors.chipBackground)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });
});
