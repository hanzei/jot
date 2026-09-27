import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Waits for a Headless UI dialog to finish its enter transition.
 *
 * A dialog closed within the first frames of that transition can get stuck
 * mid-enter: invisible, but still in the DOM and the accessibility tree
 * (#1040). No person confirms that fast, but a test clicking the confirm
 * button the moment it exists can under load. Headless UI sets
 * `data-transition` on the transitioning panel and backdrop from the first
 * render and clears it once the enter transition completes.
 */
export async function expectDialogSettled(dialog: Locator) {
  await expect(dialog.locator('[data-transition]')).toHaveCount(0);
}

/** Clicks `buttonName` in the topmost dialog once it has finished opening. */
export async function confirmDialog(page: Page, buttonName: string) {
  const dialog = page.getByRole('dialog').last();
  await expectDialogSettled(dialog);
  await dialog.getByRole('button', { name: buttonName }).click();
}
