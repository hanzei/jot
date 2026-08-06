import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bold, Heading, Italic, List, ListTodo, Strikethrough } from 'lucide-react';

export type MarkdownToolbarAction =
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'heading'
  | 'bullet'
  | 'checkbox';

interface MarkdownToolbarProps {
  onAction: (action: MarkdownToolbarAction) => void;
  /** id of the textarea the toolbar edits, for aria-controls. */
  controlsId: string;
}

// Same six actions, same icons and same order as the mobile formatting bar
// (mobile/src/screens/noteEditor/EditorToolbars.tsx), so the two clients read as
// one feature. Icons rather than letter glyphs: they need no translating, and
// the accessible name carries the meaning.
const ACTIONS: {
  id: MarkdownToolbarAction;
  Icon: typeof Bold;
  labelKey: string;
  /** Renders a divider before this button. */
  separatorBefore?: boolean;
}[] = [
  { id: 'bold', Icon: Bold, labelKey: 'note.formatBold' },
  { id: 'italic', Icon: Italic, labelKey: 'note.formatItalic' },
  { id: 'strikethrough', Icon: Strikethrough, labelKey: 'note.formatStrikethrough' },
  // Cycles ## -> ### -> none, so the icon deliberately names no level.
  { id: 'heading', Icon: Heading, labelKey: 'note.formatHeading', separatorBefore: true },
  { id: 'bullet', Icon: List, labelKey: 'note.formatBulletList' },
  { id: 'checkbox', Icon: ListTodo, labelKey: 'note.formatChecklist' },
];

/**
 * Markdown formatting buttons for the text-note editor.
 *
 * Focus behaviour is the load-bearing part:
 *
 * - onMouseDown is prevented on every button, so clicking one never moves focus
 *   out of the textarea. This is not polish — a blur would drop the selection
 *   the transform is about to act on, and NoteModal reads focus loss as intent
 *   to leave edit mode. (It is the web counterpart of the mobile bar's
 *   focusable={false}.)
 * - The toolbar is one tab stop with arrow-key navigation between buttons
 *   (the WAI-ARIA toolbar pattern), rather than six stops between the textarea
 *   and the Done button.
 */
export default function MarkdownToolbar({ onAction, controlsId }: MarkdownToolbarProps) {
  const { t } = useTranslation();
  const [focusedIndex, setFocusedIndex] = useState(0);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const moveFocus = (nextIndex: number) => {
    const index = (nextIndex + ACTIONS.length) % ACTIONS.length;
    setFocusedIndex(index);
    buttonRefs.current[index]?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        moveFocus(index + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        moveFocus(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        moveFocus(0);
        break;
      case 'End':
        event.preventDefault();
        moveFocus(ACTIONS.length - 1);
        break;
      default:
        break;
    }
  };

  // Deliberately the same theme-aware colours the modal's other icon buttons
  // use, with no special case for coloured notes. The mobile bar does carry one
  // (a fixed `#444`), because its note pastels are the same in both themes and
  // near-white icons fail against them; the webapp's colour classes are
  // theme-aware (`bg-red-200 dark:bg-red-900`), so the same override here would
  // *cause* the dark-theme contrast failure it prevents on mobile.
  return (
    <div
      role="toolbar"
      aria-label={t('note.formatToolbar')}
      aria-controls={controlsId}
      aria-orientation="horizontal"
      data-testid="markdown-toolbar"
      className="flex items-center gap-0.5 px-1 py-1 border-t border-gray-200 dark:border-slate-600"
    >
      {ACTIONS.map((action, index) => (
        <div key={action.id} className="contents">
          {action.separatorBefore && (
            <div aria-hidden="true" className="mx-1 h-5 w-px bg-gray-300 dark:bg-slate-600" />
          )}
          <button
            type="button"
            ref={(element) => {
              buttonRefs.current[index] = element;
            }}
            aria-label={t(action.labelKey)}
            title={t(action.labelKey)}
            data-testid={`format-${action.id}-btn`}
            tabIndex={index === focusedIndex ? 0 : -1}
            onKeyDown={(event) => handleKeyDown(event, index)}
            onFocus={() => setFocusedIndex(index)}
            // Keep the textarea focused and its selection intact — see above.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onAction(action.id)}
            className="p-1.5 rounded transition-colors text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-slate-700"
          >
            <action.Icon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
