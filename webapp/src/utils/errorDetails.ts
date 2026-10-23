export interface ErrorDetailsInput {
  error: Error;
  componentStack: string | null;
  appVersion: string;
  /** Path only: a query string can carry search terms. */
  route: string;
  userAgent: string;
  now: Date;
}

/**
 * Plain-text report for the error fallback's "copy error details". Carries the
 * error's message and stacks, never props or state, so note content stays out.
 */
export function buildErrorDetails({ error, componentStack, appVersion, route, userAgent, now }: ErrorDetailsInput): string {
  const lines = [
    'Jot error report',
    `App version: ${appVersion}`,
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
