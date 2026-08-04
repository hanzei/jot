import { describe, it, expect } from 'vitest';
import { MARKDOWN_CASES } from '@jot/shared';
import { renderMarkdown } from '../markdown';

/** The words a reader sees, with the markup removed. */
function text(html: string): string {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el.textContent ?? '';
}

function render(id: string): string {
  const testCase = MARKDOWN_CASES.find((c) => c.id === id);
  if (!testCase) throw new Error(`unknown markdown case: ${id}`);
  return renderMarkdown(testCase.markdown);
}

// One assertion per case in the shared conformance corpus (shared/src/
// markdownCases.ts). The mobile suite runs the same corpus through its own
// React Native renderer over the same marked tokens; the coverage test below is
// what keeps the two from drifting apart.
const conformance: Record<string, () => void> = {
  bold: () => expect(render('bold')).toContain('<strong>hello</strong>'),
  italic: () => expect(render('italic')).toContain('<em>hello</em>'),
  strikethrough: () => expect(render('strikethrough')).toContain('<del>hello</del>'),

  'heading-1': () => expect(render('heading-1')).toContain('<h1>Top heading</h1>'),
  'heading-3': () => expect(render('heading-3')).toContain('<h3>Third heading</h3>'),
  // Rendered as real heading elements; index.css styles h4-h6 as bold body text.
  'heading-4-bold': () => expect(render('heading-4-bold')).toContain('<h4>Fourth heading</h4>'),
  'heading-6-bold': () => expect(render('heading-6-bold')).toContain('<h6>Sixth heading</h6>'),

  'inline-code': () => expect(render('inline-code')).toContain('<code>code</code>'),
  'fenced-code': () => {
    const html = render('fenced-code');
    expect(html).toContain('<pre><code>');
    expect(html).toContain('const a = 1;');
  },
  'indented-code': () => {
    const html = render('indented-code');
    expect(html).toContain('<pre><code>');
    expect(html).toContain('indented code');
  },
  'task-marker-in-code': () => {
    const html = render('task-marker-in-code');
    expect(html).toContain('<pre><code>');
    expect(html).toContain('- [x] not a checkbox');
    expect(html).not.toContain('☑');
  },

  'bullet-list': () => expect(render('bullet-list')).toContain('<li>item</li>'),
  'ordered-list': () => {
    const html = render('ordered-list');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>item</li>');
  },
  'task-unchecked': () => expect(render('task-unchecked')).toContain('<li>☐ todo</li>'),
  'task-checked': () => expect(render('task-checked')).toContain('<li>☑ done</li>'),
  'task-checked-uppercase': () =>
    expect(render('task-checked-uppercase')).toContain('<li>☑ done</li>'),
  'task-marker-outside-list': () => {
    const html = render('task-marker-outside-list');
    expect(html).toContain('[x] not a task');
    expect(html).not.toContain('☑');
  },

  blockquote: () => expect(render('blockquote')).toContain('<blockquote>'),
  'hr-dashes': () => expect(render('hr-dashes')).toContain('<hr>'),
  'hr-stars': () => expect(render('hr-stars')).toContain('<hr>'),

  'inline-link': () => {
    const html = render('inline-link');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  },
  'bare-url': () => expect(render('bare-url')).toContain('href="https://example.com"'),
  'bare-url-www': () => expect(render('bare-url-www')).toContain('href="http://www.example.com"'),
  'bare-domain': () => {
    const html = render('bare-domain');
    expect(html).toContain('visit example.com now');
    expect(html).not.toContain('<a');
  },
  'mailto-link': () => expect(render('mailto-link')).toContain('href="mailto:a@b.com"'),
  'tel-link': () => {
    const html = render('tel-link');
    expect(html).toContain('call');
    expect(html).not.toContain('<a');
    expect(html).not.toContain('tel:');
  },
  'javascript-link': () => {
    const html = render('javascript-link');
    expect(html).toContain('click');
    expect(html).not.toContain('<a');
    expect(html).not.toContain('javascript:');
  },
  'relative-link': () => {
    const html = render('relative-link');
    expect(html).toContain('rel');
    expect(html).not.toContain('<a');
  },

  image: () => {
    const html = render('image');
    expect(html).toContain('![alt text](https://example.com/y.png)');
    expect(html).not.toContain('<img');
  },
  'image-with-title': () => {
    const html = render('image-with-title');
    expect(html).toContain('![alt](https://example.com/y.png "the title")');
    expect(html).not.toContain('<img');
  },
  'image-empty-alt': () => {
    const html = render('image-empty-alt');
    expect(html).toContain('![](https://example.com/y.png)');
    expect(html).not.toContain('<img');
    // An empty alt is where a renderer that half-degrades an image leaves an
    // invisible clickable link. Both clients assert there is nothing to click.
    expect(html).not.toContain('<a');
  },
  'image-inline-in-paragraph': () =>
    expect(render('image-inline-in-paragraph')).toContain(
      '<p>see ![a](https://example.com/y.png) here</p>',
    ),

  table: () => {
    const html = render('table');
    expect(html).toContain('a | b<br>--- | ---<br>1 | 2');
    expect(html).not.toContain('<table');
  },
  'table-cell-url': () => {
    const html = render('table-cell-url');
    expect(html).toContain('a | b<br>--- | ---<br>https://example.com | 2');
    expect(html).not.toContain('<a');
  },

  'typography-dashes': () => expect(render('typography-dashes')).toContain('a -- b'),
  'typography-quotes': () => {
    const html = render('typography-quotes');
    expect(html).toContain('say "hi"');
    expect(html).not.toContain('“');
  },

  'soft-break': () => expect(render('soft-break')).toContain('first<br>second'),
  'raw-html': () => {
    const html = render('raw-html');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt; text');
    expect(html).not.toContain('<b>');
  },
  'raw-html-attribute-url': () => {
    const html = render('raw-html-attribute-url');
    expect(html).toContain('&lt;a href="https://example.com"&gt;x&lt;/a&gt;');
    expect(html).not.toContain('<a');
  },
  'raw-html-block-swallows-markdown': () => {
    const html = render('raw-html-block-swallows-markdown');
    expect(html).toContain('&lt;div&gt;<br>**bold**<br>&lt;/div&gt;');
    expect(html).not.toContain('<strong>');
  },
  'raw-html-script': () => {
    const html = render('raw-html-script');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script');
  },
};

