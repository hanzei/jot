import type { FocusEvent, KeyboardEvent, Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onInputBlur?: (event: FocusEvent<HTMLInputElement>) => void;
  onInputKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  inputTabIndex?: number;
  containerClassName?: string;
}

const SearchBar = ({
  value,
  onChange,
  onSubmit,
  autoFocus = false,
  inputRef,
  onInputBlur,
  onInputKeyDown,
  inputTabIndex,
  containerClassName,
}: SearchBarProps) => {
  const { t } = useTranslation();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit?.();
  };

  return (
    <div className={`w-full sm:max-w-7xl ${containerClassName ?? ''}`.trim()}>
      <form onSubmit={handleSubmit} role="search">
        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 sm:h-5 sm:w-5 text-gray-400 dark:text-gray-500" />
          <input
            ref={inputRef}
            type="text"
            placeholder={t('dashboard.searchPlaceholder')}
            aria-label={t('dashboard.searchAriaLabel')}
            className="w-full pl-9 sm:pl-10 pr-4 py-2 text-sm sm:text-base border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            autoFocus={autoFocus}
            onBlur={onInputBlur}
            onKeyDown={onInputKeyDown}
            tabIndex={inputTabIndex}
          />
        </div>
      </form>
    </div>
  );
};

export default SearchBar;
