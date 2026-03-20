import type { FocusEventHandler, KeyboardEventHandler, Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline';

export interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  inputRef?: Ref<HTMLInputElement>;
  inputTabIndex?: number;
  onBlur?: FocusEventHandler<HTMLInputElement>;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  showCloseButton?: boolean;
  onClose?: () => void;
  closeButtonTabIndex?: number;
  className?: string;
}

const SearchBar = ({
  value,
  onChange,
  onSubmit,
  inputRef,
  inputTabIndex,
  onBlur,
  onKeyDown,
  showCloseButton = false,
  onClose,
  closeButtonTabIndex,
  className = 'w-full sm:max-w-7xl',
}: SearchBarProps) => {
  const { t } = useTranslation();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit?.();
  };

  return (
    <div className={className}>
      <form onSubmit={handleSubmit} role="search">
        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 sm:h-5 sm:w-5 text-gray-400 dark:text-gray-500" />
          <input
            ref={inputRef}
            type="text"
            placeholder={t('dashboard.searchPlaceholder')}
            aria-label={t('dashboard.searchAriaLabel')}
            className={`w-full pl-9 sm:pl-10 py-2 text-sm sm:text-base border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
              showCloseButton ? 'pr-11' : 'pr-4'
            }`}
            tabIndex={inputTabIndex}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
            onKeyDown={onKeyDown}
          />
          {showCloseButton && (
            <button
              type="button"
              onClick={onClose}
              aria-label={t('dashboard.closeSearch')}
              tabIndex={closeButtonTabIndex}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-gray-400 transition-colors hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-gray-500 dark:hover:text-gray-300"
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </form>
    </div>
  );
};

export default SearchBar;
