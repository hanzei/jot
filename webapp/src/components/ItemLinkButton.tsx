import { memo } from 'react';
import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import type { InlineLink } from '@jot/shared';

interface ItemLinkButtonProps {
  /** The row's links, from `itemLinks`. Renders nothing when empty. */
  links: InlineLink[];
}

const BUTTON_CLASSES =
  // gray-500, not gray-400, for the same reason as the row's drag grip: it is a
  // graphical control on whatever colour the note has, and needs 3:1 against
  // the worst swatch (WCAG 1.4.11).
  'ml-1 w-5 h-5 flex-shrink-0 flex items-center justify-center rounded text-gray-500 dark:text-gray-300 hover:text-gray-700 dark:hover:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

/**
 * The editable list-item row's way to its links.
 *
 * That row renders a link as plain text, because a click on the text already
 * means "put the caret here" (docs/specs/markdown-rendering.md §1.2). This is
 * the second, separate target. Always visible rather than revealed on hover
 * like the row's other controls: the label carries no link styling, so this
 * icon is the only sign the item has a link at all.
 *
 * One link is a real anchor, so middle-click, "copy link address" and the
 * status-bar preview all work. Several open a menu of anchors rather than
 * guessing which one was meant.
 */
function ItemLinkButton({ links }: ItemLinkButtonProps) {
  const { t } = useTranslation();
  const [only] = links;
  if (!only) return null;
  const icon = <ExternalLink className="h-4 w-4" aria-hidden="true" />;

  if (links.length === 1) {
    return (
      <a
        href={only.href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t('note.openItemLink', { label: only.label })}
        title={only.href}
        data-testid="list-item-open-link"
        // Keeps the caret in the row's textarea: the click is a navigation, not a
        // reason to collapse the row being edited.
        onMouseDown={(e) => e.preventDefault()}
        className={BUTTON_CLASSES}
      >
        {icon}
      </a>
    );
  }

  return (
    <Menu as="div" className="flex-shrink-0">
      <MenuButton
        aria-label={t('note.openItemLinks')}
        title={t('note.openItemLinks')}
        data-testid="list-item-open-link"
        className={BUTTON_CLASSES}
      >
        {icon}
      </MenuButton>
      <MenuItems
        // Anchored, so it renders in a portal and cannot be clipped by the
        // modal's scrolling item list. The gap goes through the anchor rather
        // than a margin, which would survive a flip to above the button.
        anchor={{ to: 'bottom end', gap: 4 }}
        data-testid="list-item-links-menu"
        // The panel classes match the note's other menus (NoteModal's overflow
        // menu), entrance transition and dark ring included.
        className="z-50 w-64 max-w-[calc(100vw-2rem)] origin-top-right rounded-md border border-gray-200 bg-white py-1 shadow-lg ring-1 ring-black/5 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:ring-slate-600/20 transition duration-100 ease-out starting:scale-95 starting:opacity-0 motion-reduce:transition-none"
      >
        {links.map((link) => (
          <MenuItem key={link.href}>
            <a
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="block px-4 py-2 text-sm text-gray-700 data-[focus]:bg-gray-100 dark:text-gray-200 dark:data-[focus]:bg-slate-700"
            >
              <span className="block truncate">{link.label}</span>
              {link.host !== null && (
                <span className="block truncate text-xs text-gray-600 dark:text-gray-300">{link.host}</span>
              )}
            </a>
          </MenuItem>
        ))}
      </MenuItems>
    </Menu>
  );
}

// Memoized: SortableItem re-renders every row on each keystroke anywhere in the
// note, and a several-links row holds a Headless UI Menu whose hooks run even
// while it is closed. `links` only changes identity when the row's text does.
export default memo(ItemLinkButton);
