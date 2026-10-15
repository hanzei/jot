import { describe, expect, it } from 'vitest';

import { canCreateLabelFromQuery, filterLabelsByQuery } from '../labelSearch';

const labels = [{ name: 'Work' }, { name: 'Homework' }, { name: 'Errands' }];

describe('filterLabelsByQuery', () => {
  it('returns every label for a blank query', () => {
    expect(filterLabelsByQuery(labels, '')).toEqual(labels);
    expect(filterLabelsByQuery(labels, '   ')).toEqual(labels);
  });

  it('matches a case-insensitive substring of the trimmed query', () => {
    expect(filterLabelsByQuery(labels, ' WORK ')).toEqual([{ name: 'Work' }, { name: 'Homework' }]);
    expect(filterLabelsByQuery(labels, 'rand')).toEqual([{ name: 'Errands' }]);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterLabelsByQuery(labels, 'xyz')).toEqual([]);
  });
});

describe('canCreateLabelFromQuery', () => {
  it('is false for a blank query', () => {
    expect(canCreateLabelFromQuery(labels, '')).toBe(false);
    expect(canCreateLabelFromQuery(labels, '  ')).toBe(false);
  });

  it('is false when a label has the exact name, ignoring case and surrounding space', () => {
    expect(canCreateLabelFromQuery(labels, 'work')).toBe(false);
    expect(canCreateLabelFromQuery(labels, ' Errands ')).toBe(false);
  });

  it('is true for a partial match or a new name', () => {
    expect(canCreateLabelFromQuery(labels, 'Wor')).toBe(true);
    expect(canCreateLabelFromQuery(labels, 'Garden')).toBe(true);
  });
});
