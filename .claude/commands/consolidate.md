---
description: Find features, API endpoints, and code paths that can be merged or removed to make Jot leaner, rank them by impact, and file the ones the user picks as GitHub issues.
argument-hint: "[area to focus on, e.g. `server/` or \"list items\" — omit for the whole product]"
---

# Consolidation review

Look for what Jot has more than one of: endpoints that do the same job, the same operation
implemented once per transport or per client, store functions that are a special case of
another, dead code, and features whose cost outweighs what they add. Focus on `$ARGUMENTS`
if given; empty means the whole product. The goal is a smaller product and a smaller code
base, not a tidier one.

Three phases, in order:

1. **Survey**: map the surface and find overlap.
2. **Report**: a numbered, ranked list the user can discuss by number.
3. **File**: issues for the findings the user picks, in the repo's house style.

Nothing in this command changes code: no branch, no commits, no edits. Its outputs are the
report and, at most, the issues the user selects.

This differs from `/tech-debt`. That command audits debt in general (suppressions, size,
coverage, drift). This one asks a narrower question: *what can be merged or deleted?* Where
the two overlap (cross-client duplication, dead exports), report the finding here when its
fix is a merge or a deletion.

## Ground rules

**Breaking the API is fine.** Per root `CLAUDE.md` the API is unstable on purpose, and a
merge should remove the old endpoint, not keep it as an alias. Don't propose
compatibility shims, deprecation periods, or version fallbacks. The PR still calls out
the break.

**Data already on devices is not API compatibility, and it still needs a plan.** Two
clients persist requests by URL and replay them later:

- **Mobile**'s offline sync queue (`mobile/src/db/syncQueue.ts`) stores each change's
  `endpoint` and `operation` in SQLite. Rows written by an older app survive the upgrade.
  A removed or renamed route needs a schema migration in `mobile/src/db/schema.ts` that
  rewrites pending rows. Earlier migrations there show the pattern.
- **The webapp service worker** (`webapp/src/service-worker.ts`) queues retryable writes in
  Workbox's IndexedDB queue with their full URL, and its `onSync` drops a failed replay
  *silently*, a 404 included. Either rewrite the old URL there or say plainly that queued
  requests are lost.

Every finding that changes or removes a path must say which of these applies.

**A duplicate is only a finding once you know it isn't deliberate.** In this repo many
copies exist for a stated reason. Before reporting one, check:

- root `CLAUDE.md` and the per-area `CLAUDE.md` files. The API conventions there list
  deliberate exceptions, such as the item-action endpoints returning raw arrays,
  `POST /labels` being get-or-create, and `PUT /users/me/password`;
- the comment at the top of each copy. Some client files are the client half of a shared
  module and say so;
- the constraints on `shared/src`: it may not import packages (enforced by `task
  lint-shared`), so a client-side file that only builds a library instance for a shared
  module is not duplication;
- closed issues, including those closed as not planned. A merge that was already weighed
  and declined is not a new finding unless something has changed, and then the finding
  says what.

An action named as a verb (`/restore`, `/duplicate`, `/share`) is not a misnamed resource
just because a sibling route uses a noun. Response codes tell you which it is meant to be:
creates return 201, actions usually 204 or the updated parent.

**Measure; don't remember.** Don't carry line numbers, counts, or file names in from
memory or from this file. Read them off the code at survey time.

**Don't spawn subagents.** Survey inline, as the other review commands do.

## Phase 1: Survey

### API surface

1. Read the routes in `server/internal/server/server.go` and group them by resource.
2. For each group, read the handlers and note which **store functions** each one calls.
   Two endpoints calling store functions that share a core (the same cascade, the same
   delete, the same insert) are candidates. Compare what each one returns, its error
   statuses, and how it handles unknown IDs, because those differences decide the merge.
3. Check how the clients call each group (`shared/src/api/`, `webapp/src`, `mobile/src`).
   Signs of overlap:
   - two endpoints always fetched together (`Promise.all([loadA(), loadB()])`, or paired
     query invalidations);
   - one endpoint that exists only to return a different shape of another's data;
   - a single-item endpoint that is the bulk endpoint with one ID.
4. Check the generated spec text (`@Summary` / `@Description`) against what the code
   does. A spec that misdescribes an endpoint often hides an overlap.

The cost of each extra endpoint is paid several times over: the handler, the Go client
(`server/client/`), the shared API module, both clients' callers, tests, the spec, and,
for a write that mobile replays offline, a sync-queue operation with its own replay
branch (the `QueueOperation` union in `mobile/src/db/syncQueue.ts`). Reads are never
queued, so a read-only merge removes no queue operation. Say which of these a merge
removes.

### Server code paths

