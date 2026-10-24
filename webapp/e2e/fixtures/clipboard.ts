import type { Page } from '@playwright/test';

/** The clipboard's text. The test must first grant `clipboard-read`. */
export function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}
