export const isEditableElementFocused = (activeElement: Element | null = document.activeElement) => {
  if (!activeElement) return false;

  return (
    activeElement instanceof HTMLInputElement ||
    activeElement instanceof HTMLTextAreaElement ||
    activeElement instanceof HTMLSelectElement ||
    activeElement instanceof HTMLElement && activeElement.isContentEditable
  );
};

export const isOverlayControlFocused = (activeElement: Element | null = document.activeElement) =>
  activeElement instanceof HTMLElement &&
  activeElement.closest('[role="menu"], [role="listbox"]') !== null;

// All app modals currently use Headless UI Dialog, which renders role+aria-modal when open.
export const isAnyModalDialogOpen = () =>
  document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
