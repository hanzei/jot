import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import type { Result } from 'axe-core';

/**
 * The conformance level Jot scans against: WCAG 2.0 and 2.1, levels A and AA.
 *
 * Deliberately excludes axe's `best-practice` tag. Those rules encode
 * reasonable advice (`region`, `page-has-heading-one`, …) but are not
 * standards, and mixing them in makes a failing scan ambiguous about whether
 * something is actually broken. Scanning a narrower, standards-only set that
 * is *enforced* beats a wider set that has to be ignored.
 */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * Rules switched off for every scan, each with the reason it cannot hold here.
 *
 * This is the escape hatch for "axe is right about the DOM but the fix is a
 * third-party component we do not control" — not for "this violation is
 * inconvenient". Anything suppressed here needs a reason a reviewer can check,
 * and preferably an issue to point at. Prefer scoping an exclusion to one scan
 * (`exclude` below) over adding a global entry.
 */
export const GLOBALLY_DISABLED_RULES: Record<string, string> = {};

/**
 * A violation that is known, understood and deliberately not fixed yet.
 *
 * Narrower than disabling the rule: only the matching nodes are forgiven, so
 * the same rule still fails anywhere else on the page. Every entry needs an
 * issue to point at — an accepted violation with no owner is just a muted one.
 */
export interface AcceptedViolation {
  /** axe rule id, e.g. `nested-interactive`. */
  rule: string;
  /**
   * Substring identifying the node, matched against both its target selector
   * and its markup. Prefer something from the markup — a `data-` attribute,
   * say. axe derives the target selector from whatever is locally unique, so
   * it changes with the surrounding DOM: the same element is `.select-none`
   * on a page with one note and `div:nth-child(1) > .select-none…` on a page
   * with several.
   */
  match: string;
  /** Why it stands, and the issue tracking the fix. */
  reason: string;
}

export interface ScanOptions {
  /** Restrict the scan to these selectors instead of the whole page. */
  include?: string[];
  /** Subtrees to skip, e.g. a third-party widget. Each needs a reason in the caller. */
  exclude?: string[];
  /** Rules to skip for this scan only. Keys are rule ids, values are the reason. */
  disableRules?: Record<string, string>;
  /** Known violations to forgive, node by node. */
  accept?: AcceptedViolation[];
}

/**
 * Waits for CSS animations and transitions to finish.
 *
 * Jot fades and pops several surfaces in (`animate-fade-in`, `animate-pop-in`),
 * and axe samples computed colours at the instant it runs. Scanning mid-fade
 * measures a blend of the text and background colours, so `color-contrast`
 * reports a failure that does not exist once the element settles — and reports
 * a different one on the next run. Infinite animations (loading spinners) are
 * skipped, since waiting on those never returns.
 */
async function waitForAnimations(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
      .every((animation) => animation.playState === 'finished' || animation.playState === 'idle')
  );
}

/** Runs axe over the page and returns the violations, worst impact first. */
export async function scanForViolations(page: Page, options: ScanOptions = {}): Promise<Result[]> {
  await waitForAnimations(page);

  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);

  for (const selector of options.include ?? []) {
    builder = builder.include(selector);
  }
  for (const selector of options.exclude ?? []) {
    builder = builder.exclude(selector);
  }

  const disabled = Object.keys({ ...GLOBALLY_DISABLED_RULES, ...options.disableRules });
  if (disabled.length > 0) {
    builder = builder.disableRules(disabled);
  }

  const { violations } = await builder.analyze();

  const accepted = options.accept ?? [];
  const remaining = violations
    .map((violation) => ({
      ...violation,
      nodes: violation.nodes.filter(
        (node) =>
          !accepted.some(
            (entry) =>
              entry.rule === violation.id &&
              (node.html.includes(entry.match) ||
                node.target.some((selector) => String(selector).includes(entry.match)))
          )
      ),
    }))
    .filter((violation) => violation.nodes.length > 0);

  const order = ['critical', 'serious', 'moderate', 'minor'];
  return remaining.sort(
    (a, b) => order.indexOf(a.impact ?? 'minor') - order.indexOf(b.impact ?? 'minor')
  );
}

/**
 * Renders violations as something readable in a CI log.
 *
 * axe's raw result objects are large and nested; dumped verbatim into an
 * assertion message they are effectively unreadable, which is the usual reason
 * an a11y check gets muted rather than fixed. One block per violation, with the
 * failing selector and axe's own remediation summary.
 */
export function formatViolations(violations: Result[]): string {
  return violations
    .map((violation) => {
      const nodes = violation.nodes
        .map((node) => `    ${node.target.join(' ')}\n      ${node.failureSummary?.replace(/\n/g, '\n      ')}`)
        .join('\n');
      return [
        `  [${violation.impact}] ${violation.id}: ${violation.help}`,
        `  ${violation.helpUrl}`,
        nodes,
      ].join('\n');
    })
    .join('\n\n');
}

/**
 * Asserts the current page has no WCAG A/AA violations.
 *
 * Blocking by design: a report-only a11y check has nothing forcing the baseline
 * to stay clean, so a regression just accumulates. If a scan starts failing,
 * fix the markup or suppress the rule with a reason — do not delete the scan.
 */
export async function expectNoViolations(page: Page, options: ScanOptions = {}): Promise<void> {
  const violations = await scanForViolations(page, options);
  // Assert on one-line summaries rather than on the raw results: a diff of
  // axe's nested objects buries the message below, which is the part that says
  // what to fix.
  const summary = violations.map((v) => `[${v.impact}] ${v.id} (${v.nodes.length} node(s))`);
  expect(
    summary,
    violations.length === 0 ? '' : `axe found ${violations.length} WCAG A/AA violation(s):\n\n${formatViolations(violations)}\n`
  ).toEqual([]);
}
