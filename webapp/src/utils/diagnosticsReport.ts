import type { AboutInfo } from '@jot/shared';
import type { DiagnosticsState } from '@/utils/diagnostics';
import { WEBAPP_BUILD } from '@/utils/buildInfo';

/** A render error caught by an error boundary. Name, message and stacks only — never props or state. */
export interface DiagnosticsCrash {
  name: string;
  message: string;
  stack: string | null;
  componentStack: string | null;
}

export interface DiagnosticsReportInput {
  diagnostics: DiagnosticsState;
  /** Null when /about could not be fetched. */
  server: AboutInfo | null;
  /** Path only: a query string can carry search terms. */
  route: string;
  userAgent: string;
  now: Date;
  crash?: DiagnosticsCrash;
}

/**
 * The JSON report copied from Settings > Diagnostics and from the error
 * fallback. It carries build info, live-update state and failed-request
 * metadata, never request or response bodies, so note content and credentials
 * stay out.
 */
export function buildDiagnosticsReport({ diagnostics, server, route, userAgent, now, crash }: DiagnosticsReportInput) {
  return {
    generatedAt: now.toISOString(),
    route,
    userAgent,
    webapp: WEBAPP_BUILD,
    ...(crash ? { crash } : {}),
    server: {
      version: server?.version ?? null,
      commit: server?.commit ?? null,
      build_time: server?.build_time ?? null,
      go_version: server?.go_version ?? null,
    },
    sse: diagnostics.sse,
    failedRequests: diagnostics.failedRequests,
  };
}

export function formatDiagnosticsReport(input: DiagnosticsReportInput): string {
  return JSON.stringify(buildDiagnosticsReport(input), null, 2);
}
