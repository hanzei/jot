export interface TextSelection {
  start: number;
  end: number;
}

export interface FormatResult {
  text: string;
  selection: TextSelection;
}

export type HeadingLevel = 1 | 2 | 3 | 4;

interface LineTransformation {
  text: string;
  oldPrefixLength: number;
  newPrefixLength: number;
}

const LINK_URL_PLACEHOLDER = 'url';
const LIST_PREFIX_PATTERN = /^(\s*)(?:[-*+]\s+|\d+\.\s+)/;
const HEADING_PREFIX_PATTERN = /^(#{1,6})\s+/;

function normalizeSelection(selection: TextSelection): TextSelection {
  return selection.start <= selection.end
    ? selection
    : { start: selection.end, end: selection.start };
}

function wrapSelection(
  text: string,
  selection: TextSelection,
  prefix: string,
  suffix: string = prefix,
): FormatResult {
  const normalized = normalizeSelection(selection);
  const selectedText = text.slice(normalized.start, normalized.end);

  if (!selectedText) {
    const inserted = `${prefix}${suffix}`;
    const cursor = normalized.start + prefix.length;
    return {
      text: `${text.slice(0, normalized.start)}${inserted}${text.slice(normalized.end)}`,
      selection: { start: cursor, end: cursor },
    };
  }

  return {
    text: `${text.slice(0, normalized.start)}${prefix}${selectedText}${suffix}${text.slice(normalized.end)}`,
    selection: {
      start: normalized.start + prefix.length,
      end: normalized.start + prefix.length + selectedText.length,
    },
  };
}

function getLineRange(text: string, selection: TextSelection): { start: number; end: number } {
  const normalized = normalizeSelection(selection);
  const start = text.lastIndexOf('\n', Math.max(normalized.start - 1, 0)) + 1;
  const endProbe = normalized.end > normalized.start ? normalized.end - 1 : normalized.start;
  const nextBreak = text.indexOf('\n', endProbe);

  return {
    start,
    end: nextBreak === -1 ? text.length : nextBreak,
  };
}

function transformSelectedLines(
  text: string,
  selection: TextSelection,
  transformer: (line: string, index: number) => LineTransformation,
): FormatResult {
  const normalized = normalizeSelection(selection);
  const lineRange = getLineRange(text, normalized);
  const block = text.slice(lineRange.start, lineRange.end);
  const lines = block.split('\n');

  let absoluteLineStart = lineRange.start;
  const transformedLines = lines.map((line, index) => {
    const transformed = transformer(line, index);
    const result = {
      ...transformed,
      originalText: line,
      start: absoluteLineStart,
    };
    absoluteLineStart += line.length + 1;
    return result;
  });

  const newBlock = transformedLines.map((line) => line.text).join('\n');

  const remapPosition = (position: number) => {
    let accumulatedDelta = 0;

    for (const line of transformedLines) {
      const lineStart = line.start;
      const lineEnd = line.start + line.originalText.length;
      const lineDelta = line.text.length - line.originalText.length;
      const oldPrefixEnd = line.start + line.oldPrefixLength;

      if (position < lineStart) {
        return position + accumulatedDelta;
      }

      if (position <= lineEnd) {
        if (position <= oldPrefixEnd) {
          return lineStart + accumulatedDelta + line.newPrefixLength;
        }

        return position + accumulatedDelta + (line.newPrefixLength - line.oldPrefixLength);
      }

      accumulatedDelta += lineDelta;
    }

    return position + accumulatedDelta;
  };

  return {
    text: `${text.slice(0, lineRange.start)}${newBlock}${text.slice(lineRange.end)}`,
    selection: {
      start: remapPosition(normalized.start),
      end: remapPosition(normalized.end),
    },
  };
}

export function applyBold(text: string, selection: TextSelection): FormatResult {
  return wrapSelection(text, selection, '**');
}

export function applyItalic(text: string, selection: TextSelection): FormatResult {
  return wrapSelection(text, selection, '*');
}

export function applyStrikethrough(text: string, selection: TextSelection): FormatResult {
  return wrapSelection(text, selection, '~~');
}

export function applyCode(text: string, selection: TextSelection): FormatResult {
  const normalized = normalizeSelection(selection);
  const selectedText = text.slice(normalized.start, normalized.end);

  if (selectedText.includes('\n')) {
    const prefix = '```\n';
    const suffix = '\n```';
    return {
      text: `${text.slice(0, normalized.start)}${prefix}${selectedText}${suffix}${text.slice(normalized.end)}`,
      selection: {
        start: normalized.start + prefix.length,
        end: normalized.start + prefix.length + selectedText.length,
      },
    };
  }

  return wrapSelection(text, normalized, '`');
}

export function applyLink(text: string, selection: TextSelection): FormatResult {
  const normalized = normalizeSelection(selection);
  const selectedText = text.slice(normalized.start, normalized.end);
  const linkText = selectedText;
  const inserted = `[${linkText}](${LINK_URL_PLACEHOLDER})`;
  const textCursor = normalized.start + 1;
  const urlStart = normalized.start + 3 + linkText.length;

  return {
    text: `${text.slice(0, normalized.start)}${inserted}${text.slice(normalized.end)}`,
    selection: selectedText
      ? { start: urlStart, end: urlStart + LINK_URL_PLACEHOLDER.length }
      : { start: textCursor, end: textCursor },
  };
}

export function applyHeading(
  text: string,
  selection: TextSelection,
  level: HeadingLevel,
): FormatResult {
  const prefix = `${'#'.repeat(level)} `;

  return transformSelectedLines(text, selection, (line) => {
    const match = line.match(HEADING_PREFIX_PATTERN);

    if (match) {
      if (match[1].length === level) {
        const oldPrefixLength = match[0].length;
        return {
          text: line.slice(oldPrefixLength),
          oldPrefixLength,
          newPrefixLength: 0,
        };
      }

      const oldPrefixLength = match[0].length;
      return {
        text: `${prefix}${line.slice(oldPrefixLength)}`,
        oldPrefixLength,
        newPrefixLength: prefix.length,
      };
    }

    return {
      text: `${prefix}${line}`,
      oldPrefixLength: 0,
      newPrefixLength: prefix.length,
    };
  });
}

export function applyBulletList(text: string, selection: TextSelection): FormatResult {
  return transformSelectedLines(text, selection, (line) => {
    const match = line.match(LIST_PREFIX_PATTERN);
    const prefix = `${match?.[1] ?? ''}- `;
    const oldPrefixLength = match?.[0].length ?? 0;

    return {
      text: `${prefix}${line.slice(oldPrefixLength)}`,
      oldPrefixLength,
      newPrefixLength: prefix.length,
    };
  });
}

export function applyOrderedList(text: string, selection: TextSelection): FormatResult {
  return transformSelectedLines(text, selection, (line) => {
    const match = line.match(LIST_PREFIX_PATTERN);
    const prefix = `${match?.[1] ?? ''}1. `;
    const oldPrefixLength = match?.[0].length ?? 0;

    return {
      text: `${prefix}${line.slice(oldPrefixLength)}`,
      oldPrefixLength,
      newPrefixLength: prefix.length,
    };
  });
}

export function applyHorizontalRule(text: string, selection: TextSelection): FormatResult {
  const normalized = normalizeSelection(selection);
  const before = text.slice(0, normalized.start);
  const after = text.slice(normalized.end);
  const leadingBreak = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
  const trailingBreak = after.startsWith('\n') ? '' : '\n';
  const inserted = `${leadingBreak}---${trailingBreak}`;
  const cursor = normalized.start + inserted.length;

  return {
    text: `${before}${inserted}${after}`,
    selection: { start: cursor, end: cursor },
  };
}
