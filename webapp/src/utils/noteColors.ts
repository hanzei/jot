/**
 * Swatch classes for each NOTE_COLORS value: the colour as a note shows it,
 * light and dark, so a swatch in dark mode matches the dark card it produces.
 * `#ffffff` is "no colour" and follows the theme.
 */
export const NOTE_COLOR_SWATCH_CLASSES: Record<string, string> = {
  '#ffffff': 'bg-white dark:bg-slate-800 border-gray-300 dark:border-slate-600',
  '#f28b82': 'bg-red-200 dark:bg-red-900 border-red-300 dark:border-red-700',
  '#fbbc04': 'bg-yellow-100 dark:bg-yellow-900 border-yellow-300 dark:border-yellow-700',
  '#ccff90': 'bg-lime-100 dark:bg-lime-900 border-lime-300 dark:border-lime-700',
  '#a7ffeb': 'bg-teal-100 dark:bg-teal-900 border-teal-300 dark:border-teal-700',
  '#aecbfa': 'bg-blue-100 dark:bg-blue-900 border-blue-300 dark:border-blue-700',
  '#d7aefb': 'bg-purple-100 dark:bg-purple-900 border-purple-300 dark:border-purple-700',
  '#fdcfe8': 'bg-pink-100 dark:bg-pink-900 border-pink-300 dark:border-pink-700',
  '#e6c9a8': 'bg-amber-100 dark:bg-amber-900 border-amber-300 dark:border-amber-700',
  '#e8eaed': 'bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-600',
};
