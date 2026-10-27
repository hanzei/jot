// Line diff for the note history panel's "Compared to current" view of a text
// note. Pure, so it is tested on its own.

export type DiffLineKind = 'same' | 'removed' | 'added';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

// Above this many cells the LCS table is skipped and the changed middle is
// shown as a block removal plus a block addition. Note content is capped
// server-side, so this only guards against a pathological all-lines-changed
// comparison of two very long notes.
const MAX_LCS_CELLS = 4_000_000;

/**
 * Diffs `before` against `after` line by line: `removed` lines appear only in
 * `before`, `added` lines only in `after`. Lines common to both ends are
 * trimmed first, then the middle is aligned on its longest common subsequence.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const same = (lines: string[]): DiffLine[] => lines.map(text => ({ kind: 'same', text }));
  return [
    ...same(a.slice(0, start)),
    ...diffMiddle(a.slice(start, endA), b.slice(start, endB)),
    ...same(a.slice(endA)),
  ];
}

function diffMiddle(a: string[], b: string[]): DiffLine[] {
  const removed = (text: string): DiffLine => ({ kind: 'removed', text });
  const added = (text: string): DiffLine => ({ kind: 'added', text });
  if (a.length === 0 || b.length === 0 || a.length * b.length > MAX_LCS_CELLS) {
    return [...a.map(removed), ...b.map(added)];
  }

  // lcs[i][j] is the LCS length of a[i:] and b[j:], built from the end so the
  // walk below can go forward.
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j]
        ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
        : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lineA = a[i] ?? '';
    const lineB = b[j] ?? '';
    if (lineA === lineB) {
      out.push({ kind: 'same', text: lineA });
      i++;
      j++;
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
      out.push(removed(lineA));
      i++;
    } else {
      out.push(added(lineB));
      j++;
    }
  }
  for (; i < a.length; i++) out.push(removed(a[i] ?? ''));
  for (; j < b.length; j++) out.push(added(b[j] ?? ''));
  return out;
}