describe('renderMarkdown', () => {
  it('has an expectation for every shared conformance case', () => {
    const missing = MARKDOWN_CASES.filter((c) => !(c.id in conformance)).map((c) => c.id);
    expect(missing).toEqual([]);
    const stale = Object.keys(conformance).filter(
      (id) => !MARKDOWN_CASES.some((c) => c.id === id),
    );
    expect(stale).toEqual([]);
  });

  for (const testCase of MARKDOWN_CASES) {
    it(`${testCase.id}: ${testCase.expected}`, () => {
      conformance[testCase.id]();
    });
  }

  it('keeps already percent-encoded hrefs intact instead of double-encoding them', () => {
    const result = renderMarkdown('[café](https://en.wikipedia.org/wiki/Caf%C3%A9)');
    expect(result).toContain('href="https://en.wikipedia.org/wiki/Caf%C3%A9"');
    expect(result).not.toContain('%25C3');
  });

  it('renders the link text without an anchor when the href cannot be encoded', () => {
    // A lone surrogate makes encodeURI throw; the renderer falls back to text.
    const result = renderMarkdown('[broken](https://example.com/\uD800)');
    expect(result).toContain('broken');
    expect(result).not.toContain('<a');
  });

  it('shows an HTML event handler as inert text rather than an element', () => {
    const result = renderMarkdown('<a onclick="evil()">link</a>');
    expect(result).toContain('&lt;a onclick=');
    expect(result).not.toContain('<a');
  });

  it('returns empty string for blank input', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('   ')).toBe('');
  });

  it('plain text passes through safely', () => {
    expect(renderMarkdown('hello world')).toContain('hello world');
  });

  // Note cards render links as text: the card is one control that opens the
  // note, and an anchor inside it would follow the link *and* open the note,
  // since both handlers fire. docs/specs/markdown-rendering.md §1.1.
  describe('links: false', () => {
    const cardCases = ['inline-link', 'bare-url', 'bare-url-www', 'mailto-link'];

    it('keeps the label and drops the anchor for every kind of link', () => {
      for (const id of cardCases) {
        const source = MARKDOWN_CASES.find((c) => c.id === id)!.markdown;
        const withLinks = renderMarkdown(source);
        const asText = renderMarkdown(source, { links: false });

        expect(withLinks, id).toContain('<a href=');
        expect(asText, id).not.toContain('<a');
        // The text survives the tag being stripped — this is "formatting
        // dropped, text kept", not "removed entirely".
        expect(text(asText), id).toBe(text(withLinks));
      }
    });

    it('leaves every other construct alone', () => {
      const html = renderMarkdown('# h\n\n**b** *i* `c`\n\n- one', { links: false });
      expect(html).toContain('<h1>h</h1>');
      expect(html).toContain('<strong>b</strong>');
      expect(html).toContain('<em>i</em>');
      expect(html).toContain('<code>c</code>');
      expect(html).toContain('<li>one</li>');
    });
  });
});
