import { getNoteSortLabel } from '../src/utils/noteSort';

describe('mobile noteSort', () => {
  it('returns labels for sort modes', () => {
    expect(getNoteSortLabel('manual')).toBe('Manual');
    expect(getNoteSortLabel('created_at')).toBe('Date created');
  });
});
