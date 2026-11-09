import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { test, expect } from '../fixtures';
import { createListNote, createTextNote, revokePublicLink, setPublicLink, signUp } from '../fixtures/publicLinks';

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const noteImageFile = {
  name: 'test-icon.png',
  mimeType: 'image/png',
  buffer: fs.readFileSync(path.join(__dirname, '../fixtures/test-icon.png')),
};

function titleText(html: string): string | null {
  return /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? null;
}

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

/** Width and height from a baseline or progressive JPEG's SOF segment. */
function jpegSize(bytes: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset < bytes.length) {
    const marker = bytes.readUInt16BE(offset);
    if (marker === 0xffc0 || marker === 0xffc2) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  throw new Error('no SOF segment');
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

  // #1209: an active public link is the one page whose card is note-specific.
  // `page.request` is the note's owner; the `request` fixture stays signed out
  // and plays the preview bot.
  test('previews a public link with its title and first image, never its text', async ({ page, request, publicNotePage }) => {
    await signUp(page.request, 'preview');
    const noteId = await createListNote(page.request, 'Weekend trip', [{ text: 'Passport hidden item' }]);
    const upload = await page.request.post(`/api/v1/notes/${noteId}/images`, { multipart: { file: noteImageFile } });
    expect(upload.ok()).toBeTruthy();
    const imageId = ((await upload.json()) as { id: string }).id;
    const token = await setPublicLink(page.request, noteId);

    const [shareResponse, loginResponse] = await Promise.all([request.get(`/share/${token}`), request.get('/login')]);
    expect(shareResponse.status()).toBe(200);
    const html = await shareResponse.text();
    const loginHtml = await loginResponse.text();

    expect(titleText(html)).toBe('Weekend trip');
    expect(metaContent(html, 'property', 'og:title')).toBe('Weekend trip');
    expect(metaContent(html, 'property', 'og:url')).toMatch(new RegExp(`/share/${token}$`));
    expect(html).not.toContain('Passport hidden item');
    // The description stays the generic one.
    expect(metaContent(html, 'property', 'og:description')).toBe(metaContent(loginHtml, 'property', 'og:description'));
    expect(metaContent(html, 'name', 'description')).toBe(metaContent(loginHtml, 'name', 'description'));

    const imageUrl = metaContent(html, 'property', 'og:image');
    expect(imageUrl).toMatch(new RegExp(`/api/v1/public/notes/${token}/images/${imageId}/thumbnail$`));
    expect(metaContent(html, 'property', 'og:image:type')).toBe('image/jpeg');
    expect(metaContent(html, 'property', 'og:image:alt')).toBe('Weekend trip');

    // The bot fetches the image signed out, and its declared size matches.
    const imageResponse = await request.get(imageUrl!);
    expect(imageResponse.status()).toBe(200);
    expect(imageResponse.headers()['content-type']).toBe('image/jpeg');
    const { width, height } = jpegSize(await imageResponse.body());
    expect(metaContent(html, 'property', 'og:image:width')).toBe(String(width));
    expect(metaContent(html, 'property', 'og:image:height')).toBe(String(height));

    // The page still boots the viewer.
    await publicNotePage.goto(token);
    await expect(publicNotePage.heading()).toHaveText('Weekend trip');
  });

  test('previews a public text note with a fallback title and the app icon', async ({ page, request }) => {
    await signUp(page.request, 'preview');
    const noteId = await createTextNote(page.request, 'Text that must stay out of the card');
    const token = await setPublicLink(page.request, noteId);

    const html = await (await request.get(`/share/${token}`)).text();
    expect(titleText(html)).toBe('Shared note');
    expect(metaContent(html, 'property', 'og:title')).toBe('Shared note');
    expect(metaContent(html, 'property', 'og:image')).toBe(IMAGE_PATH);
    expect(html).not.toContain('Text that must stay out of the card');
  });

  test('gives a revoked link the generic card', async ({ page, request }) => {
    await signUp(page.request, 'preview');
    const noteId = await createListNote(page.request, 'Revoked title', []);
    const token = await setPublicLink(page.request, noteId);
    await revokePublicLink(page.request, noteId);

    const [shareResponse, loginResponse] = await Promise.all([request.get(`/share/${token}`), request.get('/login')]);
    expect(await shareResponse.text()).toBe(await loginResponse.text());
  });
});