- **Transports.** REST handlers (`server/internal/handlers/`) and MCP tools
  (`server/internal/mcphandler/`) share note writes through `server/internal/notesvc/`;
  the item and label operations still call `models` and `notify` directly from both
  (#1181). Compare each such MCP tool with its REST counterpart for copied orchestration: validation, store calls,
  events, blob cleanup, metrics, and rate limiting. **Drift between the copies is the
  strongest evidence**: a metric one side records and the other doesn't, or a rate-limit
  bucket one side bypasses (`/mcp` sits behind a single route, so per-endpoint limits in
  `server.go` don't reach individual tools).
- **Stores.** Functions in `server/internal/models/` that differ only in a parameter or a
  rule (e.g. two user-creation functions, a single-item and a bulk version of the same
  write). When merging touches a rule, check it for races: a count followed by an insert
  outside a transaction is a bug on both backends, since SQLite's single connection
  serializes statements, not transactions.
- **Dead code.** Exported functions whose only callers are tests:

  ```bash
  git grep -n 'FuncName(' -- server ':!**/*_test.go' ':!**/*_otel.go'
  ```

  The OTel wrappers (`*_otel.go`) and store interfaces mirror every store method, so a
  hit there is not a real caller.

### Clients

- Logic implemented in both `webapp/src` and `mobile/src` that could live in
  `@jot/shared`: rules, not rendering (see the cross-workspace section of `/tech-debt`
  for where the line is). Read both copies and say whether they have already diverged.
- Same-name files in `webapp/src/utils` and `mobile/src/utils`: diff them before
  calling them duplicates. A shared filename has meant different jobs before, and a
  shared body has meant a deliberate client half.

### Product features

Features whose cost (code on three clients, settings, warnings, tests, i18n in every
locale) looks high next to what they add: overlapping modes, rarely needed options, a
feature that forces a workaround elsewhere. These are **the user's call**. Report the
cost, make no recommendation stronger than "worth asking", and never fold one into a
technical finding.

### Already lean

Note the areas you checked that are already consolidated, such as pipelines that funnel
into one store function, or flows that share a start and callback. It stops the next
review from re-proposing them.

## Phase 2: Report

Write the report into the conversation, **numbered straight through** (1, 2, 3 … across
all sections, never restarting per section), so the user can refer to findings by number
in later turns. Sections, omitting any that produced nothing:

1. **API endpoints that can be merged**
2. **Server code paths that can be combined**
3. **Duplication in the clients**
4. **Product features (your call)**
5. **Already lean, leave alone**
6. **Rollout notes**: device-persisted data and anything else a merge has to handle.

Per finding:

- what overlaps, citing **every** site as `path:line`. A duplication that cites only one
  of its copies is not actionable;
- the evidence that it really is redundant (shared store core, paired fetches, drift);
- the behavior differences a merge must settle (status codes, unknown-ID handling,
  return shape);
- the proposal, and what it deletes.

Rank within each section by impact: drift and correctness issues (a race, a bypassed rate
limit, a missing metric) first, then reach (how many layers a merge removes), then
cosmetic. Close with a suggested order.

Then stop and let the user steer. Expect them to question findings, drop some, or ask for
tickets by number. When they push back on a finding, re-check it against the code and
change your view if the code supports theirs; say so plainly. When asked what is still
open in a later session, re-verify each finding against a freshly fetched default branch
rather than trusting the earlier report.

## Phase 3: File

File only what the user asks for, grouped as they ask ("one for #1 and #2", "one for 9,
10 and 13"). Before writing each ticket:

- **Re-verify** the finding against a freshly fetched default branch
  (`git fetch origin master`, then read with `git show origin/master:<path>`), since work
  may have landed since the report.
- **Read every caller** the change touches and list them in the ticket. Check the e2e
  specs and test mocks that match paths literally (`page.route('**/api/v1/…')`), because
  those stop matching silently instead of failing.
- **Duplicate check**: search issues, open and closed, as in `/session-wrap-up`, and
  read each plausible hit.

Write the issue in the **House style** of `.claude/commands/session-wrap-up.md` (sentence-
case title, `##` sections, `path:line` citations, no labels), with these sections where
they fit:

- the overlap and the proposal;
- `## Behavior differences to settle`, as numbered decisions, not deletions;
- `## Callers to move`, by workspace;
- `## API break`: what changes for clients, for the PR description;
- device-persisted data, with the migration or rewrite (see **Ground rules**);
- `## Verification`: `task check`, plus `task test-server-postgres`
  when a store or query changes;
- `## Related`: the other tickets from the same review.

If re-verification shows a finding was wrong, say so instead of filing it. If the ticket
can record why (as a short `## Not included` section in a related ticket), offer to add
that.

Creation, confirmation, and failure handling follow the **Creating them** section of
`.claude/commands/session-wrap-up.md`. When the user asks for a ticket by number, that
request is the selection and the confirmation. Report each issue's number and URL, plus
anything the ticket-writing pass found that changes the original finding.

## Don't

- Don't change code, branch, or commit. This command only reports and files.
- Don't propose an alias, shim, or deprecation period for an API change.
- Don't report a duplicate before checking whether it is deliberate.
- Don't cite one copy of a duplication without the other.
- Don't turn a product-feature finding into a technical recommendation.
- Don't file anything the user didn't ask for.
