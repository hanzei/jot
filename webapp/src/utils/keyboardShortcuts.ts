export const isEditableElementFocused = (activeElement: Element | null = document.activeElement) => {
  if (!activeElement) return false;

  return (
    activeElement instanceof HTMLInputElement ||
    activeElement instanceof HTMLTextAreaElement ||
    activeElement instanceof HTMLSelectElement ||
    activeElement instanceof HTMLElement && activeElement.isContentEditable
  );
};

const OVERLAY_ROLE_SELECTOR = '[role="menu"], [role="listbox"]';

const isElementVisible = (element: HTMLElement) =>
  !element.hidden &&
  element.getAttribute('aria-hidden') !== 'true' &&
  element.getClientRects().length > 0;

const hasExpandedOrOpenControlledAncestor = (activeElement: HTMLElement) => {
  let currentElement: HTMLElement | null = activeElement;
  while (currentElement) {
    if (currentElement.getAttribute('aria-expanded') === 'true') {
      return true;
    }

    const controlsId = currentElement.getAttribute('aria-controls');
    if ((currentElement.hasAttribute('aria-haspopup') || controlsId) && controlsId) {
      const controlledElement = document.getElementById(controlsId);
      if (controlledElement instanceof HTMLElement && isElementVisible(controlledElement)) {
        return true;
      }
    }

    currentElement = currentElement.parentElement;
  }

  return false;
};

export const isOverlayActive = (activeElement: Element | null = document.activeElement) => {
  if (!(activeElement instanceof HTMLElement)) {
    return false;
  }

  if (activeElement.closest(OVERLAY_ROLE_SELECTOR) !== null) {
    return true;
  }

  return hasExpandedOrOpenControlledAncestor(activeElement);
};

export const isOverlayControlFocused = (activeElement: Element | null = document.activeElement) =>
  isOverlayActive(activeElement);

// All app modals currently use Headless UI Dialog, which renders role+aria-modal when open.
export const isAnyModalDialogOpen = () =>
  document.querySelector('[role="dialog"][aria-modal="true"]') !== null || isOverlayActive();
