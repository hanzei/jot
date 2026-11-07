import { scrollOffsetToReveal } from '../src/screens/noteEditor/revealInScrollView';

const base = { scrollOffset: 300, viewportTop: 100, viewportHeight: 400, targetHeight: 40, margin: 20 };

describe('scrollOffsetToReveal', () => {
  it('returns null for a target already inside the visible band', () => {
    expect(scrollOffsetToReveal({ ...base, targetTop: 200 })).toBeNull();
    // Exactly on the band's edges still counts as visible.
    expect(scrollOffsetToReveal({ ...base, targetTop: 120 })).toBeNull();
    expect(scrollOffsetToReveal({ ...base, targetTop: 440 })).toBeNull();
  });

  it('scrolls down by the distance the target overhangs the bottom of the band', () => {
    // Band bottom is 100 + 400 - 20 = 480; target bottom is 530.
    expect(scrollOffsetToReveal({ ...base, targetTop: 490 })).toBe(350);
  });

  it('scrolls up by the distance the target overhangs the top of the band', () => {
    // Band top is 120; target top is 60.
    expect(scrollOffsetToReveal({ ...base, targetTop: 60 })).toBe(240);
  });

  it('never returns a negative offset', () => {
    expect(scrollOffsetToReveal({ ...base, scrollOffset: 10, targetTop: 0 })).toBe(0);
  });

  it('aligns the top of a target taller than the viewport that starts below its top', () => {
    expect(scrollOffsetToReveal({ ...base, targetTop: 300, targetHeight: 600 })).toBe(300 + (300 - 100));
  });

  it('leaves a target taller than the viewport alone once it fills it', () => {
    // Top above the viewport, bottom below it: the caret could be anywhere in
    // it, so realigning its top on every wrap would scroll the caret away.
    expect(scrollOffsetToReveal({ ...base, targetTop: 50, targetHeight: 600 })).toBeNull();
  });

  it('aligns the bottom of a target taller than the viewport whose bottom is showing', () => {
    // Bottom at 400, inside the viewport (which ends at 500): the visible end of
    // the text — where it was tapped — stays on screen.
    expect(scrollOffsetToReveal({ ...base, targetTop: -200, targetHeight: 600 })).toBe(300 - 100);
  });

  it('skips a target entirely off screen only when asked to', () => {
    expect(scrollOffsetToReveal({ ...base, targetTop: 600, onlyIfShown: true })).toBeNull();
    expect(scrollOffsetToReveal({ ...base, targetTop: 20, onlyIfShown: true })).toBeNull();
    // Partly on screen still reveals.
    expect(scrollOffsetToReveal({ ...base, targetTop: 480, onlyIfShown: true })).toBe(340);
    expect(scrollOffsetToReveal({ ...base, targetTop: 600 })).toBe(460);
  });

  it('checks only the first given points of the viewport when passed a height', () => {
    // The viewport is 200 tall now and was 250 before it shrank: a target at
    // 400 was off screen then, one at 300 was on it (and is now covered).
    expect(scrollOffsetToReveal({ ...base, viewportHeight: 200, targetTop: 400, onlyIfShown: 250 })).toBeNull();
    expect(scrollOffsetToReveal({ ...base, viewportHeight: 200, targetTop: 300, onlyIfShown: 250 })).toBe(300 + (340 - 280));
  });

  it('shrinks the margin when the viewport is too short for it', () => {
    // Viewport 50 tall, target 40: only 5 of margin fits on each side.
    expect(scrollOffsetToReveal({ ...base, viewportHeight: 50, targetTop: 105 })).toBeNull();
    expect(scrollOffsetToReveal({ ...base, viewportHeight: 50, targetTop: 115 })).toBe(310);
  });

  it('returns null before either view has been laid out', () => {
    expect(scrollOffsetToReveal({ ...base, viewportHeight: 0, targetTop: 900 })).toBeNull();
    expect(scrollOffsetToReveal({ ...base, targetHeight: 0, targetTop: 900 })).toBeNull();
  });
});
