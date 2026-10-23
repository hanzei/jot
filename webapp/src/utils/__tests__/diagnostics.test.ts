import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  FAILED_REQUEST_LIMIT,
  getDiagnostics,
  recordFailedRequest,
  resetDiagnosticsForTest,
  routePattern,
  subscribeToDiagnostics,
} from '../diagnostics';

const NOTE_ID = 'abcdefghijklmnopqrstuv';
const ITEM_ID = '0123456789ABCDEFGHIJkl';
const NOW = new Date('2026-10-23T12:00:00.000Z');

function serverError(status: number, url: string, method = 'patch') {
  return {
    config: { method, url },
    response: {
      status,
      headers: { 'x-request-id': 'req123' },
      data: { error: { code: 'internal', message: 'internal server error' } },
    },
  };
}

describe('routePattern', () => {
  it('replaces ID segments and drops the query string', () => {
    expect(routePattern(`/notes/${NOTE_ID}/items/${ITEM_ID}?search=secret`)).toBe('/notes/{id}/items/{id}');
  });

  it('keeps fixed segments', () => {
    expect(routePattern('/notes/trash')).toBe('/notes/trash');
    expect(routePattern('/labels/counts')).toBe('/labels/counts');
  });
});

describe('recordFailedRequest', () => {
  beforeEach(() => {
    resetDiagnosticsForTest();
  });

  it('records method, route, status, code and request ID', () => {
    recordFailedRequest(serverError(500, `/notes/${NOTE_ID}`), NOW);
    expect(getDiagnostics().failedRequests).toEqual([{
      time: NOW.toISOString(),
      method: 'PATCH',
      route: '/notes/{id}',
      status: 500,
      code: 'internal',
      requestId: 'req123',
    }]);
  });

  it('records a network error with axios\'s code and no status', () => {
    recordFailedRequest({ code: 'ERR_NETWORK', config: { method: 'get', url: '/notes' } }, NOW);
    expect(getDiagnostics().failedRequests[0]).toMatchObject({ status: null, code: 'ERR_NETWORK', requestId: null });
  });

  it('ignores cancelled requests', () => {
    recordFailedRequest({ code: 'ERR_CANCELED', config: { method: 'get', url: '/notes' } }, NOW);
    expect(getDiagnostics().failedRequests).toEqual([]);
  });

  it(`keeps only the last ${FAILED_REQUEST_LIMIT}`, () => {
    for (let i = 0; i < FAILED_REQUEST_LIMIT + 5; i++) {
      recordFailedRequest(serverError(500 + (i % 4), `/n${i}`), NOW);
    }
    const { failedRequests } = getDiagnostics();
    expect(failedRequests).toHaveLength(FAILED_REQUEST_LIMIT);
    expect(failedRequests[0]!.route).toBe('/n5');
    expect(failedRequests[FAILED_REQUEST_LIMIT - 1]!.route).toBe(`/n${FAILED_REQUEST_LIMIT + 4}`);
  });

  it('never stores request or response bodies', () => {
    const err = serverError(500, '/notes');
    recordFailedRequest({ ...err, config: { ...err.config, data: '{"content":"secret"}' } }, NOW);
    expect(JSON.stringify(getDiagnostics())).not.toContain('secret');
    expect(JSON.stringify(getDiagnostics())).not.toContain('internal server error');
  });

  it('notifies subscribers with a new snapshot', () => {
    const listener = vi.fn();
    const before = getDiagnostics();
    const unsubscribe = subscribeToDiagnostics(listener);
    recordFailedRequest(serverError(500, '/notes'), NOW);
    unsubscribe();
    recordFailedRequest(serverError(500, '/notes'), NOW);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getDiagnostics()).not.toBe(before);
  });
});
