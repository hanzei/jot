export function hashUsername(username: string): number {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash * 31 + username.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export const AVATAR_COLORS = [
  '#ef4444', // red-500
  '#f97316', // orange-500
  '#f59e0b', // amber-500
  '#ca8a04', // yellow-600
  '#65a30d', // lime-600
  '#22c55e', // green-500
  '#10b981', // emerald-500
  '#14b8a6', // teal-500
  '#06b6d4', // cyan-500
  '#0ea5e9', // sky-500
  '#3b82f6', // blue-500
  '#6366f1', // indigo-500
  '#8b5cf6', // violet-500
  '#a855f7', // purple-500
  '#d946ef', // fuchsia-500
  '#ec4899', // pink-500
];

export function getAvatarColor(username: string): string {
  // hashUsername returns a non-negative number, so the modulo is in range.
  return AVATAR_COLORS[hashUsername(username) % AVATAR_COLORS.length]!;
}

/** Colors light enough to need a visible border on white backgrounds. */
export const LIGHT_NOTE_COLORS: ReadonlySet<string> = new Set(['#ffffff', '#e8eaed']);

export const NOTE_COLORS = [
  '#ffffff',
  '#f28b82',
  '#fbbc04',
  '#ccff90',
  '#a7ffeb',
  '#aecbfa',
  '#d7aefb',
  '#fdcfe8',
  '#e6c9a8',
  '#e8eaed',
] as const;

/** Maps each NOTE_COLORS hex value to its i18n key (webapp/mobile locale `note.*` keys). */
export const NOTE_COLOR_NAME_KEYS: Record<string, string> = {
  '#ffffff': 'note.colorWhite',
  '#f28b82': 'note.colorCoral',
  '#fbbc04': 'note.colorYellow',
  '#ccff90': 'note.colorLime',
  '#a7ffeb': 'note.colorTeal',
  '#aecbfa': 'note.colorPeriwinkle',
  '#d7aefb': 'note.colorLavender',
  '#fdcfe8': 'note.colorPink',
  '#e6c9a8': 'note.colorSand',
  '#e8eaed': 'note.colorGray',
};
