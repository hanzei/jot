import { describe, it, expect } from 'vitest';
import { formatLiteralImage, isAllowedLinkHref } from '../markdown';

describe('isAllowedLinkHref', () => {
  it('allows the web and mail schemes', () => {
    expect(isAllowedLinkHref('https://example.com')).toBe(true);
    expect(isAllowedLinkHref('http://example.com')).toBe(true);
    expect(isAllowedLinkHref('mailto:a@b.com')).toBe(true);
  });

  it('ignores scheme casing', () => {
    expect(isAllowedLinkHref('HTTPS://example.com')).toBe(true);
    expect(isAllowedLinkHref('MailTo:a@b.com')).toBe(true);
  });

  it('rejects app deep links and script schemes', () => {
    expect(isAllowedLinkHref('tel:+15550100')).toBe(false);
    expect(isAllowedLinkHref('sms:+15550100')).toBe(false);
    expect(isAllowedLinkHref('jot://notes/abc')).toBe(false);
    expect(isAllowedLinkHref('javascript:alert(1)')).toBe(false);
    expect(isAllowedLinkHref('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects leading whitespace and control characters used to hide a scheme', () => {
    expect(isAllowedLinkHref(' javascript:alert(1)')).toBe(false);
    expect(isAllowedLinkHref('\njavascript:alert(1)')).toBe(false);
  });

  it('rejects targets with no scheme at all', () => {
    expect(isAllowedLinkHref('/dashboard')).toBe(false);
    expect(isAllowedLinkHref('example.com')).toBe(false);
    expect(isAllowedLinkHref('//example.com')).toBe(false);
    expect(isAllowedLinkHref('#anchor')).toBe(false);
    expect(isAllowedLinkHref('')).toBe(false);
  });
});

describe('formatLiteralImage', () => {
  it('reconstructs the source both clients show in place of an image', () => {
    expect(formatLiteralImage('alt', 'https://x/y.png')).toBe('![alt](https://x/y.png)');
  });

  it('includes the title when there is one', () => {
    expect(formatLiteralImage('alt', 'https://x/y.png', 'the title')).toBe(
      '![alt](https://x/y.png "the title")',
    );
  });

  it('keeps the brackets when the alt text is empty', () => {
    expect(formatLiteralImage('', 'https://x/y.png')).toBe('![](https://x/y.png)');
  });

  it('treats a missing and an empty title the same', () => {
    expect(formatLiteralImage('a', 'b', null)).toBe('![a](b)');
    expect(formatLiteralImage('a', 'b', '')).toBe('![a](b)');
  });
});
