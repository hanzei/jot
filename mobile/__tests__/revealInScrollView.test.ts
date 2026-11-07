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

  it('aligns the top of a target taller than the viewport', () => {
    expect(scrollOffsetToReveal({ ...base, targetTop: 300, targetHeight: 600 })).toBe(300 + (300 - 100));
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
