# Feature Spec: OIDC / SSO Login

Status: **Draft / proposal** — for discussion before implementation.
Owner: TBD · Target: Jot (self-hosted note app)
Tracking: [#796](https://github.com/hanzei/jot/issues/796)

---

## 1. Summary

Let a self-hosted Jot deployment delegate authentication to an existing OpenID
Connect (OIDC) identity provider (IdP) — Keycloak, Authentik, Dex, Entra ID,
Google Workspace, etc. A deployment gains one credential store instead of two
and inherits whatever MFA and offboarding the IdP already enforces.

The key architectural observation is that **everything below authentication is
already identity-agnostic**. `SessionService.CreateSession(w, r, userID)`
(`server/internal/auth/auth.go`) needs nothing but a resolved user ID; it is
called identically by `Login` and `Register`. OIDC adds a *third* way to arrive
at a `userID` — an authorization-code exchange against an IdP — and then reuses
the exact same server-side session machinery (the `jot_session` HttpOnly
cookie, the `sessions` table, 30-day sliding renewal). This is an
**authentication front-door addition, not a rework of the session or
authorization model**, which materially lowers its risk.

Scope of v1 is deliberately narrow: **webapp only**, **standard authorization
-code flow with PKCE**, **local `role` column stays authoritative**, and **OIDC
treated purely as an authentication event** (Jot keeps its own session
lifetime; no IdP token storage, refresh, or back-channel logout). Mobile is
phase 3, with its native hand-off designed in §10; group-based role mapping is
an explicit follow-up.

The issue also raised account recovery as a **secondary motivation**: at the
time Jot had no password-reset flow at all. That gap has since been closed for
the admin-operated case by [#977](https://github.com/hanzei/jot/pull/977)
(merged) — `PUT /api/v1/admin/users/{id}/password`, `jotctl users set-password`,
and an admin-page reset modal. SSO still *removes* the second credential store
for IdP-backed deployments, but it is no longer needed to close the recovery
gap. The only remaining recovery gap is **self-service** (a user resetting their
own password without an admin), which needs mail infrastructure Jot does not
have and is out of scope here — see §12.

---

## 2. Goals / Non-goals

**Goals (v1)**
- Configure a single OIDC provider via `JOT_OIDC_*` environment variables,
  validated in `internal/config`.
- Render a "Sign in with {provider}" button on the webapp login screen, driven
  by a new field on `GET /api/v1/config` (no client-side hardcoding).
- Authorization-code flow with PKCE and `state`/nonce validation; on success,
  match or auto-provision a local user and issue a normal Jot session.
- Match returning users on the stable `(issuer, subject)` claim pair via new
  `users` columns, in **both** migration dialect trees.
- Let a user with a local account **self-service link** an SSO identity to it
  (prove local password + authenticate at IdP), and unlink it (§5).
- Mixed mode: local password login can stay enabled alongside OIDC, or be
  disabled entirely for SSO-only deployments.
- PATs continue to work for an SSO-provisioned user who has no local password.
- Backwards compatible: a deployment that sets no `JOT_OIDC_*` vars behaves
  exactly as today.

**Non-goals (v1)**
- Mobile OIDC in the webapp v1 build. Its design is settled in §10 (a
  one-time code hand-off) and it ships as phase 3.
- Group/claim-based role mapping (IdP group → admin). Local role authoritative
  in v1; revisit in v2 (§6).
- RP-initiated (back-channel/front-channel) logout, IdP session revocation,
  token refresh, or storing IdP access/refresh tokens (§8).
- Multiple simultaneous OIDC providers. One provider per deployment in v1.
- Automatic linking of an SSO identity to a pre-existing *local* account by
  email (account-takeover risk — see §5).
- SAML or any non-OIDC protocol.

---

## 3. Authentication flow (webapp)

Standard OIDC authorization-code flow with PKCE, all redirects server-side so
the browser only ever holds the resulting `jot_session` cookie:

1. Login page shows a provider button linking to `GET /api/v1/auth/oidc/login`.
2. That handler generates `state`, `nonce`, and a PKCE `code_verifier`, stores
   them (short-lived, HttpOnly cookie or server-side), and 302-redirects to the
   IdP `authorization_endpoint`.
3. The IdP authenticates the user and redirects back to
   `JOT_OIDC_REDIRECT_URL` → `GET /api/v1/auth/oidc/callback?code=…&state=…`.
4. The callback validates `state`, exchanges `code` (+ `code_verifier`) for
   tokens at the `token_endpoint`, verifies the ID token signature against the
   IdP JWKS and checks `iss`/`aud`/`exp`/`nonce`.
5. From the verified ID token claims, resolve or provision the local user
   (§5), then call the **existing** `SessionService.CreateSession` and
   302-redirect to the app root.
6. Logout is unchanged: local session delete only (§8).

The `state`/nonce/verifier round-trip is the one piece of new transient state.
Recommend a single short-lived (`~10 min`) HttpOnly, `SameSite=Lax` cookie
holding a signed/opaque handle to server-held values, so the callback is
stateless-friendly but not forgeable. `SameSite=Lax` (not `Strict`) is required
because the callback is a top-level cross-site navigation *from* the IdP.

Library: **`coreos/go-oidc/v3`** (discovery, JWKS, ID-token verification) on top
of **`golang.org/x/oauth2`**, which is already a transitive dependency. `go-oidc`
would be the only genuinely new direct dependency (`update-server-deps` owns the
Go module surface).

---

## 4. Configuration surface

New `JOT_`-prefixed variables, parsed and validated in `internal/config`
alongside the existing knobs. OIDC is **all-or-nothing**: if any core var is
set, the required set must all be present or `Load()` fails fast at startup
(consistent with how the package already rejects bad enums/ranges).

| Variable | Required | Default | Notes |
|---|---|---|---|
| `JOT_OIDC_ISSUER` | yes* | — | Issuer URL; discovery doc fetched at startup |
| `JOT_OIDC_CLIENT_ID` | yes* | — | |
| `JOT_OIDC_CLIENT_SECRET` | yes* | — | Confidential client (server-side flow) |
| `JOT_OIDC_REDIRECT_URL` | yes* | — | Must match an IdP-registered redirect URI |
| `JOT_OIDC_PROVIDER_NAME` | no | `"SSO"` | Button label, surfaced via `/config` |
| `JOT_OIDC_SCOPES` | no | `openid profile email` | Space-separated |
| `JOT_OIDC_USERNAME_CLAIM` | no | `preferred_username` | Claim used to seed a new username |
| `JOT_LOCAL_LOGIN_ENABLED` | no | `true` | `false` hides the password form entirely |

\* Required only when OIDC is enabled; "enabled" ≡ any of the four core vars set.

New `config.Config` fields mirror these. Validation rules:
- All four core vars present together, or none.
- `JOT_OIDC_ISSUER` / `JOT_OIDC_REDIRECT_URL` parse as absolute URLs.
- If `JOT_LOCAL_LOGIN_ENABLED=false` then OIDC **must** be enabled, otherwise the
  deployment has no way to authenticate anyone — reject at startup.

Discovery (`<issuer>/.well-known/openid-configuration`) and JWKS fetch happen
once at server construction (`server.NewWithLogger`); a failure there is a
startup error, not a per-request surprise. This does add a network dependency to
boot when OIDC is enabled — acceptable, and symmetric with how a bad DB DSN
fails startup today.

---

## 5. Account model, linking & provisioning

**New `users` columns** (both dialect trees, one migration `000011`):

- `oidc_issuer TEXT` — nullable; the `iss` the subject belongs to.
- `oidc_subject TEXT` — nullable; the IdP `sub` claim, stable and opaque.
- Unique index on `(oidc_issuer, oidc_subject)` where both are non-null
  (partial index on Postgres; SQLite treats multiple NULLs as distinct, so a
  plain unique index also permits many local-only users — verify parity per the
  cross-backend rules in `CLAUDE.md`).

**`password_hash` becomes nullable (decided).** Today it is `NOT NULL`
(`000001`). An SSO-only user has no password. The options considered were:

- **A (chosen): make `password_hash` nullable.** A NULL hash never authenticates
  a password login — `CheckPassword` already returns false for a bad compare,
  and Login's timing-equalizer path (`CheckPasswordDummy`) is unaffected. The
  schema stays honest: a user with no local password has NULL, not a fabricated
  value.
- B: keep `NOT NULL` and store `''` (empty string) for SSO users. Identical
  runtime behavior with no schema change — but was rejected in favor of A's
  schema honesty. **Note the cost of that choice: relaxing `NOT NULL` on SQLite
  forces a full rebuild of the `users` table (§11), which is the single riskiest
  step in this whole change.** A is the deliberate call to pay that cost for a
  truthful column rather than encode "no password" as an empty string.

Whether a user has a local password is determined by `oidc_subject IS NOT NULL`
(an SSO-provisioned account), never by inspecting the hash — so no code path
depends on distinguishing NULL from any other hash value.

**Matching key: `(issuer, sub)`.** `sub` is the only claim guaranteed stable and
unique per user at an IdP. `email`/`preferred_username` can change or be reused
and are therefore used only to *seed* a human-readable username on first login,
never as the match key.

**First-login provisioning (auto-provision):**
1. Verify ID token → `(iss, sub)`.
2. `SELECT ... WHERE oidc_issuer = ? AND oidc_subject = ?`. Hit → that user;
   issue session. Done.
3. Miss → provision: derive a candidate username from `JOT_OIDC_USERNAME_CLAIM`
   (fall back to `email` local-part, then `sub`), lower-case it to satisfy the
   username rules (#778), and de-duplicate on collision (append `-2`, `-3`, …).
   Insert with `password_hash = NULL`, `oidc_issuer`, `oidc_subject`, and role
   per §6. Issue session.

**Linking to a pre-existing local account: self-service only (decided).** SSO
login **never auto-matches** an incoming identity to a local account — not by
email, not by `preferred_username`. Auto-matching would delegate an authz
boundary to a claim the IdP controls (an attacker-controlled or reassigned
email/handle would land on someone else's notes), and Jot stores no email today
anyway. Instead, the *only* way an SSO identity binds to an existing local
account is that **the user proves control of both sides**:

1. The user signs in to their local account with their password (proving local
   ownership).
2. From Settings → "Connect SSO", they run the OIDC flow.
3. On the callback, Jot binds `(issuer, sub)` to the **currently authenticated
   user** — the session already establishes *which* local account, so no claim
   is trusted to identify it.

This needs no email column and no IdP-email trust; it is the strongest available
proof. Mechanics:

- **Endpoints:** `GET /api/v1/auth/oidc/link` (authenticated) starts a
  link-intent flow; the shared `…/callback` reads a *link* intent + the user id
  from its signed state and performs the bind instead of a login.
  `POST /api/v1/auth/oidc/unlink` (authenticated) clears the columns.
- **Guards:**
  - If the incoming `(issuer, sub)` is already bound to a *different* user, the
    unique index rejects it → "this SSO identity is already linked to another
    account." Never silently rebind.
  - **Unlink may not strand an account.** A user whose `password_hash` is NULL
    (SSO-provisioned, never had a password) cannot unlink their only credential;
    require setting a password first. A user who linked SSO onto an existing
    local account still has their password, so unlink is safe for them — but
    only while local login is enabled. When `JOT_LOCAL_LOGIN_ENABLED=false` a
    password cannot sign in, so SSO is every account's only credential:
    unlink is refused with 403 before the store is touched, whatever
    `password_hash` holds. (Otherwise the next SSO login would find no bound
    user and provision a fresh, empty account, orphaning the original.)
    Clients hide Disconnect in that mode.
  - Linking requires local login to be enabled (step 1 needs it). When
    `JOT_LOCAL_LOGIN_ENABLED=false`, there is no local side to prove, so linking
    is not offered and only provisioning (below) applies.

**Fallback when no link exists:** a first SSO login with no `(issuer, sub)` match
provisions a **new** account (the provisioning steps above). Consequence to
document for users: *link before your first SSO login.* Someone who signs in via
SSO first gets a second, empty account; recovering from that (merging the two)
is out of scope for v1 — an admin can reassign or the user can re-share, and a
merge tool is a possible later addition.

Deferred (not v1, noted for direction): auto-link by **verified** email
(`email_verified` gated, opt-in flag) for bulk migration of an existing local
userbase — it requires first adding and populating an `email` column and
accepting single-trusted-IdP email trust, so it is a separate effort (§15).

---

## 6. Role mapping & the admin bootstrap

**v1: the local `role` column stays authoritative.** The IdP authenticates; Jot
decides who is admin. No claim/group mapping config to get wrong, and it matches
the existing model where `role` is managed via `PUT /admin/users/{id}/role` and
`jotctl users set-role`.

**Bootstrap.** Today `userStore.Create` counts rows and makes the first user
admin. That logic must be shared with the OIDC provisioning path, not duplicated:

- If local login is enabled and a local admin already exists, an SSO-provisioned
  user is a plain `user`; an admin promotes them as usual.
- If the deployment is **SSO-only from day one** (`JOT_LOCAL_LOGIN_ENABLED=false`,
  no users yet), the *first* SSO-provisioned user becomes admin, mirroring the
  existing "first registered user is admin" rule. Otherwise an SSO-only
  deployment could never obtain its first administrator.

**v2 (non-goal here):** optional `JOT_OIDC_ADMIN_GROUP` mapping an IdP group
claim to admin, with a defined "claim absent" fallback and a decision on whether
the IdP or the local column wins on conflict. Deferred deliberately — it couples
Jot to IdP group naming and needs careful precedence rules.

---

## 7. `GET /api/v1/config` addition

`configResponse` (`server/internal/server/server.go`) gains one nested,
backwards-compatible field:

```json
{
  "registration_enabled": true,
  "password_min_length": 10,
  "upload_max_bytes": 26214400,
  "sso": {
    "enabled": true,
    "provider_name": "Keycloak",
    "local_login_enabled": true
  }
}
```

`sso.enabled` is `false` (or the object omitted) when no provider is configured —
old clients ignore the field entirely. The webapp `App.tsx` boot fetch already
reads this endpoint; it threads `sso` into `Login` to decide whether to render
the provider button and whether to keep the password form
(`local_login_enabled`). No client secret or issuer internals are ever exposed
here — only what the login UI needs to render.

The client SDK type (`server/client/types.go`) and the generated Swagger docs
(`task gen-docs`) update alongside.

---

## 8. Session & logout semantics

**OIDC is treated purely as an authentication event.** After the callback issues
a Jot session, the IdP is out of the loop:

- Jot keeps its own 30-day sliding session (`SessionDuration` / renewal window),
  unchanged.
- No IdP access/refresh tokens are stored; no refresh loop.
- Logout deletes the local Jot session only. **No RP-initiated logout** (redirect
  to the IdP `end_session_endpoint`) in v1 — it is a nice-to-have that surprises
  users by logging them out of every other IdP-backed app, and it adds
  front/back-channel plumbing for little benefit to a note app.

Consequence to document for operators: disabling or deleting a user at the IdP
does **not** immediately kill their live Jot session — it lasts until expiry or
an admin revokes it (`DELETE /sessions/{id}` / delete the user). This is the
correct, simple default for a note app and matches the current model where a
password change is what invalidates sessions. If a deployment needs
IdP-driven revocation, that is a v2 conversation (short session lifetime, or
back-channel logout).

---

## 9. PATs (machine-to-machine)

PATs remain the machine-to-machine path and are **unaffected**. Confirmed from
the routing: `POST /pats` sits behind `SessionRequired` (a valid session cookie)
and never reads the password. An SSO-provisioned, password-less user with a live
session can therefore create and use PATs exactly like a local user. The only
requirement is that provisioning issues a real session (it does), which it must
for the user to reach any authenticated screen anyway. Add a regression test for
"SSO-provisioned user creates a PAT" (§13).

---

## 10. Mobile — native hand-off (phase 3)

Mobile is outside the webapp v1 build, but its security model is settled here
so it can be built as a follow-up without re-deciding it.

### 10.1 Why the web flow does not transfer

Mobile authenticates by capturing the `jot_session` token from the
`Set-Cookie` of `POST /login`, keeping it in Expo Secure Store, and replaying it
as a `Cookie` header (`mobile/src/api/client.ts`). The web OIDC flow ends by
setting that cookie *inside the browser* and redirecting to the web root; a
system browser sheet opened by the app has no way to hand that cookie back.
Native needs its own ending: the server returns something to the app through
the app's `jot://` scheme (already registered in `mobile/app.json`; see
`docs/specs/deep-linking.md`).

That custom-scheme redirect is the weak link. On Android any installed app can
register `jot://` and receive it, and URLs end up in browser history and logs.
So nothing usable on its own may travel in that URL.

### 10.2 Decision: one-time code, bound to an app-held secret

Options considered:

- **Session token in the redirect** — least work, but a leaked redirect hands
  over a 30-day, self-renewing session. Rejected.
- **Mint a PAT** — answers *which* credential, not *how it travels* (it still
  needs one of the other transports), and a PAT-authenticated app loses the
  session-only endpoints (Sessions, PAT management, SSO link/unlink). PATs also
  never expire or slide, count toward the per-user PAT cap, and clutter the
  PAT list with one entry per phone login. Rejected.
- **One-time code with a PKCE-style binding** (RFC 7636, S256) — chosen. A
  redirect caught by another app is worthless even inside the code's lifetime,
  and mobile stays on the session model it uses today.

### 10.3 Flow

1. The app generates a random `code_verifier` (43–128 characters), keeps it in
   memory alongside which server the flow targets, and computes
   `code_challenge = BASE64URL(SHA256(code_verifier))`.
2. The app opens
   `GET /api/v1/auth/oidc/native/start?intent=login|link&code_challenge=…`
   with `WebBrowser.openAuthSessionAsync(url, "jot://oidc-callback")`. This
   reuses the web flow's machinery (signed flow cookie holding
   state/nonce/verifier, 302 to the IdP), with the flow state additionally
   marked *native* and carrying the intent and `code_challenge`. It is
   unauthenticated even for `link` — the browser sheet has no Jot session —
   because authorization happens at step 5. It sits in the per-IP auth
   rate-limit bucket with the other unauthenticated auth endpoints.
3. The IdP redirects to the **existing** `JOT_OIDC_REDIRECT_URL` callback. No
   new IdP client registration or redirect URI is needed.
4. The callback verifies the ID token exactly as today but, for a native flow,
   **performs no effect**: no provisioning, no bind, and no `jot_session` in the
   browser. It stores a one-time code record
   `{ code_hash, issuer, sub, the claims provisioning needs, intent,
   code_challenge, expires_at = now + 60 s }` and 302s to
   `jot://oidc-callback?code=…` (or `jot://oidc-callback?error=…` on failure).
   The target is a server constant, never taken from the request, so the
   server is not an open redirect.
5. The app, back in the foreground, completes by intent:
   - **login** → `POST /api/v1/auth/oidc/native/exchange
     { code, code_verifier }` (per-IP auth bucket, unauthenticated). In one
     atomic step the server looks the code up and checks that it has not
     expired, that its intent is `login`, and that
     `BASE64URL(SHA256(code_verifier))` equals the stored `code_challenge`;
     only when every check passes does it consume the code. A failed check
     leaves the code in place, so an attempt with a wrong verifier or at the
     wrong endpoint cannot burn it before the legitimate app exchanges it.
     Leaving it available gives nothing to attack: guessing a random verifier
     within the code's 60-second life, under the per-IP rate limit, is not
     feasible. The server then runs the same
     resolve-or-provision as the web callback (§5, §6) and the existing
     `SessionService.CreateSession`. The response is identical to
     `POST /login` — `Set-Cookie: jot_session` plus `{ user, settings }` — so
     mobile's existing capture-and-store path applies unchanged. Because the
     app makes this request, the new session carries the app's user agent in
     the Sessions list.
   - **link** → `POST /api/v1/auth/oidc/native/link { code, code_verifier }`
     (session required, via the app's `Cookie` header). The same
     check-then-consume step, with intent `link`, then binds
     the identity to the **session's** user with all the §5 guards (an identity
     already bound to another user is rejected). Returns 204; the app refreshes
     `/me` for `has_sso_linked`.

Unlink needs nothing new: `POST /api/v1/auth/oidc/unlink` is already a plain
session-authenticated JSON call.

### 10.4 Security properties

- **Leaked redirect** → a code that is useless without the verifier, which
  never left the app.
- **Leaked start URL** → harmless: whoever completes it gets a code bound to a
  challenge they cannot satisfy.
- **Injected `jot://oidc-callback?code=…`** (login CSRF) → the app only
  exchanges while it has a pending flow, and a foreign code fails the verifier
  check.
- **Native link without an authenticated browser** → safe because every effect
  is deferred to the exchange: the bind is authorized by the app's own session
  at step 5, not by whoever is in the browser sheet.
- **Codes** are single-use, expire after 60 s, are stored hashed, accept S256
  only, and are intent-scoped (a login code is rejected at `/native/link` and
  vice versa). A failed exchange does not consume the code; only a fully
  successful check does.

### 10.5 Code storage

An in-memory, size-bounded map with expiry sweeping. Jot is single-process —
the rate limiter and the SSE hub already keep their state in memory — and a
restart only drops codes younger than a minute (the user retries). The bound
keeps a runaway client from growing the map (threat model: internal overload);
the per-IP auth rate limit already covers start and exchange. If Jot ever runs
as multiple replicas, this moves to the database together with the rate
limiter.

### 10.6 Mobile client

- **Dependencies:** `expo-web-browser` (the auth session) and `expo-crypto`
  (SHA-256), added with `npx expo install` so the Expo SDK pins their versions.
  `expo-auth-session` is not needed: the app is not an OIDC client, it only
  opens a URL and receives a redirect.
- **Deep-link routing:** `jot://oidc-callback` belongs to the auth session. The
  deep-link router (`docs/specs/deep-linking.md`) must ignore it rather than try
  to route it as a note link.
- **Multi-server:** the pending flow records which server it started against,
  and the exchange goes there. Nothing about the server travels in the redirect.
- **Login screen:** SSO button when that server's `/config` has
  `sso.enabled`; hide the password form when `sso.local_login_enabled` is
  false. `ServerConfig.sso` is already optional in `@jot/shared`; the
  cached-config parser in `useServerConfig.ts` must carry it through.
- **Settings:** connect/disconnect driven by `has_sso_linked`, as in the webapp.
- **Connectivity:** SSO login is an auth one-shot op under
  `docs/specs/mobile-connectivity-handling.md` §4.3 — a finite timeout on the
  exchange, a visible pending state, and a clear terminal error. The user
  dismissing the browser sheet is a quiet return to the login screen, not an
  error.

### 10.7 Tests

- **Server** (mock issuer, like the web tests): native start marks the flow and
  sets no `jot_session`; the callback issues a code and redirects to
  `jot://oidc-callback`; exchange succeeds once and fails on reuse, expiry, a
  wrong verifier, and an intent mismatch; a wrong-verifier or wrong-intent
  attempt leaves the code usable, so the correct exchange still succeeds
  afterwards (at both `/native/exchange` and `/native/link`); the verifier
  check compares `BASE64URL(SHA256(code_verifier))` with `code_challenge`, so
  presenting the challenge itself, or a hex-encoded digest, as the verifier
  fails; `/native/link` requires a session and
  binds to the session's user with the §5 guards; start rejects a missing or
  malformed challenge.
- **Mobile** (Jest): verifier/challenge generation; the login and link paths
  with `openAuthSessionAsync` mocked for success, user cancel, and `?error=`;
  the deep-link router ignoring `oidc-callback`. A Maestro device flow needs a
  live IdP and is a follow-up.

### 10.8 Phasing

Two PRs, mirroring v1: (1) the server native hand-off (§10.3–10.5 and the
server tests), then (2) the mobile client (§10.6 and the mobile tests) once (1)
has merged.

---

## 11. Migrations & backward compatibility

- **`000011_add_oidc_identity`** in both `migrations/sqlite/` and
  `migrations/postgres/`, same filename in each (the `migrations` CI job diffs
  the trees). Each migration does three things: add `oidc_issuer` +
  `oidc_subject`, add the `(oidc_issuer, oidc_subject)` unique index, and relax
  `password_hash` to nullable.
- The **two new columns and the index are trivial and safe on both backends** —
  `ALTER TABLE users ADD COLUMN …` (SQLite supports adding a nullable column
  with no rebuild) plus `CREATE UNIQUE INDEX …`.
- **Relaxing `password_hash` to nullable is the risky part, and only on SQLite.**
  - Postgres: `ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL` —
    one line, safe.
  - SQLite has no "drop NOT NULL", so the only route is the table-rebuild
    pattern already used by `000008` (create `users_new`, copy, drop, rename).
    But `000008` rebuilt `note_shares`, a **child** table nothing references.
    `users` is the schema's most-referenced **parent** table, and two hazards
    make its rebuild materially more dangerous:

    1. **FK cascades on `DROP TABLE`.** `notes`, `note_items`, `note_shares`,
       `note_images`, `sessions`, and `pats` reference `users` with
       `ON DELETE CASCADE`. With `PRAGMA foreign_keys = ON` (set at startup in
       `database.go`), SQLite performs an implicit `DELETE` of all rows before
       dropping the table — so `DROP TABLE users` would **cascade-delete every
       user's notes**. The rebuild must therefore run with `foreign_keys = OFF`.
    2. **The pragma cannot be toggled inside the migration.** golang-migrate's
       SQLite driver wraps each migration in a transaction, and SQLite ignores
       `PRAGMA foreign_keys` changes issued inside one. So a
       `PRAGMA foreign_keys=OFF;` line at the top of the `.up.sql` is a silent
       no-op.

  - **Proposed mitigation** (validate during implementation): move the startup
    `PRAGMA foreign_keys = ON` in `database.go` to run **after** `runMigrations`
    rather than before it. SQLite's default for a fresh connection is
    `foreign_keys = OFF`, which is also the state the SQLite docs recommend for
    schema-change rebuilds, so migrations run with enforcement off and the
    `users` rebuild's `DROP` no longer cascades. Follow the rebuild with a
    `PRAGMA foreign_key_check` (run outside the migrate transaction, e.g. as a
    post-migration step beside `backfillLabelNameFolded`) to prove no dangling
    references were introduced, then enable enforcement for normal operation.
    This is a small, contained change to startup ordering but it alters a
    startup invariant, so it needs its own review and a test that a **user with
    notes, shares, and a session survives the migration intact**.
  - Keep the two dialects behavior-equivalent, not SQL-identical (per the
    migrations guidance in `CLAUDE.md`): both must end with a nullable
    `password_hash`, the two new columns, and the unique index.
- `users` gains no new *timestamp* columns, so `timestampColumnsByTable` is
  unaffected; confirm the parity test still passes.
- **Fully backward compatible at runtime:** no `JOT_OIDC_*` set ⇒ `sso.enabled`
  false, login screen and every existing flow unchanged. Existing local accounts
  keep working with local login. This is an additive, non-breaking change — no
  entry required under the Development Status Notice's API-break callout, though
  the new `/config` field and env vars get documented (README + this spec).

---

## 12. Local password reset (already shipped — context only)

The issue framed a missing password-reset flow as a sharp secondary reason to
want SSO. That is **already addressed for the admin-operated case** by
[#977](https://github.com/hanzei/jot/pull/977) (merged): an admin can set any
user's password via `PUT /api/v1/admin/users/{id}/password`, from the webapp
admin page or `jotctl users set-password` (with `--generate`), and the reset
invalidates the target's existing sessions. So OIDC does **not** need to carry
any part of account recovery, and this spec no longer proposes a `jotctl` reset
command as phase 1.

The only recovery gap left is **self-service** reset — a user recovering their
own account with no admin involved — which requires mail infrastructure Jot does
not have. That is a larger, separate discussion (SMTP config, tokened reset
links, rate limiting) and is out of scope for both this spec and OIDC. SSO
happens to sidestep it for IdP-backed deployments by moving credentials to the
IdP, which is a benefit but not the justification for this work.

---

## 13. Testing

- **Config:** table-driven `internal/config` tests for the all-or-nothing
  validation, the `local_login_enabled=false` + OIDC-disabled rejection, and URL
  parsing.
- **Store/migration:** `(oidc_issuer, oidc_subject)` uniqueness and the nullable
  `password_hash` behavior, run against SQLite unconditionally and Postgres when
  `TEST_POSTGRES_DSN` is set (per the store-test harness). **Plus a dedicated
  SQLite `users`-rebuild survival test** (§11): seed a user with notes, a share,
  a note image, and a session, run the migration, and assert every dependent row
  is intact and no cascade fired — this is the migration's highest-risk failure
  mode.
- **Handler/integration** (`http_*_test.go`, each `t.Parallel()`): the callback
  against a **mock OIDC issuer** (a small in-test JWKS + signed ID token — no
  real network), covering first-login provisioning, returning-user match,
  username de-duplication, and the SSO-only first-user-is-admin bootstrap.
- **PAT regression:** an SSO-provisioned (password-less) user creates and uses a
  PAT.
- **Self-service linking:** a logged-in local user links an SSO identity and can
  then log in via SSO to the same account; linking an `(issuer, sub)` already
  bound to another user is rejected; unlink is blocked for a password-less user
  and allowed once a password exists, and is refused (403) on an SSO-only
  server even when the account has a password.
- **Webapp:** `Login` renders the provider button from `sso`, hides the password
  form when `local_login_enabled` is false; a Vitest unit test plus an **e2e
  spec** (required for a new user-facing flow — CLAUDE.md), which can point at a
  containerized Dex/Keycloak or a stub authorize endpoint.
- **Prototype gate:** before committing to the full surface, stand up Dex (or
  Keycloak) in a container and drive the webapp flow end to end, as the issue
  asks.

---

## 14. Phasing

1. **This design doc** — agree the open decisions in §15.
2. **Webapp OIDC v1** — config + migration + callback + `/config` + login UI,
   local role authoritative, mixed mode, no RP logout. Prototype against Dex
   first, then harden.
3. **Mobile OIDC** — two PRs per §10.8: the server native hand-off, then the
   mobile client.
4. **v2, if wanted** — group→role mapping, explicit account linking UI,
   RP-initiated logout / IdP-driven revocation.

(Admin-initiated password reset, previously a phase-0 item, already shipped in
[#977](https://github.com/hanzei/jot/pull/977) — see §12.)

---

## 15. Open decisions for review

1. ~~Pre-existing local account linking~~ **Resolved:** v1 ships **self-service
   linking** (§5) — the user proves local password + IdP auth; no auto-match, no
   email column. First SSO login with no link provisions a new account.
   Verified-email auto-link stays a deferred, opt-in bulk-migration feature.
2. ~~Default `provider_name`~~ **Resolved:** defaults to `"SSO"` when unset (not
   required). (§4)
3. ~~`local_login_enabled` default~~ **Resolved:** defaults to `true` — mixed
   mode (local + SSO) out of the box.
4. ~~Self-service / email-based password reset~~ **Resolved: not now.**
   Admin-initiated reset (#977) is sufficient; a self-service/email reset flow
   is not pursued at this time (and would be independent of OIDC regardless).
5. ~~Adopt vs. defer~~ **Resolved: adopt, phased.** The build proceeds per §14,
   webapp-first. (Note: #977 already closed the account-recovery motivation, so
   OIDC now stands on the single-credential-store / inherit-IdP-MFA-and-
   offboarding merits alone.)
