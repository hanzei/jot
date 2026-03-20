import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import NoteMarkdown from '@/components/NoteMarkdown';

describe('NoteMarkdown', () => {
  it('renders markdown preview elements safely', () => {
    const { container, getByRole, getByText, queryByRole } = render(
      <NoteMarkdown
        variant="preview"
        content={[
          '# Heading',
          '',
          '**Bold** and *italic* text with `inline` code.',
          '',
          '```',
          'const value = 1;',
          '```',
          '',
          '> Quote',
          '',
          '[Example](https://example.com)',
          '',
          '![Secret image](https://example.com/image.png)',
          '',
          '- [x] Done item',
        ].join('\n')}
      />,
    );

    expect(getByRole('heading', { level: 1, name: 'Heading' })).toBeInTheDocument();
    expect(container.querySelector('strong')?.textContent).toBe('Bold');
    expect(container.querySelector('em')?.textContent).toBe('italic');
    expect(container.querySelector('code')?.textContent).toContain('inline');
    expect(container.querySelector('pre code')?.textContent).toContain('const value = 1;');
    expect(container.querySelector('blockquote')?.textContent).toContain('Quote');
    expect(getByRole('link', { name: 'Example' })).toHaveAttribute('href', 'https://example.com');
    expect(queryByRole('img')).not.toBeInTheDocument();
    expect(getByText('[Secret image]')).toBeInTheDocument();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(getByText('Done item')).toBeInTheDocument();
  });

  it('renders card links as styled text instead of anchors', () => {
    const { container, getByText } = render(
      <NoteMarkdown
        variant="card"
        content="# Heading\n\n**Bold** and [Example](https://example.com)"
      />,
    );

    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('strong')?.textContent).toBe('Bold');
    expect(container.textContent).toContain('Heading');
    expect(getByText(/Heading/).closest('p')).toHaveClass('font-black');
    expect(getByText('Example')).toHaveClass('pointer-events-none');
  });
});
