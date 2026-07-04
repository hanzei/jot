import {
  QUICK_ACTION_NEW_NOTE,
  QUICK_ACTION_NEW_LIST,
  buildQuickActionItems,
  noteTypeForQuickAction,
} from '../src/utils/quickActions';
import {
  getPendingQuickAction,
  setPendingQuickAction,
  subscribePendingQuickAction,
} from '../src/store/quickAction';

describe('buildQuickActionItems', () => {
  const t = (key: string) => key;

  it('builds a localized New note and New list action', () => {
    const items = buildQuickActionItems(t);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: QUICK_ACTION_NEW_NOTE,
      title: 'quickActions.newNote',
      params: { noteType: 'text' },
    });
    expect(items[1]).toMatchObject({
      id: QUICK_ACTION_NEW_LIST,
      title: 'quickActions.newList',
      params: { noteType: 'list' },
    });
  });

  it('gives every item an icon', () => {
    for (const item of buildQuickActionItems(t)) {
      expect(item.icon).toBeTruthy();
    }
  });
});

describe('noteTypeForQuickAction', () => {
  it('returns null for missing or unknown actions', () => {
    expect(noteTypeForQuickAction(null)).toBeNull();
    expect(noteTypeForQuickAction(undefined)).toBeNull();
    expect(noteTypeForQuickAction({ id: 'something_else' })).toBeNull();
    expect(noteTypeForQuickAction({ id: 'x', params: { noteType: 'bogus' } })).toBeNull();
  });

  it('resolves the note type from the action id', () => {
    expect(noteTypeForQuickAction({ id: QUICK_ACTION_NEW_NOTE })).toBe('text');
    expect(noteTypeForQuickAction({ id: QUICK_ACTION_NEW_LIST })).toBe('list');
  });

  it('falls back to the params payload when the id is unknown', () => {
    expect(noteTypeForQuickAction({ id: 'unmapped', params: { noteType: 'list' } })).toBe('list');
    expect(noteTypeForQuickAction({ params: { noteType: 'text' } })).toBe('text');
  });
});

describe('pending quick action store', () => {
  afterEach(() => setPendingQuickAction(null));

  it('stores and clears the pending action', () => {
    expect(getPendingQuickAction()).toBeNull();
    setPendingQuickAction({ noteType: 'list' });
    expect(getPendingQuickAction()).toEqual({ noteType: 'list' });
    setPendingQuickAction(null);
    expect(getPendingQuickAction()).toBeNull();
  });

  it('notifies subscribers on change', () => {
    const listener = jest.fn();
    const unsubscribe = subscribePendingQuickAction(listener);
    setPendingQuickAction({ noteType: 'text' });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setPendingQuickAction(null);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
