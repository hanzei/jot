import { renderHook } from '@testing-library/react-native';
import {
  useSettledSearchResults,
  type SearchResults,
} from '../src/screens/notesList/useSettledSearchResults';
import { makeTextNote } from './helpers/fixtures';

const apple = makeTextNote({ id: 'apple' });
const apricot = makeTextNote({ id: 'apricot' });
const oldApple = makeTextNote({ id: 'old-apple', archived: true });
const oldApricot = makeTextNote({ id: 'old-apricot', archived: true });

interface Props {
  view: string;
  current: SearchResults;
  needsArchived: boolean;
}

const results = (search: string, notes: SearchResults['notes'], archived?: SearchResults['archived']) => ({
  search,
  notes,
  archived,
});

async function renderSettled(initial: Props) {
  return renderHook(
    ({ view, current, needsArchived }: Props) => useSettledSearchResults(view, current, needsArchived),
    { initialProps: initial },
  );
}

describe('useSettledSearchResults', () => {
  it('passes the current results through on first load, pending or not', async () => {
    const pending = results('', undefined);
    const { result, rerender } = await renderSettled({ view: 'notes', current: pending, needsArchived: false });
    expect(result.current).toBe(pending);

    const loaded = results('', [apple, apricot]);
    await rerender({ view: 'notes', current: loaded, needsArchived: false });
    expect(result.current).toBe(loaded);
  });

  it('holds the previous term until both reads of the next one land, whichever lands first', async () => {
    const ap = results('ap', [apple, apricot], [oldApple]);
    const { result, rerender } = await renderSettled({ view: 'notes', current: ap, needsArchived: true });

    // Active notes land first: archived matches for 'apr' are still pending.
    await rerender({ view: 'notes', current: results('apr', [apricot], undefined), needsArchived: true });
    expect(result.current).toBe(ap);

    // The other order: archived matches land first.
    await rerender({ view: 'notes', current: results('apr', undefined, [oldApricot]), needsArchived: true });
    expect(result.current).toBe(ap);

    const apr = results('apr', [apricot], [oldApricot]);
    await rerender({ view: 'notes', current: apr, needsArchived: true });
    expect(result.current).toBe(apr);
  });

  it('settles on the active read alone when no archived read is needed', async () => {
    const { result, rerender } = await renderSettled({
      view: 'my-tasks',
      current: results('ap', [apple, apricot]),
      needsArchived: false,
    });
    const apr = results('apr', [apricot]);
    await rerender({ view: 'my-tasks', current: apr, needsArchived: false });
    expect(result.current).toBe(apr);
  });

  it('holds the last results shown, not an older search', async () => {
    // 'zzz' had archived matches; clearing the search turns the archived read off.
    const { result, rerender } = await renderSettled({
      view: 'notes',
      current: results('zzz', [], [oldApple]),
      needsArchived: true,
    });
    const unsearched = results('', [apple, apricot]);
    await rerender({ view: 'notes', current: unsearched, needsArchived: false });

    await rerender({ view: 'notes', current: results('ap', undefined, undefined), needsArchived: true });
    expect(result.current).toBe(unsearched);
  });

  it('holds nothing across a change of view', async () => {
    const { result, rerender } = await renderSettled({
      view: 'notes',
      current: results('ap', [apple, apricot]),
      needsArchived: false,
    });
    const otherLabel = results('ap', undefined);
    await rerender({ view: 'label-2', current: otherLabel, needsArchived: false });
    expect(result.current).toBe(otherLabel);
  });

  it('passes in-view updates of the current term straight through', async () => {
    const { result, rerender } = await renderSettled({
      view: 'notes',
      current: results('ap', [apple, apricot]),
      needsArchived: false,
    });
    const synced = results('ap', [apple]);
    await rerender({ view: 'notes', current: synced, needsArchived: false });
    expect(result.current).toBe(synced);
  });
});
