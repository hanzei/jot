import { request } from '@playwright/test';

/**
 * Registers the bootstrap admin user before any tests run so that parallel
 * workers cannot race to claim the admin role.  The first registered user in a
 * fresh Jot DB becomes admin, so we guarantee that 'e2eadmin' is always that
 * user regardless of test execution order.
 */
export default async function globalSetup(): Promise<void> {
  const context = await request.newContext({ baseURL: 'http://localhost:8080' });
  try {
    const response = await context.post('/api/v1/register', {
      data: { username: 'e2eadmin', password: 'testpass123' },
    });
    // 201 = registered as admin (first user); 409 = already exists (idempotent re-run).
    if (!response.ok() && response.status() !== 409) {
      throw new Error(
        `Admin bootstrap failed: ${response.status()} ${response.statusText()}`,
      );
    }
  } finally {
    await context.dispose();
  }
}
