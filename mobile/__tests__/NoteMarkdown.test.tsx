import React from 'react';
import { render } from '@testing-library/react-native';
import NoteMarkdown, { prepareMarkdownForRender } from '@/components/NoteMarkdown';

describe('NoteMarkdown', () => {
  it('suppresses markdown images while preserving alt text', () => {
    expect(prepareMarkdownForRender('Before ![Alt text](https://example.com/image.png) after')).toBe(
      'Before Alt text after',
    );
    expect(
      prepareMarkdownForRender('![Diagram](https://en.wikipedia.org/wiki/Function_(mathematics))'),
    ).toBe('Diagram');
    expect(
      prepareMarkdownForRender('![Nested](https://example.com/a_(b_(c)).png)'),
    ).toBe('Nested');
    expect(
      prepareMarkdownForRender('`![literal](https://example.com/image.png)`'),
    ).toBe('`![literal](https://example.com/image.png)`');
    expect(
      prepareMarkdownForRender('```\n![literal](https://example.com/image.png)\n```'),
    ).toBe('```\n![literal](https://example.com/image.png)\n```');

    const { getByText } = render(
      <NoteMarkdown content="Before ![Alt text](https://example.com/image.png) after" />,
    );

    expect(getByText('Before Alt text after')).toBeTruthy();
  });

  it('renders task list syntax as plain list items without checkbox markers', () => {
    expect(prepareMarkdownForRender('- [ ] Draft spec\n- [x] Ship it')).toBe(
      '- Draft spec\n- Ship it',
    );
    expect(prepareMarkdownForRender('- [  ] Keep spacing')).toBe('- Keep spacing');
    expect(prepareMarkdownForRender('- [ ]item')).toBe('- item');
    expect(prepareMarkdownForRender('- [ ]')).toBe('- ');
    expect(prepareMarkdownForRender('> - [ ] quoted task')).toBe('> - quoted task');
    expect(prepareMarkdownForRender('```\n- [ ] keep literal\n```')).toBe('```\n- [ ] keep literal\n```');
    expect(prepareMarkdownForRender('> ```\n> - [ ] keep literal\n> ```')).toBe(
      '> ```\n> - [ ] keep literal\n> ```',
    );
    expect(prepareMarkdownForRender('    ```\n    - [ ] keep literal\n    ```')).toBe(
      '    ```\n    - [ ] keep literal\n    ```',
    );

    const { getByText, queryByText } = render(
      <NoteMarkdown content={'- [ ] Draft spec\n- [x] Ship it'} />,
    );

    expect(getByText('Draft spec')).toBeTruthy();
    expect(getByText('Ship it')).toBeTruthy();
    expect(queryByText(/\[[xX ]+\]/)).toBeNull();
  });
});
