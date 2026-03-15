import { useEffect, useRef, useState, useCallback, useId } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';
import LetterAvatar from '@/components/LetterAvatar';
import { Collaborator, displayName } from '@/utils/collaborators';

interface AssigneePickerProps {
  collaborators: Collaborator[];
  currentAssigneeId: string;
  onAssign: (userId: string) => void;
  onClose: () => void;
}

export default function AssigneePicker({ collaborators, currentAssigneeId, onAssign, onClose }: AssigneePickerProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const instanceId = useId();
  const labelId = `${instanceId}-label`;

  const totalOptions = currentAssigneeId ? collaborators.length + 1 : collaborators.length;

  const initialIndex = currentAssigneeId
    ? collaborators.findIndex(c => c.userId === currentAssigneeId)
    : 0;
  const [focusedIndex, setFocusedIndex] = useState(initialIndex >= 0 ? initialIndex : 0);

  useEffect(() => {
    listRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const handleSelect = useCallback((index: number) => {
    if (index < collaborators.length) {
      const c = collaborators[index];
      const isSelected = c.userId === currentAssigneeId;
      onAssign(isSelected ? '' : c.userId);
    } else {
      onAssign('');
    }
    onClose();
  }, [collaborators, currentAssigneeId, onAssign, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
      case 'ArrowDown':
        e.preventDefault();
        setFocusedIndex(prev => (prev < totalOptions - 1 ? prev + 1 : prev));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusedIndex(prev => (prev > 0 ? prev - 1 : prev));
        break;
      case 'Home':
        e.preventDefault();
        setFocusedIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setFocusedIndex(totalOptions - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        handleSelect(focusedIndex);
        break;
      case 'Tab':
        e.preventDefault();
        onClose();
        break;
    }
  }, [onClose, totalOptions, focusedIndex, handleSelect]);

  useEffect(() => {
    if (listRef.current) {
      const focused = listRef.current.querySelector('[data-focused="true"]');
      if (focused && typeof focused.scrollIntoView === 'function') {
        focused.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [focusedIndex]);

  return (
    <div
      ref={containerRef}
      className="absolute z-30 right-0 mt-1 w-52 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 rounded-md shadow-lg py-1"
    >
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-200 dark:border-slate-600">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200" id={labelId}>
          {t('note.assignItem')}
        </span>
        <button
          onClick={onClose}
          className="p-0.5 rounded hover:bg-gray-100 dark:hover:bg-slate-700"
          aria-label={t('common.close')}
          tabIndex={-1}
        >
          <XMarkIcon className="h-4 w-4 text-gray-400 dark:text-gray-500" aria-hidden="true" />
        </button>
      </div>

      <div
        ref={listRef}
        role="listbox"
        aria-labelledby={labelId}
        aria-activedescendant={`${instanceId}-option-${focusedIndex}`}
        className="max-h-48 overflow-y-auto py-1 focus:outline-none"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        {collaborators.map((c, index) => {
          const isSelected = c.userId === currentAssigneeId;
          const isFocused = index === focusedIndex;
          return (
            <div
              key={c.userId}
              id={`${instanceId}-option-${index}`}
              role="option"
              aria-selected={isSelected}
              data-focused={isFocused}
              onClick={() => handleSelect(index)}
              onMouseEnter={() => setFocusedIndex(index)}
              className={`flex items-center w-full px-3 py-1.5 text-sm cursor-pointer ${
                isFocused && isSelected ? 'bg-blue-100 dark:bg-blue-900/40' :
                isFocused ? 'bg-gray-100 dark:bg-slate-700' :
                isSelected ? 'bg-blue-50 dark:bg-blue-900/20' : ''
              }`}
            >
              <LetterAvatar
                firstName={c.firstName}
                username={c.username}
                userId={c.userId}
                hasProfileIcon={c.hasProfileIcon}
                className="w-5 h-5 mr-2 flex-shrink-0"
              />
              <span className="text-gray-700 dark:text-gray-200 truncate">
                {displayName(c)}
              </span>
              {isSelected && (
                <svg className="w-4 h-4 ml-auto text-blue-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </div>
          );
        })}

        {currentAssigneeId && (
          <div
            id={`${instanceId}-option-${collaborators.length}`}
            role="option"
            aria-selected={false}
            data-focused={focusedIndex === collaborators.length}
            onClick={() => handleSelect(collaborators.length)}
            onMouseEnter={() => setFocusedIndex(collaborators.length)}
            className={`flex items-center w-full px-3 py-1.5 text-sm text-red-600 dark:text-red-400 cursor-pointer border-t border-gray-200 dark:border-slate-600 mt-1 pt-2.5 ${
              focusedIndex === collaborators.length ? 'bg-gray-100 dark:bg-slate-700' : ''
            }`}
          >
            <svg className="w-5 h-5 mr-2 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
            </svg>
            {t('note.unassign')}
          </div>
        )}
      </div>
    </div>
  );
}
