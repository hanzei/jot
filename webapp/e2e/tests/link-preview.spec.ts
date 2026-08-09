import { test, expect } from '../fixtures';

/**
 * What a chat client's preview generator sees.
 *
 * Deliberately fetched over raw HTTP rather than driven through `page`: a
 * preview generator is an unauthenticated bot that reads the served markup and
 * never runs JavaScript, so anything that only appears after the SPA boots is
 * invisible to it. The `request` fixture is that bot.
 */

// Shaped like a real note ID (22 chars) but never created — the SPA fallback
// serves index.html for any unmatched path, which is exactly the point.
const NOTE_PATH = '/notes/e1IZ1FHENdjEMCQVgTeqPJ';

function metaContent(html: string, attr: 'property' | 'name', key: string): string | null {
  const pattern = new RegExp(`<meta\\s+${attr}="${key}"\\s+content="([^"]*)"`, 'i');
  return pattern.exec(html)?.[1] ?? null;
}

test.describe('link preview metadata', () => {
  test('serves branding tags to an unauthenticated preview generator', async ({ request }) => {
    const response = await request.get(NOTE_PATH);
    expect(response.status()).toBe(200);

    const html = await response.text();
    expect(metaContent(html, 'property', 'og:type')).toBe('website');
    expect(metaContent(html, 'property', 'og:site_name')).toBe('Jot');
    expect(metaContent(html, 'property', 'og:title')).toBe('Jot - Your Notes');
    expect(metaContent(html, 'property', 'og:image')).toBe('/pwa-512x512.png');
    expect(metaContent(html, 'name', 'twitter:card')).toBe('summary');

    // Presence, not wording: a card with no description renders as a bare
    // title, but the copy itself is free to change without failing this.
    expect(metaContent(html, 'property', 'og:description')).toBeTruthy();
  });

  test('reveals nothing about the note behind the URL', async ({ request }) => {
    const [noteHtml, loginHtml] = await Promise.all([
      request.get(NOTE_PATH).then((r) => r.text()),
      request.get('/login').then((r) => r.text()),
    ]);

    // Byte-identical, because both are the same static index.html. This is the
    // guard that matters: it fails the moment anyone templates per-note data
    // into the document, which would leak a note's title to anyone holding the
    // link. See the comment block in webapp/index.html.
    expect(noteHtml).toBe(loginHtml);
  });
});
