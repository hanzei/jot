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

    const { getByText } = render(
      <NoteMarkdown content="Before ![Alt text](https://example.com/image.png) after" />,
    );

    expect(getByText('Alt text')).toBeTruthy();
  });

  it('renders task list syntax as plain list items without checkbox markers', () => {
    expect(prepareMarkdownForRender('- [ ] Draft spec\n- [x] Ship it')).toBe(
      '- Draft spec\n- Ship it',
    );
    expect(prepareMarkdownForRender('- [  ] Keep spacing')).toBe('- Keep spacing');

    const { getByText, queryByText } = render(
      <NoteMarkdown content={'- [ ] Draft spec\n- [x] Ship it'} />,
    );

    expect(getByText('Draft spec')).toBeTruthy();
    expect(getByText('Ship it')).toBeTruthy();
    expect(queryByText(/\[\s?\]/)).toBeNull();
    expect(queryByText(/\[x\]/i)).toBeNull();
  });
});
