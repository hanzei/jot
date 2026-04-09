import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../markdown';

describe('renderMarkdown', () => {
  it('renders bold', () => {
    expect(renderMarkdown('**hello**')).toContain('<strong>hello</strong>');
  });

  it('renders italic', () => {
    expect(renderMarkdown('*hello*')).toContain('<em>hello</em>');
  });

  it('renders h2 heading', () => {
    expect(renderMarkdown('## Title')).toContain('<h2>');
    expect(renderMarkdown('## Title')).toContain('Title');
  });

  it('renders unordered list', () => {
    expect(renderMarkdown('- item')).toContain('<li>');
    expect(renderMarkdown('- item')).toContain('item');
  });

  it('renders blockquote', () => {
    expect(renderMarkdown('> quote')).toContain('<blockquote>');
  });

  it('renders inline code', () => {
    expect(renderMarkdown('`code`')).toContain('<code>code</code>');
  });

  it('renders link with safe attributes', () => {
    const result = renderMarkdown('[text](https://example.com)');
    expect(result).toContain('<a');
    expect(result).toContain('text');
    expect(result).toContain('noopener noreferrer');
  });

  it('strips script tags', () => {
    const result = renderMarkdown('<script>alert(1)</script>');
    expect(result).not.toContain('<script>');
  });

  it('strips onclick attributes', () => {
    const result = renderMarkdown('<a onclick="evil()">link</a>');
    expect(result).not.toContain('onclick');
  });

  it('returns empty string for blank input', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('   ')).toBe('');
  });

  it('plain text passes through safely', () => {
    expect(renderMarkdown('hello world')).toContain('hello world');
  });

  it('strips h1 headings (only h2/h3 allowed)', () => {
    const result = renderMarkdown('# Top heading');
    expect(result).not.toContain('<h1>');
    expect(result).toContain('Top heading'); // text still present
  });
});
