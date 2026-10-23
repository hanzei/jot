export interface ErrorDetailsInput {
  error: Error;
  componentStack: string | null;
  /** The webapp bundle carries no version of its own; this is the server's. */
  serverVersion: string;
  /** Path only: a query string can carry search terms. */
  route: string;
  userAgent: string;
  now: Date;
}

/**
 * Plain-text report for the error fallback's "copy error details". Carries the
 * error's message and stacks, never props or state, so note content stays out.
 */
export function buildErrorDetails({ error, componentStack, serverVersion, route, userAgent, now }: ErrorDetailsInput): string {
  const lines = [
    'Jot error report',
    `Server version: ${serverVersion}`,
    `Route: ${route}`,
    `Time: ${now.toISOString()}`,
    `User agent: ${userAgent}`,
    '',
    `Error: ${error.name}: ${error.message}`,
  ];
  if (error.stack) {
    lines.push('', 'Stack:', error.stack);
  }
  if (componentStack) {
    lines.push('', 'Component stack:', componentStack.trim());
  }
  return lines.join('\n');
}
