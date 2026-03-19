import { TagIcon } from '@heroicons/react/24/outline';
import type { Label } from '@jot/shared';

interface SidebarLabelsProps {
  labels: Label[];
  selectedLabelId?: string | null;
  onSelect?: (labelId: string) => void;
}

const SidebarLabels = ({ labels, selectedLabelId, onSelect }: SidebarLabelsProps) => {
  if (labels.length === 0) {
    return null;
  }

  return (
    <div className="px-2 pb-2">
      <ul className="space-y-0.5">
        {labels.map((label) => {
          const isActive = selectedLabelId === label.id;
          const className = `flex items-center gap-2 w-full text-left px-3 py-1.5 rounded-md text-sm ${
            isActive
              ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium'
              : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-700'
          }`;

          return (
            <li key={label.id}>
              <button
                type="button"
                onClick={() => onSelect?.(label.id)}
                className={className}
                aria-pressed={isActive ? 'true' : undefined}
              >
                <TagIcon className="h-4 w-4 shrink-0" />
                <span className="truncate min-w-0">{label.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default SidebarLabels;
