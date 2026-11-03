import { describe, expect, it, vi } from 'vitest';
import { createJotApi, type JotHttpClient } from '../api';

function mockHttp(data: unknown = {}) {
  const res = Promise.resolve({ data });
  const http = {
    get: vi.fn(() => res),
    delete: vi.fn(() => res),
    post: vi.fn(() => res),
    patch: vi.fn(() => res),
    put: vi.fn(() => res),
  };
  return { http, api: createJotApi(http as unknown as JotHttpClient) };
}

describe('createJotApi', () => {
  it('does not touch the instance until an endpoint is called', () => {
    expect(() => createJotApi(undefined as unknown as JotHttpClient)).not.toThrow();
  });

  it('unwraps list responses', async () => {
    const { http, api } = mockHttp({ notes: [{ id: 'a' }] });
    await expect(api.notes.getAll({ archived: true })).resolves.toEqual([{ id: 'a' }]);
    expect(http.get).toHaveBeenCalledWith('/notes', {
      params: { archived: true, search: undefined, trashed: undefined, label: undefined, my_tasks: undefined },
    });
  });

  it('never sends the client-only user_id filter or an empty label', async () => {
    const { http, api } = mockHttp({ notes: [] });
    await api.notes.getAll({ label: '', my_tasks: false, user_id: 'u1', search: 'x' });
    expect(http.get).toHaveBeenCalledWith('/notes', {
      params: { archived: undefined, search: 'x', trashed: undefined, label: undefined, my_tasks: undefined },
    });
  });

  it('converts label counts to a record', async () => {
    const { api } = mockHttp({ counts: [{ label_id: 'l1', count: 2 }, { label_id: 'l2', count: 0 }] });
    await expect(api.labels.getCounts()).resolves.toEqual({ l1: 2, l2: 0 });
  });

  it('sends duplicate client IDs only when given', async () => {
    const { http, api } = mockHttp({ id: 'copy' });
    await api.notes.duplicate('n1');
    expect(http.post).toHaveBeenLastCalledWith('/notes/n1/duplicate', undefined);
    await api.notes.duplicate('n1', { id: 'c1', itemIds: { a: 'b' } });
    expect(http.post).toHaveBeenLastCalledWith('/notes/n1/duplicate', { id: 'c1', item_ids: { a: 'b' } });
  });

  it('returns the restored note', async () => {
    const { api } = mockHttp({ id: 'n1' });
    await expect(api.notes.restore('n1')).resolves.toEqual({ id: 'n1' });
  });

  it('sends a permanent delete as a query parameter', async () => {
    const { http, api } = mockHttp();
    await api.notes.delete('n1', { permanent: true });
    expect(http.delete).toHaveBeenLastCalledWith('/notes/n1', { params: { permanent: true } });
    await api.notes.delete('n1');
    expect(http.delete).toHaveBeenLastCalledWith('/notes/n1');
  });

  it('passes upload bodies and config through untouched', async () => {
    const { http, api } = mockHttp();
    const body = { opaque: true };
    const config = { timeout: 1 };
    await api.images.upload('n1', body, config);
    expect(http.post).toHaveBeenCalledWith('/notes/n1/images', body, config);
  });
});
