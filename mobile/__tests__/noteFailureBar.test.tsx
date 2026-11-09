import { renderHook } from '@testing-library/react-native';
import { useNoteFailureBarShown, useReportNoteFailureBar } from '../src/store/noteFailureBar';

// Stand in for a focused screen: the focus effect runs on mount and its cleanup
// on unmount (a blur), as useFocusEffect does for the focused screen.
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => (() => void) | undefined) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot close over imports
    const { useEffect } = require('react') as typeof import('react');
    useEffect(effect, [effect]);
  },
}));

describe('noteFailureBar', () => {
  it('is shown while a focused editor reports its bar, and cleared when it blurs', async () => {
    const reporter = await renderHook(({ shown }: { shown: boolean }) => useReportNoteFailureBar(shown), { initialProps: { shown: true } });
    const reader = await renderHook(() => useNoteFailureBarShown());
    expect(reader.result.current).toBe(true);

    await reporter.rerender({ shown: false });
    expect(reader.result.current).toBe(false);

    await reporter.rerender({ shown: true });
    expect(reader.result.current).toBe(true);
    await reporter.unmount();
    expect(reader.result.current).toBe(false);
  });

  it('stays shown until every reporting editor has cleared', async () => {
    const first = await renderHook(() => useReportNoteFailureBar(true));
    const second = await renderHook(() => useReportNoteFailureBar(true));
    const reader = await renderHook(() => useNoteFailureBarShown());

    await first.unmount();
    expect(reader.result.current).toBe(true);
    await second.unmount();
    expect(reader.result.current).toBe(false);
  });
});
