// Runs after the test framework is installed, which is what `jest.setup.js`
// cannot do: register a global hook. Every test starts with its own migrated
// in-memory SQLite database (see `__tests__/helpers/testDb.ts`), so no suite
// has to opt in and no rows leak from one test into the next.
const { resetTestDatabases } = require('./__tests__/helpers/testDb');
// Fails a test on any console.error it did not declare with
// `allowConsoleError(...)` — React act() warnings included. See
// `__tests__/helpers/consoleGuard.ts`.
const { installConsoleGuard } = require('./__tests__/helpers/consoleGuard');

installConsoleGuard();

// TanStack Query delivers observer updates in a batch scheduled with
// setTimeout(0), i.e. after whatever act() scope started the query has closed,
// so every query or mutation that settles re-renders outside act() and React
// warns. Running each batch inside act() makes those renders part of the
// test's controlled flow. RNTL's waitFor switches the act environment off
// while it polls (React neither needs nor accepts act() then), so only wrap
// when it is on.
const { act } = require('react');
const { notifyManager, timeoutManager } = require('@tanstack/react-query');

notifyManager.setBatchNotifyFunction((callback) => {
  if (globalThis.IS_REACT_ACT_ENVIRONMENT) {
    act(callback);
  } else {
    callback();
  }
});

beforeEach(async () => {
  await resetTestDatabases();
});

// A QueryClient arms a gcTime (default 5 min) timer for every query whose last
// observer goes away — which RNTL's cleanup does to every rendered query after
// each test. Those timers are the handles that kept Jest workers alive at the
// end of the run; they are created after the test body, so
// `npm run test:handles` cannot attribute them. Unref'ing query-core's timers
// lets a worker exit without waiting for them. Globals are resolved per call,
// so jest.useFakeTimers() still controls query retries and staleness.
const unref = (id) => {
  if (id && typeof id.unref === 'function') id.unref();
  return id;
};
timeoutManager.setTimeoutProvider({
  setTimeout: (callback, delay) => unref(setTimeout(callback, delay)),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (callback, delay) => unref(setInterval(callback, delay)),
  clearInterval: (id) => clearInterval(id),
});
