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

/**
 * Which editing surface the toolbar sits over. It selects the button set, and
 * the two sets are not a preference — they are the two feature sets of
 * docs/specs/markdown-rendering.md.
 *
 * - `content` — a text note's body, the full §2 set.
 * - `item` — a list-item row, the inline subset of §2.1. The three block
 *   actions are absent because an item cannot hold their output: item text is
 *   lexed as inline content, so `## `, `- ` and `- [ ] ` stay literal source. A
 *   heading button there would write characters guaranteed never to render, and
 *   a checkbox button would write a second checkbox next to the row's real one.
 */
export type MarkdownToolbarVariant = 'content' | 'item';

interface MarkdownToolbarProps {
  onAction: (action: MarkdownToolbarAction) => void;
  /**
   * id of the textarea the toolbar edits, for aria-controls. Omitted when there
   * is none — the toolbar sitting in its reserved slot with nothing focused,
   * whether that is a list with no row editing or a text note showing its
   * preview — since pointing aria-controls at an id that is not in the document
   * is worse than saying nothing.
   */
  controlsId?: string | undefined;
  /** Defaults to the full text-note set. */
  variant?: MarkdownToolbarVariant;
  /**
   * Fires when focus leaves the toolbar as a whole (not when it moves between
   * its own buttons). A caller that shows the toolbar conditionally needs this:
   * the toolbar reports no editing state of its own, so nothing else tells it
   * that focus has moved on.
   */
  onBlurOut?: (() => void) | undefined;
}

// Same actions, same icons and same order as the mobile formatting bar
// (mobile/src/screens/noteEditor/EditorToolbars.tsx), so the two clients read as
// one feature — including which three an item row drops. Icons rather than
// letter glyphs: they need no translating, and the accessible name carries the
// meaning.
const ACTIONS: {
  id: MarkdownToolbarAction;
  Icon: typeof Bold;
  labelKey: string;
  /** Renders a divider before this button, unless it ends up first. */
  separatorBefore?: boolean;
  /** Absent from the item variant — see MarkdownToolbarVariant. */
  inlineOnly?: boolean;
}[] = [
  { id: 'bold', Icon: Bold, labelKey: 'note.formatBold', inlineOnly: true },
  { id: 'italic', Icon: Italic, labelKey: 'note.formatItalic', inlineOnly: true },
  { id: 'strikethrough', Icon: Strikethrough, labelKey: 'note.formatStrikethrough', inlineOnly: true },
  // Cycles ## -> ### -> none, so the icon deliberately names no level.
  { id: 'heading', Icon: Heading, labelKey: 'note.formatHeading', separatorBefore: true },
  { id: 'bullet', Icon: List, labelKey: 'note.formatBulletList' },
  { id: 'checkbox', Icon: ListTodo, labelKey: 'note.formatChecklist' },
];

/**
 * Markdown formatting buttons, over a text note's content or a list note's rows.
 * `variant` picks which buttons appear; where the bar sits is the caller's
 * business, and NoteModal docks one instance above the modal's action bar for
 * both variants.
 *
 * Focus behaviour is the load-bearing part:
 *
 * - onMouseDown is prevented on every button, so clicking one never moves focus
 *   out of the textarea. This is not polish — a blur would drop the selection
 *   the transform is about to act on. On the `item` variant it does more than
 *   that: a row shows source for exactly as long as it holds the caret, so a
 *   blur would swap the row back to its rendered form mid-press, and NoteModal
 *   would read the focus loss as the row no longer being edited. (It is the web
 *   counterpart of the mobile bar's focusable={false}.)
 * - The toolbar is one tab stop with arrow-key navigation between buttons
 *   (the WAI-ARIA toolbar pattern), rather than one stop per button between the
 *   editor and the rest of the modal.
 */
export default function MarkdownToolbar({
  onAction,
  controlsId,
  variant = 'content',
  onBlurOut,
}: MarkdownToolbarProps) {
  const { t } = useTranslation();
  const [focusedIndex, setFocusedIndex] = useState(0);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const shown = variant === 'item' ? ACTIONS.filter((action) => action.inlineOnly) : ACTIONS;

  // One instance serves both variants, and converting a note between text and
  // list swaps them under a live focusedIndex. Clamping here is what keeps the
  // roving tabindex on a button that exists: an index left pointing past the
  // shorter item set would give *no* button `tabIndex=0`, dropping the toolbar
  // out of the tab order entirely.
  const activeIndex = Math.min(focusedIndex, shown.length - 1);

  const moveFocus = (nextIndex: number) => {
    const index = (nextIndex + shown.length) % shown.length;
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
        moveFocus(shown.length - 1);
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
      // React's onBlur is focusout, so it bubbles and one handler here covers
      // every button. Movement between two buttons of this same toolbar is not
      // leaving it, and must not be reported as such.
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        onBlurOut?.();
      }}
    >
      {shown.map((action, index) => (
        <div key={action.id} className="contents">
          {action.separatorBefore && index > 0 && (
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
            tabIndex={index === activeIndex ? 0 : -1}
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
