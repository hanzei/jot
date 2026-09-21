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
lifetime; no IdP token storage, refresh, or back-channel logout). Mobile and
group-based role mapping are explicit follow-ups.

There is a sharp **secondary motivation**: Jot has no password-reset flow at
all. A user who forgets their password today cannot be recovered without direct
database manipulation. SSO sidesteps this for deployments with an IdP, but not
for everyone else. This spec recommends shipping a small `jotctl` admin
password-reset command **independently** of OIDC (§12) rather than letting the
recovery gap ride on this larger surface.

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
- Mixed mode: local password login can stay enabled alongside OIDC, or be
  disabled entirely for SSO-only deployments.
- PATs continue to work for an SSO-provisioned user who has no local password.
- Backwards compatible: a deployment that sets no `JOT_OIDC_*` vars behaves
  exactly as today.

**Non-goals (v1)**
- Mobile OIDC (native flow needs `expo-auth-session` + a redirect scheme; the
  cookie model does not transfer cleanly — see §10). Explicit follow-up.
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

**`password_hash` must become nullable.** Today it is `NOT NULL` (`000001`). An
SSO-only user has no password. Options:

- **A (recommended): make `password_hash` nullable.** `CheckPassword` already
  returns false for a bad compare; an empty/NULL hash simply never authenticates
  a password login, which is exactly right for an SSO-only account. Login's
  timing-equalizer path (`CheckPasswordDummy`) is unaffected.
- B: store a sentinel unusable hash. Avoids the migration but is a lie in the
  schema and invites a future bug where something treats it as real. Rejected.

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

**Linking to a pre-existing local account is NOT automatic in v1.** If someone
already has local account `ben` and later signs in via SSO with an email that
resolves to `ben`, we do **not** silently attach the SSO identity — that is an
account-takeover vector if the IdP's email is attacker-controlled or
mis-configured. Two acceptable v1 stances:

- Provision a *new* distinct account (safe, but can surprise a user who expected
  to land on their existing notes).
- Provide an **admin-driven or self-service explicit link** (user proves control
  of the local account by logging into it, then links SSO from settings) — nicer
  UX, more work. Recommend shipping the safe auto-provision in v1 and filing
  explicit linking as a fast follow.

Open question for review: which of the two above is the v1 default? (§15)

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

## 10. Mobile (explicit follow-up, out of scope for v1)

The RN app supports multiple servers and stores credentials in Expo Secure
Store; today it has `expo-secure-store` but **not** `expo-auth-session` or
`expo-web-browser`. A native OIDC flow needs:

- `expo-auth-session` + `expo-web-browser` for the system-browser
  authorization-code + PKCE flow.
- A registered redirect scheme (`jot://oidc-callback` or a universal link),
  coordinated with the deep-linking spec (`docs/specs/deep-linking.md`).
- A decision on the session token model: the webapp relies on an HttpOnly
  cookie, which does not transfer cleanly to a native client. The likely answer
  is that the OIDC callback mints a **PAT-like bearer token** (or a session
  token returned in the body rather than a cookie) that mobile stores in Secure
  Store — a different transport from the webapp, and precisely why this is its
  own body of work.

Scope v1 webapp-first and file mobile OIDC as a separate issue rather than
pretending they are one piece of work.

---

## 11. Migrations & backward compatibility

- **`000011_add_oidc_identity`** in both `migrations/sqlite/` and
  `migrations/postgres/`, same filename in each (the `migrations` CI job diffs
  the trees). Adds `oidc_issuer`, `oidc_subject`, the partial-unique index, and
  relaxes `password_hash` to nullable.
  - SQLite has no `ALTER COLUMN`; dropping `NOT NULL` requires the
    table-rebuild dance (create new table, copy, drop, rename) or was already
    permissive enough to sidestep — verify against the actual `000001` DDL and
    keep the two dialects behavior-equivalent, not SQL-identical (per the
    migrations guidance in `CLAUDE.md`).
- `users` is not in `timestampColumnsByTable` territory for new *timestamp*
  columns (none added here), but confirm the parity test still passes.
- **Fully backward compatible at runtime:** no `JOT_OIDC_*` set ⇒ `sso.enabled`
  false, login screen and every existing flow unchanged. Existing local accounts
  keep working with local login. This is an additive, non-breaking change — no
  entry required under the Development Status Notice's API-break callout, though
  the new `/config` field and env vars get documented (README + this spec).

---

## 12. Local password reset (independent, recommended alongside)

SSO does not solve account recovery for password-only deployments. Rather than
couple that gap to this large surface, ship a small admin tool **independently**:

- `jotctl users set-password <username>` (and/or `reset-password` that prints a
  generated one). Reuses `userStore.UpdatePassword`, which already exists and
  already invalidates nothing on its own — pair it with session invalidation as
  `ChangePassword` does.
- No email/SMTP dependency, no public reset endpoint, no new attack surface —
  fits a self-hosted admin-operated model.

A self-service, email-based reset flow is a larger, separate discussion (Jot has
no mail transport today). Recommend filing the `jotctl` command as its own issue
and doing it first, since it is small and unblocks the recovery gap for everyone
regardless of whether OIDC is adopted.

---

## 13. Testing

- **Config:** table-driven `internal/config` tests for the all-or-nothing
  validation, the `local_login_enabled=false` + OIDC-disabled rejection, and URL
  parsing.
- **Store/migration:** `(oidc_issuer, oidc_subject)` uniqueness and the nullable
  `password_hash` behavior, run against SQLite unconditionally and Postgres when
  `TEST_POSTGRES_DSN` is set (per the store-test harness).
- **Handler/integration** (`http_*_test.go`, each `t.Parallel()`): the callback
  against a **mock OIDC issuer** (a small in-test JWKS + signed ID token — no
  real network), covering first-login provisioning, returning-user match,
  username de-duplication, and the SSO-only first-user-is-admin bootstrap.
- **PAT regression:** an SSO-provisioned (password-less) user creates and uses a
  PAT.
- **Webapp:** `Login` renders the provider button from `sso`, hides the password
  form when `local_login_enabled` is false; a Vitest unit test plus an **e2e
  spec** (required for a new user-facing flow — CLAUDE.md), which can point at a
  containerized Dex/Keycloak or a stub authorize endpoint.
- **Prototype gate:** before committing to the full surface, stand up Dex (or
  Keycloak) in a container and drive the webapp flow end to end, as the issue
  asks.

---

## 14. Phasing

1. **`jotctl` admin password reset** — independent, small, unblocks recovery now
   (§12). Its own issue/PR.
2. **This design doc** — agree the open decisions in §15.
3. **Webapp OIDC v1** — config + migration + callback + `/config` + login UI,
   local role authoritative, mixed mode, no RP logout. Prototype against Dex
   first, then harden.
4. **Mobile OIDC** — separate issue (§10).
5. **v2, if wanted** — group→role mapping, explicit account linking UI,
   RP-initiated logout / IdP-driven revocation.

---

## 15. Open decisions for review

1. **Pre-existing local account + matching SSO email:** provision a *new*
   distinct account (safe default), or build explicit self-service linking for
   v1? (§5)
2. **Default `provider_name`** when unset — `"SSO"`, or require it when OIDC is
   enabled?
3. **`local_login_enabled` default** — keep `true` (mixed mode by default) as
   proposed, agreed?
4. Confirm the recommendation to **ship `jotctl` password reset independently and
   first**, and whether a public/email-based reset flow is wanted at all given
   there is no mail transport today.
5. **Adopt vs. defer:** this spec recommends *adopt, phased* rather than "not
   yet". Confirm.
