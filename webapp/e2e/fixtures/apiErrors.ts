import type { Page } from '@playwright/test';

interface FailedResponse {
  status: number;
  code: string;
  message: string;
  requestId: string;
}

/**
 * Answers every `method` request matching `url` with an API error envelope and
 * an `X-Request-Id` header, and lets other methods through to the server.
 */
export async function failRequests(page: Page, url: string, method: string, { status, code, message, requestId }: FailedResponse) {
  await page.route(url, async (route) => {
    if (route.request().method() !== method) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status,
      headers: { 'X-Request-Id': requestId },
      contentType: 'application/json',
      body: JSON.stringify({ error: { code, message } }),
    });
  });
}
