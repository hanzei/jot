// Throwaway: verify the grip reveals on card focus. Deleted before push.
import { test, expect } from '../fixtures';

const OUT = '/tmp/claude-0/-home-user-jot/2c37c2cd-1c5e-5b36-aad8-1e047b5f248f/scratchpad';

test('grip reveals on card highlight', async ({ authenticatedUser, page, dashboardPage }) => {
  void authenticatedUser;
  await page.setViewportSize({ width: 1100, height: 500 });
  await dashboardPage.goto();
  await dashboardPage.createListNote('Markdown list', ['Bold step one', 'Italic step two', 'Foo bar']);

  const grip = page.getByRole('button', { name: 'Reorder note' }).first();

  // Focus the card's OPEN button (the "highlight"), not the grip.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  await dashboardPage.noteCardButton('Markdown list').focus();

  // The grip must be visible now, before any Tab.
  await expect(grip).toBeVisible();
  const opacity = await grip.evaluate((el) => getComputedStyle(el).opacity);
  console.log('GRIP OPACITY ON CARD FOCUS', opacity);
  await page.locator('main').screenshot({ path: `${OUT}/11-grip-on-card-focus.png` });
});
