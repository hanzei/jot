/**
 * Fails any test that writes an unexpected `console.error` — React's act()
 * warnings above all, since each one means a state update landed outside the
 * test's control and an assertion may be racing it.
 *
 * `jest.setupAfterEnv.js` installs the guard for every suite. A test that
 * deliberately drives an error path opts in with `allowConsoleError(pattern)`;
 * matching calls are then swallowed instead of printed, so the run's output
 * only ever shows errors nobody expected.
 *
 * `console.warn`/`console.info` never fail a test — the app logs its sync and
 * reachability diagnostics there — but a suite that exercises such a path on
 * purpose can `silenceConsole('warn', pattern)` so the expected lines stay out
 * of the run's output and only surprising ones are printed.
 *
 * State lives on `globalThis` rather than in module scope so a suite that calls
 * `jest.resetModules()` and re-imports this helper still talks to the one
 * installed guard.
 */
import { format } from 'node:util';

type Pattern = string | RegExp;

type QuietLevel = 'warn' | 'info';

interface GuardState {
  allowed: Pattern[];
  allowAnyNonAct: boolean;
  silenced: Record<QuietLevel, Pattern[]>;
  unexpected: string[];
}

declare global {
  var __jotConsoleGuard: GuardState | undefined;
}

// React's act() warnings. `allowConsoleError()` with no pattern never covers
// these: they are fixed by awaiting the update (`await act(...)`, `waitFor`,
// `await fireEvent...`), not by silencing them.
const ACT_WARNINGS = [
  'not wrapped in act(',
  'overlapping act() calls',
  'without await',
  'current testing environment is not configured to support act(',
];

// console.error output allowed in every test: library output that is neither
// the app's nor the test's to fix. Keep each entry narrow, and say where it
// comes from and why it cannot be fixed at the source. Empty today.
const GLOBAL_ALLOWLIST: Pattern[] = [];

// console.warn/info lines dropped in every test. Same rules as above.
const GLOBAL_QUIET: Record<QuietLevel, Pattern[]> = {
  warn: [
    // src/api/serverReachability logs each reachable <-> unreachable
    // transition. Many suites flip it as setup (markServerUnreachable() /
    // markServerReachable()), so the line is expected wherever it appears.
    /^Server reachability: /,
    // react-native-drawer-layout imports RN's deprecated InteractionManager at
    // module load (via @react-navigation/drawer); RN warns once per process.
    /^InteractionManager has been deprecated/,
    // expo-modules-core probes for this optional native module through
    // TurboModuleRegistry, which suites with a partial `jest.mock('react-native')`
    // do not provide. The probe returns null, as it would on web.
    /^An error occurred while requiring the 'ExpoModulesCoreJSLogger' module/,
  ],
  info: [/^Server reachability: /],
};

function state(): GuardState {
  if (!globalThis.__jotConsoleGuard) {
    globalThis.__jotConsoleGuard = {
      allowed: [],
      allowAnyNonAct: false,
      silenced: { warn: [], info: [] },
      unexpected: [],
    };
  }
  return globalThis.__jotConsoleGuard;
}

function matches(pattern: Pattern, message: string): boolean {
  return typeof pattern === 'string' ? message.includes(pattern) : pattern.test(message);
}

function isActWarning(message: string): boolean {
  return ACT_WARNINGS.some((w) => message.includes(w));
}

/**
 * Declares that the current test expects `console.error` output. Matching calls
 * are swallowed; anything else still fails the test. Call it inside the test
 * (or a `beforeEach`) — the allowance resets after every test.
 *
 * With no argument, any error except a React act() warning is allowed. Prefer
 * passing the message you expect, so an unrelated error still surfaces.
 *
 * @example allowConsoleError('Failed to save note:');
 */
export function allowConsoleError(...patterns: Pattern[]): void {
  const s = state();
  if (patterns.length === 0) {
    s.allowAnyNonAct = true;
  } else {
    s.allowed.push(...patterns);
  }
}

/**
 * Drops expected `console.warn`/`console.info` lines — diagnostics the code
 * under test logs on purpose, such as "Queue drain stalled… retrying" in a
 * backoff test. Resets after every test, so call it in the test or a
 * `beforeEach`. A pattern is required: unrelated output should still show.
 *
 * @example beforeEach(() => silenceConsole('warn', 'Queue drain'));
 */
export function silenceConsole(level: QuietLevel, ...patterns: [Pattern, ...Pattern[]]): void {
  state().silenced[level].push(...patterns);
}

export function installConsoleGuard(): void {
  const s = state();
  const realError = console.error.bind(console);

  for (const level of ['warn', 'info'] as const) {
    const real = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const message = format(...args);
      if (GLOBAL_QUIET[level].some((p) => matches(p, message))) return;
      if (s.silenced[level].some((p) => matches(p, message))) return;
      real(...args);
    };
  }

  console.error = (...args: unknown[]) => {
    const message = format(...args);
    const act = isActWarning(message);
    if (GLOBAL_ALLOWLIST.some((p) => matches(p, message))) return;
    if (s.allowed.some((p) => matches(p, message))) return;
    if (s.allowAnyNonAct && !act) return;
    s.unexpected.push(message);
    realError(...args);
  };

  // Allowances are per test. `unexpected` is deliberately not cleared here: an
  // error logged between two tests (a previous test's leaked async work) must
  // fail the next one rather than vanish.
  beforeEach(() => {
    s.allowed = [];
    s.allowAnyNonAct = false;
    s.silenced = { warn: [], info: [] };
  });

  afterEach(() => {
    report('This test');
  });

  // Catches errors logged after the last test's afterEach.
  afterAll(() => {
    report('This suite (after its last test finished)');
  });

  function report(who: string): void {
    const unexpected = s.unexpected;
    s.unexpected = [];
    if (unexpected.length === 0) return;
    const hasAct = unexpected.some(isActWarning);
    const lines = [
      `${who} wrote ${unexpected.length} unexpected console.error call(s); the guard in mobile/jest.setupAfterEnv.js fails on them.`,
      'An error can also come from async work a previous test left running.',
      '',
      ...unexpected.map((m) => `  • ${m.split('\n').slice(0, 3).join('\n    ')}`),
      '',
    ];
    if (hasAct) {
      lines.push(
        'React act() warnings mean a state update happened outside the test\'s control. Fix the test, don\'t silence it:',
        '  - await every RNTL event: `await fireEvent.press(...)`, `await fireEvent(node, ...)` (they are async in RNTL 14);',
        '  - wrap direct triggers (emitters, timers, captured callbacks) in `await act(async () => { ... })`;',
        '  - wait for async effects with `await waitFor(...)` / `await findBy...` before the test ends.',
        '',
      );
    }
    lines.push(
      'If the error is the behaviour under test, opt in inside that test:',
      '  import { allowConsoleError } from \'./helpers/consoleGuard\';',
      '  allowConsoleError(\'<text the error contains>\'); // or a RegExp',
    );
    throw new Error(lines.join('\n'));
  }
}
