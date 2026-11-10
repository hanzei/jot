import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../fixtures';

/**
 * The note modal's zoom transition (src/utils/noteZoom.ts): opened from a card
 * it grows out of that card, and closes back onto wherever the card is *now*;
 * opened any other way it fades in place; under reduced motion it does
 * neither.
 *
 * Asserting on pixels mid-animation would be timing-dependent, so each test
 * records the Web Animations the page starts (element, keyframes, duration, and
 * the element's untransformed rect at that moment) and checks their geometry:
 * a zoom's translate must carry the panel's centre onto the card's centre.
 */

interface RecordedAnimation {
  isPanel: boolean;
  isGhost: boolean;
  ariaHidden: string | null;
  frames: Array<{ transform?: string; opacity?: number }>;
  duration: number;
  rect: { x: number; y: number; width: number; height: number };
}

declare global {
  interface Window {
    __noteZoomAnimations?: RecordedAnimation[];
  }
}

async function recordAnimations(page: Page) {
  await page.evaluate(() => {
    window.__noteZoomAnimations = [];
    const original = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      const rect = this.getBoundingClientRect();
      window.__noteZoomAnimations!.push({
        isPanel: this.hasAttribute('data-note-modal-panel'),
        isGhost: this.hasAttribute('data-note-zoom-ghost'),
        ariaHidden: this.getAttribute('aria-hidden'),
        frames: JSON.parse(JSON.stringify(keyframes)),
        duration: typeof options === 'number' ? options : Number(options?.duration ?? 0),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
      return original.call(this, keyframes, options);
    };
  });
}

const recorded = (page: Page) => page.evaluate(() => window.__noteZoomAnimations ?? []);

// Opening transforms the live panel (which also runs height-only animations,
// useSizeTransition); closing transforms a marked snapshot of it. The ghost
// backdrop only fades.
const transforms = (a: RecordedAnimation) => a.frames.some(f => f.transform);
const panelOpenings = async (page: Page) =>
  (await recorded(page)).filter(a => a.isPanel && transforms(a));
const ghostClosings = async (page: Page) =>
  (await recorded(page)).filter(a => a.isGhost && transforms(a));
const ghosts = (page: Page) => page.locator('[data-note-zoom-ghost]');

/** Waits for the one close the test triggered and returns it. */
async function onlyGhostClosing(page: Page): Promise<RecordedAnimation> {
  await expect.poll(async () => (await ghostClosings(page)).length).toBe(1);
  return (await ghostClosings(page))[0]!;
}

const lastFrame = (animation: RecordedAnimation) => animation.frames[animation.frames.length - 1]!;

/** Where `frame`'s translate carries the centre of `rect`. */
function translatedCentre(rect: RecordedAnimation['rect'], transform: string) {
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(transform);
  expect(match, `expected a translate in "${transform}"`).not.toBeNull();
  return {
    x: rect.x + rect.width / 2 + Number(match![1]),
    y: rect.y + rect.height / 2 + Number(match![2]),
  };
}

async function centreOf(locator: Locator) {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function expectSamePoint(actual: { x: number; y: number }, expected: { x: number; y: number }) {
  expect(actual.x).toBeCloseTo(expected.x, 0);
  expect(actual.y).toBeCloseTo(expected.y, 0);
}

test.describe('Note modal zoom', () => {
  // The suite runs with reduced motion by default (playwright.config.ts).
  test.use({ reducedMotion: 'no-preference' });

  test('opens out of the clicked card and closes back onto it', async ({ page, dashboardPage, authenticatedUser }) => {
    void authenticatedUser;
    await dashboardPage.createNote('Zoom note');
    const card = dashboardPage.noteCardByExactTitle('Zoom note');
    const cardCentre = await centreOf(card);
    await recordAnimations(page);

    await dashboardPage.openNote('Zoom note');
    const [open] = await panelOpenings(page);
    expect(open).toBeDefined();
    expect(open!.duration).toBe(250);
    expect(open!.frames[0]!.opacity).toBe(0);
    expectSamePoint(translatedCentre(open!.rect, open!.frames[0]!.transform!), cardCentre);
    expect(lastFrame(open!).transform).toBe('none');

    await dashboardPage.closeNoteModal();
    const close = await onlyGhostClosing(page);
    expect(close.ariaHidden).toBe('true');
    expect(close.duration).toBe(250);
    const last = lastFrame(close);
    expect(last.opacity).toBe(0);
    expectSamePoint(translatedCentre(close.rect, last.transform!), cardCentre);

    // The snapshot and its backdrop are removed once the close finishes.
    await expect(ghosts(page)).toHaveCount(0);
  });

  test('closes onto the card where it is now, not where it was clicked', async ({ page, dashboardPage, authenticatedUser }) => {
    void authenticatedUser;
    await dashboardPage.createNote('Stays put');
    await dashboardPage.createNote('Gets pinned');
    const card = dashboardPage.noteCardByExactTitle('Gets pinned');
    const clickedCentre = await centreOf(card);
    await recordAnimations(page);

    await dashboardPage.openNote('Gets pinned');
    // Pinning moves the card into the pinned section behind the open modal.
    await dashboardPage.modalToolbarButton('Pin note').click();
    await expect(dashboardPage.modalToolbarButton('Unpin note')).toBeVisible();
    // The card remounts in its new section and the grid animates it there, so
    // wait until it has moved and then held still.
    let currentCentre = clickedCentre;
    await expect.poll(async () => {
      const box = await card.boundingBox();
      if (!box) return false;
      const now = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const moved = Math.hypot(now.x - clickedCentre.x, now.y - clickedCentre.y) > 10;
      const still = now.x === currentCentre.x && now.y === currentCentre.y;
      currentCentre = now;
      return moved && still;
    }).toBe(true);

    await dashboardPage.closeNoteModal();
    const close = await onlyGhostClosing(page);
    expectSamePoint(translatedCentre(close.rect, lastFrame(close).transform!), currentCentre);
  });

  test('closing mid-open shrinks back from where the open had got to', async ({ page, dashboardPage, authenticatedUser }) => {
    void authenticatedUser;
    await dashboardPage.createNote('Quick close');
    await recordAnimations(page);
    // Slow every animation a hundredfold so the close reliably lands mid-open,
    // before the panel has even faded in.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.01 });

    await dashboardPage.noteCardButton('Quick close').focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await panelOpenings(page)).length).toBe(1);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();

    const close = await onlyGhostClosing(page);
    // Starts part-way through the open (scaled down, part-transparent), not
    // from the panel's full size.
    expect(close.frames[0]!.transform).toMatch(/^matrix/);
    expect(close.frames[0]!.opacity).toBeLessThan(1);
  });

  test('a note opened without a card fades in and out in place', async ({ page, dashboardPage, authenticatedUser }) => {
    void authenticatedUser;
    await recordAnimations(page);

    await dashboardPage.clickNewNote();
    await expect(page.locator('[data-note-modal-panel]')).toBeVisible();
    expect(await panelOpenings(page)).toHaveLength(0);

    await dashboardPage.closeNoteModal();
    expect(lastFrame(await onlyGhostClosing(page))).toEqual({ transform: 'scale(0.95)', opacity: 0 });
  });

  test.describe('with reduced motion', () => {
    test.use({ reducedMotion: 'reduce' });

    test('neither zooms nor leaves a snapshot behind', async ({ page, dashboardPage, authenticatedUser }) => {
      void authenticatedUser;
      await dashboardPage.createNote('Still note');
      await recordAnimations(page);

      await dashboardPage.openNote('Still note');
      expect(await panelOpenings(page)).toHaveLength(0);

      await dashboardPage.closeNoteModal();
      await expect(dashboardPage.noteCardByExactTitle('Still note')).toBeVisible();
      expect(await ghostClosings(page)).toHaveLength(0);
      await expect(ghosts(page)).toHaveCount(0);
    });
  });
});
