import { describe, it, expect } from 'vitest';
import { buildDiagnosticsReport, formatDiagnosticsReport } from '../diagnosticsReport';
import { WEBAPP_BUILD } from '../buildInfo';
import type { DiagnosticsState } from '../diagnostics';

const diagnostics: DiagnosticsState = {
  sse: { status: 'reconnecting', reconnectAttempts: 3, lastEventAt: '2026-10-23T11:59:00.000Z' },
  failedRequests: [{
    time: '2026-10-23T11:58:00.000Z',
    method: 'DELETE',
    route: '/notes/{id}',
    status: 500,
    code: 'internal',
    requestId: 'req123',
  }],
};

const input = {
  diagnostics,
  server: { version: '1.2.3', commit: 'abc1234' },
  route: '/settings',
  userAgent: 'test-agent',
  now: new Date('2026-10-23T12:00:00.000Z'),
};

describe('buildDiagnosticsReport', () => {
  it('carries builds, live-update state and failed requests', () => {
    expect(buildDiagnosticsReport(input)).toEqual({
      generatedAt: '2026-10-23T12:00:00.000Z',
      route: '/settings',
      userAgent: 'test-agent',
      webapp: WEBAPP_BUILD,
      server: { version: '1.2.3', commit: 'abc1234', build_time: null, go_version: null },
      sse: diagnostics.sse,
      failedRequests: diagnostics.failedRequests,
    });
  });

  it('reports an unknown server as nulls', () => {
    expect(buildDiagnosticsReport({ ...input, server: null }).server).toEqual({
      version: null, commit: null, build_time: null, go_version: null,
    });
  });

  it('includes a crash only when given one', () => {
    expect(buildDiagnosticsReport(input)).not.toHaveProperty('crash');
    const crash = { name: 'Error', message: 'boom', stack: 'at x', componentStack: 'in Y' };
    expect(buildDiagnosticsReport({ ...input, crash }).crash).toEqual(crash);
  });

  it('formats as parseable JSON', () => {
    expect(JSON.parse(formatDiagnosticsReport(input))).toEqual(buildDiagnosticsReport(input));
  });
});
