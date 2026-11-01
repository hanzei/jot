import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import type { InlineLink } from '@jot/shared';

interface ItemLinkButtonProps {
  /** The row's links, from `inlineLinks`. Renders nothing when empty. */
  links: InlineLink[];
}

const BUTTON_CLASSES =
  // gray-500, not gray-400, for the same reason as the row's drag grip: it is a
  // graphical control on whatever colour the note has, and needs 3:1 against
  // the worst swatch (WCAG 1.4.11).
  'w-5 h-5 flex-shrink-0 flex items-center justify-center rounded text-gray-500 dark:text-gray-300 hover:text-gray-700 dark:hover:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

/** A link's host, for telling apart menu entries whose labels look alike. */
function hostOf(href: string): string {
  try {
    const url = new URL(href);
    return url.protocol === 'mailto:' ? url.pathname : url.host;
  } catch {
    return href;
  }
}

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
export default function ItemLinkButton({ links }: ItemLinkButtonProps) {
  const { t } = useTranslation();
  const [only] = links;
  if (!only) return null;

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
        className={`ml-1 ${BUTTON_CLASSES}`}
      >
        <ExternalLink className="h-4 w-4" aria-hidden="true" />
      </a>
    );
  }

  return (
    <Menu as="div" className="relative ml-1 flex-shrink-0">
      <MenuButton
        aria-label={t('note.openItemLinks')}
        title={t('note.openItemLinks')}
        data-testid="list-item-open-link"
        className={BUTTON_CLASSES}
      >
        <ExternalLink className="h-4 w-4" aria-hidden="true" />
      </MenuButton>
      <MenuItems
        // Anchored, so it renders in a portal and cannot be clipped by the
        // modal's scrolling item list.
        anchor="bottom end"
        data-testid="list-item-links-menu"
        className="z-50 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-md border border-gray-200 bg-white py-1 shadow-lg ring-1 ring-black/5 focus:outline-none dark:border-slate-600 dark:bg-slate-800"
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
              {link.label !== link.href && (
                <span className="block truncate text-xs text-gray-600 dark:text-gray-300">{hostOf(link.href)}</span>
              )}
            </a>
          </MenuItem>
        ))}
      </MenuItems>
    </Menu>
  );
}
