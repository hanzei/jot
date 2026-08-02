// Runs after the test framework is installed, which is what `jest.setup.js`
// cannot do: register a global hook. Every test starts with its own migrated
// in-memory SQLite database (see `__tests__/helpers/testDb.ts`), so no suite
// has to opt in and no rows leak from one test into the next.
const { resetTestDatabases } = require('./__tests__/helpers/testDb');

beforeEach(async () => {
  await resetTestDatabases();
});
