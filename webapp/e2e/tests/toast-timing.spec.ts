import { test, expect } from '../fixtures';

test.use({ video: 'on' });

// These assertions enforce user-facing behavior: Undo/action toasts are visible
// for 7s, while standard toasts auto-dismiss in 4s. Elapsed time is the thing
// under test here, not a guess about it, so the page's clock is faked
// (page.clock) and run forward rather than actually waited out in real time —
// deterministic either way, but this way it costs milliseconds instead of
// eleven seconds.
const UNDO_TOAST_VISIBLE_MS = 7000;
const STANDARD_TOAST_VISIBLE_MS = 4000;
// Mirrors Toast.tsx's TOAST_EXIT_ANIMATION_MS: the fade-out delay between a
// toast's auto-dismiss timer firing and it actually leaving the DOM.
const TOAST_EXIT_ANIMATION_MS = 200;
// Extra virtual time to run *past* the exit-unmount timer rather than landing
// exactly on it. The auto-dismiss timer fires partway through the final advance
// and only then schedules the exit-unmount timer, so stopping the fake clock on
// that nested timer's exact due time is a boundary race — and can leave React's
// unmount commit unflushed — which is what made this test intermittently see the
// toast still present (count 1). The buffer removes that sensitivity; timers are
// relative to each toast's creation, so over-running here does not affect the
// standard-toast timing checked afterwards.
const TOAST_EXIT_SETTLE_BUFFER_MS = 500;

test.describe('Toast timing', () => {
  test.beforeEach(async ({ authenticatedUser }) => {
    void authenticatedUser;
  });

  test('keeps Undo toasts visible longer than standard toasts', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createNote('Toast Timing Note');

    // Install after setup and before the action that schedules the toast's
    // dismiss timer, so that timer itself is created against the fake clock.
    await page.clock.install();
    await page.clock.pauseAt(Date.now());

    await dashboardPage.archiveNote('Toast Timing Note');
    await dashboardPage.switchToArchived();
    await dashboardPage.deleteNote('Toast Timing Note');

    const undoToast = page.getByTestId('toast').last();
    await expect(undoToast).toBeVisible();
    await expect(undoToast.getByRole('button', { name: 'Undo' })).toBeVisible();

    await page.clock.runFor(UNDO_TOAST_VISIBLE_MS - 1);
    await expect(undoToast).toBeVisible();
    await page.clock.runFor(1 + TOAST_EXIT_ANIMATION_MS + TOAST_EXIT_SETTLE_BUFFER_MS);
    await expect(page.getByTestId('toast')).toHaveCount(0);

    await dashboardPage.switchToBin();
    await dashboardPage.permanentlyDeleteNoteFromBin('Toast Timing Note');

    const standardToast = page.getByTestId('toast').last();
    await expect(standardToast).toBeVisible();
    await expect(standardToast.getByRole('button', { name: 'Undo' })).toHaveCount(0);
    await page.clock.runFor(STANDARD_TOAST_VISIBLE_MS - 1);
    await expect(standardToast).toBeVisible();
    await page.clock.runFor(1 + TOAST_EXIT_ANIMATION_MS + TOAST_EXIT_SETTLE_BUFFER_MS);
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });
});
