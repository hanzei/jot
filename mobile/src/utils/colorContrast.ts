function normalizeHexColor(color: string): string | null {
  const normalized = color.trim().replace(/^#/, '');
  if (!/^[\da-fA-F]{3}$|^[\da-fA-F]{6}$/.test(normalized)) return null;
  return normalized.length === 3
    ? normalized.split('').map((char) => `${char}${char}`).join('').toLowerCase()
    : normalized.toLowerCase();
}

function hexToRgb(color: string): { r: number; g: number; b: number } | null {
  const normalized = normalizeHexColor(color);
  if (!normalized) return null;

  const intValue = Number.parseInt(normalized, 16);
  return {
    r: (intValue >> 16) & 255,
    g: (intValue >> 8) & 255,
    b: intValue & 255,
  };
}

function toLuminanceChannel(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function getRelativeLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  return (
    0.2126 * toLuminanceChannel(r) +
    0.7152 * toLuminanceChannel(g) +
    0.0722 * toLuminanceChannel(b)
  );
}

export function getCompletedSectionDividerColor(noteBackground: string): string {
  const rgb = hexToRgb(noteBackground);
  if (!rgb) {
    return 'rgba(0,0,0,0.18)';
  }

  // Use a dark divider on lighter backgrounds and a light divider on darker ones.
  return getRelativeLuminance(rgb) > 0.45
    ? 'rgba(0,0,0,0.2)'
    : 'rgba(255,255,255,0.26)';
}

export function isWhiteHexColor(color: string): boolean {
  const normalized = normalizeHexColor(color);
  return normalized === 'ffffff';
}
