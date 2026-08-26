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
const IMAGE_PATH = '/pwa-512x512.png';

function metaContent(html: string, attr: 'property' | 'name', key: string): string | null {
  const pattern = new RegExp(`<meta\\s+${attr}="${key}"\\s+content="([^"]*)"`, 'i');
  return pattern.exec(html)?.[1] ?? null;
}

/**
 * Width and height as the image itself declares them, read from the IHDR chunk
 * — always the first chunk, at a fixed offset after the 8-byte signature.
 */
function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test.describe('link preview metadata', () => {
  test('serves branding tags to an unauthenticated preview generator', async ({ request }) => {
    const response = await request.get(NOTE_PATH);
    expect(response.status()).toBe(200);

    const html = await response.text();
    expect(metaContent(html, 'property', 'og:type')).toBe('website');
    expect(metaContent(html, 'property', 'og:site_name')).toBe('Jot');
    expect(metaContent(html, 'property', 'og:title')).toBe('Jot - Your Notes');
    expect(metaContent(html, 'property', 'og:image')).toBe(IMAGE_PATH);
    expect(metaContent(html, 'name', 'twitter:card')).toBe('summary');

    // Presence, not wording: a card with no description renders as a bare
    // title, but the copy itself is free to change without failing this.
    expect(metaContent(html, 'property', 'og:description')).toBeTruthy();

    expect(metaContent(html, 'property', 'og:image:type')).toBe('image/png');
    expect(metaContent(html, 'property', 'og:image:alt')).toBeTruthy();

    // Declared dimensions let a client lay the card out before it has the
    // bytes, so they are checked against the asset the tags actually point at
    // rather than against a literal. Comparing to a hardcoded 512 would keep
    // passing if the PNG were swapped for another size, leaving the metadata
    // lying about an image this suite never fetched.
    const imageResponse = await request.get(IMAGE_PATH);
    expect(imageResponse.status()).toBe(200);

    const { width, height } = pngSize(await imageResponse.body());
    expect({ width, height }).toEqual({ width: 512, height: 512 });
    expect(metaContent(html, 'property', 'og:image:width')).toBe(String(width));
    expect(metaContent(html, 'property', 'og:image:height')).toBe(String(height));
  });

  test('asks search engines not to index the instance', async ({ request }) => {
    const response = await request.get(NOTE_PATH);
    expect(response.status()).toBe(200);

    const robots = metaContent(await response.text(), 'name', 'robots');
    expect(robots).toContain('noindex');
    expect(robots).toContain('nofollow');
  });

  test('robots.txt does not disallow the paths preview bots fetch', async ({ request }) => {
    const response = await request.get('/robots.txt');
    expect(response.status()).toBe(200);

    // The trap this guards: Slackbot and Discordbot honour robots.txt, so a
    // blanket `Disallow: /` would silently switch off every preview above.
    // De-indexing is the noindex meta's job precisely so this can stay open.
    const body = await response.text();
    expect(body).not.toMatch(/^\s*Disallow:\s*\/\s*$/m);

    // The other half of the policy: /api/ is not content to index, and stays
    // shut whatever happens to the rule above.
    expect(body).toMatch(/^\s*Disallow:\s*\/api\/\s*$/m);
  });

  test('reveals nothing about the note behind the URL', async ({ request }) => {
    const [noteResponse, loginResponse] = await Promise.all([
      request.get(NOTE_PATH),
      request.get('/login'),
    ]);
    expect(noteResponse.status()).toBe(200);
    expect(loginResponse.status()).toBe(200);

    const [noteHtml, loginHtml] = await Promise.all([
      noteResponse.text(),
      loginResponse.text(),
    ]);

    // Byte-identical, because both are the same static index.html. This is the
    // guard that matters: it fails the moment anyone templates per-note data
    // into the document, which would leak a note's title to anyone holding the
    // link. See the comment block in webapp/index.html.
    expect(noteHtml).toBe(loginHtml);
  });
});
