import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLogout } = vi.hoisted(() => ({ mockLogout: vi.fn() }));

vi.mock('@/utils/api', () => ({
  auth: { logout: mockLogout },
}));

import { endServerSession, isLogoutInFlight, logoutSettled } from '../logout';

describe('endServerSession', () => {
  beforeEach(() => {
    mockLogout.mockReset();
  });

  it('reports the session ended when POST /logout succeeds', async () => {
    mockLogout.mockResolvedValue(undefined);
    await expect(endServerSession()).resolves.toBe(true);
    expect(mockLogout).toHaveBeenCalledWith({ skipAuthRedirect: true });
  });

  it('treats a 401 as an already-ended session', async () => {
    mockLogout.mockRejectedValue({ response: { status: 401 } });
    await expect(endServerSession()).resolves.toBe(true);
  });

  it('reports the session alive when the server cannot be reached', async () => {
    mockLogout.mockRejectedValue(new Error('Network Error'));
    await expect(endServerSession()).resolves.toBe(false);
  });

  it('reports the session alive on a server error or rate limit', async () => {
    mockLogout.mockRejectedValue({ response: { status: 500 } });
    await expect(endServerSession()).resolves.toBe(false);
    mockLogout.mockRejectedValue({ response: { status: 429 } });
    await expect(endServerSession()).resolves.toBe(false);
  });

  it('shares one request between overlapping calls and settles before sign-in', async () => {
    let finish!: () => void;
    mockLogout.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));

    const first = endServerSession();
    const second = endServerSession();
    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(isLogoutInFlight()).toBe(true);

    let settled = false;
    const waiting = logoutSettled().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    finish();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    await waiting;
    expect(isLogoutInFlight()).toBe(false);
  });
});
