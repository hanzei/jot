import { afterEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { formatDate } from '../formatDate';

describe('formatDate', () => {
  const evening = new Date(2026, 10, 10, 21, 34);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('formats in the app language, not the browser language', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
    await i18n.changeLanguage('de');
    expect(formatDate(evening, 'dateTime')).toBe('10. Nov. 2026, 21:34');
  });
});
