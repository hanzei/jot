import { useEffect, useRef } from 'react';
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

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      ref={containerRef}
      className="absolute z-30 right-0 mt-1 w-52 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 rounded-md shadow-lg py-1"
    >
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-200 dark:border-slate-600">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
          {t('note.assignItem')}
        </span>
        <button
          onClick={onClose}
          className="p-0.5 rounded hover:bg-gray-100 dark:hover:bg-slate-700"
          aria-label={t('common.close')}
        >
          <XMarkIcon className="h-4 w-4 text-gray-400" />
        </button>
      </div>

      <div className="max-h-48 overflow-y-auto py-1">
        {collaborators.map(c => {
          const isSelected = c.userId === currentAssigneeId;
          return (
            <button
              key={c.userId}
              onClick={() => {
                onAssign(isSelected ? '' : c.userId);
                onClose();
              }}
              className={`flex items-center w-full px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-slate-700 ${
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
                <svg className="w-4 h-4 ml-auto text-blue-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          );
        })}
      </div>

      {currentAssigneeId && (
        <div className="border-t border-gray-200 dark:border-slate-600 pt-1">
          <button
            onClick={() => {
              onAssign('');
              onClose();
            }}
            className="flex items-center w-full px-3 py-1.5 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-slate-700"
          >
            <svg className="w-5 h-5 mr-2 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="9" />
            </svg>
            {t('note.unassign')}
          </button>
        </div>
      )}
    </div>
  );
}
