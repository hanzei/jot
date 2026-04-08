import type { Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { VALIDATION } from '@jot/shared';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  inputRef?: Ref<HTMLInputElement>;
  shortcutHint?: string;
  // Escape always clears non-empty input; this flag additionally prevents parent/global Escape handlers.
  stopEscapePropagation?: boolean;
}

const SearchBar = ({ value, onChange, onSubmit, inputRef, shortcutHint, stopEscapePropagation = false }: SearchBarProps) => {
  const { t } = useTranslation();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit?.();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && value) {
      if (stopEscapePropagation) {
        e.preventDefault();
        e.stopPropagation();
      }
      onChange('');
    }
  };

  return (
    <div className="w-full sm:max-w-7xl">
      <form onSubmit={handleSubmit} role="search">
        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 sm:h-5 sm:w-5 text-gray-400 dark:text-gray-500" />
          <input
            ref={inputRef}
            type="text"
            placeholder={t('dashboard.searchPlaceholder')}
            aria-label={t('dashboard.searchAriaLabel')}
            className={`w-full pl-9 sm:pl-10 ${value ? 'pr-9 sm:pr-10' : shortcutHint ? 'pr-20 sm:pr-24' : 'pr-4'} py-2 text-sm sm:text-base border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            maxLength={VALIDATION.SEARCH_QUERY_MAX_LENGTH}
          />
          {value ? (
            <button
              type="button"
              aria-label={t('dashboard.searchClearAriaLabel')}
              onClick={() => onChange('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
            >
              <XMarkIcon className="h-4 w-4 sm:h-5 sm:w-5" />
            </button>
          ) : shortcutHint ? (
            <kbd
              data-testid="search-shortcut-hint"
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 inline-flex rounded border border-gray-300 dark:border-slate-600 bg-gray-100 dark:bg-slate-700 px-1.5 py-0.5 font-mono text-xs text-gray-600 dark:text-gray-300"
            >
              {shortcutHint}
            </kbd>
          ) : null}
        </div>
      </form>
    </div>
  );
};

export default SearchBar;
