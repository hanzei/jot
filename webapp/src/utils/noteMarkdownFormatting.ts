export interface SelectionRange {
  start: number;
  end: number;
}

export interface FormattingResult {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

const clampSelection = (value: string, selection: SelectionRange): SelectionRange => {
  const start = Math.max(0, Math.min(selection.start, value.length));
  const end = Math.max(start, Math.min(selection.end, value.length));

  return { start, end };
};

const wrapSelection = (
  value: string,
  selection: SelectionRange,
  prefix: string,
  suffix = prefix,
): FormattingResult => {
  const { start, end } = clampSelection(value, selection);
  const before = value.slice(0, start);
  const selectedText = value.slice(start, end);
  const after = value.slice(end);

  if (start === end) {
    const insertion = `${prefix}${suffix}`;
    return {
      value: `${before}${insertion}${after}`,
      selectionStart: start + prefix.length,
      selectionEnd: start + prefix.length,
    };
  }

  const insertion = `${prefix}${selectedText}${suffix}`;
  const cursorPosition = start + insertion.length;

  return {
    value: `${before}${insertion}${after}`,
    selectionStart: cursorPosition,
    selectionEnd: cursorPosition,
  };
};

const getLineBounds = (value: string, selection: SelectionRange) => {
  const { start, end } = clampSelection(value, selection);
  const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const searchIndex = Math.max(start, end - 1);
  const lineEndIndex = value.indexOf('\n', searchIndex);
  const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;

  return { start, end, lineStart, lineEnd };
};

const transformSelectedLines = (
  value: string,
  selection: SelectionRange,
  transformLine: (line: string, index: number) => string,
): FormattingResult => {
  const { start, end, lineStart, lineEnd } = getLineBounds(value, selection);
  const before = value.slice(0, lineStart);
  const target = value.slice(lineStart, lineEnd);
  const after = value.slice(lineEnd);
  const lines = target.split('\n');
  const updatedLines = lines.map(transformLine);
  const updatedTarget = updatedLines.join('\n');

  if (start === end && lines.length === 1) {
    const delta = updatedLines[0].length - lines[0].length;
    const cursorPosition = Math.max(lineStart, start + delta);

    return {
      value: `${before}${updatedTarget}${after}`,
      selectionStart: cursorPosition,
      selectionEnd: cursorPosition,
    };
  }

  return {
    value: `${before}${updatedTarget}${after}`,
    selectionStart: lineStart,
    selectionEnd: lineStart + updatedTarget.length,
  };
};

const orderedListPattern = /^\d+\.\s/;

export const applyBold = (value: string, selection: SelectionRange): FormattingResult =>
  wrapSelection(value, selection, '**');

export const applyItalic = (value: string, selection: SelectionRange): FormattingResult =>
  wrapSelection(value, selection, '*');

export const applyStrikethrough = (value: string, selection: SelectionRange): FormattingResult =>
  wrapSelection(value, selection, '~~');

export const applyCode = (value: string, selection: SelectionRange): FormattingResult => {
  const { start, end } = clampSelection(value, selection);
  const selectedText = value.slice(start, end);

  if (start !== end && selectedText.includes('\n')) {
    const before = value.slice(0, start);
    const after = value.slice(end);
    const insertion = `\`\`\`\n${selectedText}\n\`\`\``;
    const cursorPosition = before.length + insertion.length;

    return {
      value: `${before}${insertion}${after}`,
      selectionStart: cursorPosition,
      selectionEnd: cursorPosition,
    };
  }

  return wrapSelection(value, selection, '`');
};

export const applyLink = (value: string, selection: SelectionRange): FormattingResult => {
  const { start, end } = clampSelection(value, selection);
  const before = value.slice(0, start);
  const selectedText = value.slice(start, end);
  const after = value.slice(end);
  const insertion = `[${selectedText}](url)`;
  const urlStart = before.length + selectedText.length + 3;

  return {
    value: `${before}${insertion}${after}`,
    selectionStart: urlStart,
    selectionEnd: urlStart + 3,
  };
};

export const applyHeading = (
  value: string,
  selection: SelectionRange,
  level: 1 | 2 | 3 | 4,
): FormattingResult => {
  const prefix = `${'#'.repeat(level)} `;

  return transformSelectedLines(value, selection, (line) => {
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length);
    }

    if (/^#{1,4}\s/.test(line)) {
      return line.replace(/^#{1,4}\s/, prefix);
    }

    return `${prefix}${line}`;
  });
};

export const applyBulletList = (value: string, selection: SelectionRange): FormattingResult =>
  transformSelectedLines(value, selection, (line) => (line.startsWith('- ') ? line : `- ${line}`));

export const applyOrderedList = (value: string, selection: SelectionRange): FormattingResult =>
  transformSelectedLines(value, selection, (line) => (orderedListPattern.test(line) ? line : `1. ${line}`));

export const insertHorizontalRule = (value: string, selection: SelectionRange): FormattingResult => {
  const { start } = clampSelection(value, selection);
  const before = value.slice(0, start);
  const after = value.slice(start);
  const prefix = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
  const suffix = after.length > 0 && !after.startsWith('\n') ? '\n' : '';
  const insertion = `${prefix}---${suffix}`;
  const cursorPosition = before.length + prefix.length + 3;

  return {
    value: `${before}${insertion}${after}`,
    selectionStart: cursorPosition,
    selectionEnd: cursorPosition,
  };
};
