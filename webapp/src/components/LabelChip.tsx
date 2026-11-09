import type { MouseEvent } from 'react';

const CHIP_CLASSES = 'inline-flex items-center text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full px-2 py-0.5';

interface LabelChipProps {
  name: string;
  /** Makes the chip a button; without it the chip is plain display. */
  onClick?: ((e: MouseEvent<HTMLButtonElement>) => void) | undefined;
}

/** A label pill, shared by note cards and the note modal. */
export default function LabelChip({ name, onClick }: LabelChipProps) {
  if (!onClick) {
    return <span className={CHIP_CLASSES}>{name}</span>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${CHIP_CLASSES} hover:bg-blue-200 dark:hover:bg-blue-800/40 transition-colors cursor-pointer`}
    >
      {name}
    </button>
  );
}
