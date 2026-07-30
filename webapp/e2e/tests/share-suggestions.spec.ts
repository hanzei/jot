import { test, expect, uniqueUsername } from '../fixtures';
import type { APIRequestContext } from '@playwright/test';

async function registerUsers(request: APIRequestContext, usernames: string[]) {
  for (const username of usernames) {
    await request.post('/api/v1/register', {
      data: { username, password: 'testpass123' },
    });
  }
}

/**
 * The share modal's empty-query state. Sharing with someone you already
 * collaborate with should not require recalling and typing their username, so
 * focusing the field offers past collaborators first and the rest of the
 * directory below.
 */
test.describe('Share suggestions', () => {
  test('offers past collaborators before the rest of the directory', async ({
    page,
    authenticatedUser,
    dashboardPage,
    request,
  }) => {
    void authenticatedUser;
    const collaborator = uniqueUsername('recent');
    const stranger = uniqueUsername('stranger');
    await registerUsers(request, [collaborator, stranger]);

    await dashboardPage.goto();
    await dashboardPage.createAndShareNote('First Shared Note', collaborator);

    // A second note: focusing the field alone should now surface the
    // collaborator, with no typing at all.
    await dashboardPage.createNote('Second Note');
    await dashboardPage.openNote('Second Note');
    await dashboardPage.openShareModalFromModal();
    await page.getByPlaceholder(/search users/i).click();

    const recent = page.getByTestId('share-recent-suggestions');
    await expect(recent).toBeVisible();
    await expect(recent.getByText(collaborator)).toBeVisible();
    await expect(recent.getByText(stranger)).toHaveCount(0);

    // The stranger is still reachable, just below the recents.
    await expect(page.getByTestId('share-all-users').getByText(stranger)).toBeVisible();

    // Picking from the suggestions shares the note.
    await recent.getByText(collaborator).click();
    await expect(page.getByText(/shared with \(1\)/i)).toBeVisible();
  });

  test('ranks past collaborators above other matches while searching', async ({
    page,
    authenticatedUser,
    dashboardPage,
    request,
  }) => {
    void authenticatedUser;
    // A shared prefix so both users match the same query, with the stranger
    // sorting first alphabetically — recency has to win.
    const suffix = `${Date.now()}${Math.floor(Math.random() * 9000 + 1000)}`;
    const collaborator = `zmatch${suffix}`;
    const stranger = `amatch${suffix}`;
    await registerUsers(request, [collaborator, stranger]);

    await dashboardPage.goto();
    await dashboardPage.createAndShareNote('History Note', collaborator);

    await dashboardPage.createNote('Search Ranking Note');
    await dashboardPage.openNote('Search Ranking Note');
    await dashboardPage.openShareModalFromModal();
    await page.getByPlaceholder(/search users/i).fill(`match${suffix}`);

    const suggestions = page.getByTestId('share-suggestions');
    await expect(suggestions.getByText(collaborator)).toBeVisible();
    await expect(suggestions.getByText(stranger)).toBeVisible();

    // Groups collapse into one ranked list while searching.
    await expect(page.getByTestId('share-recent-suggestions')).toHaveCount(0);
    await expect(suggestions.getByText(/^(zmatch|amatch)/).first()).toHaveText(collaborator);
  });
});

// The exhausted-directory states ("everyone already has access" / "no other
// users") are covered by the ShareModal unit tests instead: asserting them here
// would mean sharing with every user in the directory, which other specs keep
// adding to while these run.
