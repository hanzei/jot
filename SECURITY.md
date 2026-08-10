# Security Policy

Jot is self-hosted software that stores users' notes and images behind an
authentication boundary. If you have found a way to cross that boundary, we
want to hear about it privately first.

## Reporting a vulnerability

**Please do not open a public issue for a security report.**

Report it through GitHub's private vulnerability reporting:

**<https://github.com/hanzei/jot/security/advisories/new>**

That submits a private report visible only to you and the maintainers. It starts
in **Triage** — it is not yet a published or draft advisory. A maintainer
reviews it and, if the issue is confirmed, accepts the report, which is what
creates the draft security advisory the fix is then coordinated through.

If you cannot use that channel for any reason, open a public issue containing
only "I would like to report a security issue, please enable a private channel"
— with no details — and you will be invited to a private advisory.

A useful report includes:

- What an attacker can do that they should not be able to do — reading another
  user's note, escalating to admin, bypassing a share boundary.
- The version or commit you tested, and whether SQLite or Postgres.
- The steps to reproduce it, ideally against a fresh `docker compose up`.
- Any relevant configuration you changed from the defaults.

Proof-of-concept code is welcome but not required. A clear description of the
flaw is worth more than a working exploit.

## What to expect

Jot is a small project maintained in spare time. These are honest targets, not
guarantees backed by an on-call rotation:

| Stage | Target |
| --- | --- |
| Acknowledgement that your report was received | 7 days |
| Initial assessment — in scope, severity, whether it reproduces | 14 days |
| Fix released for a confirmed issue | 90 days |

If a report is confirmed and turns out to be serious, it jumps the queue ahead
of feature work. If you have not heard anything after 14 days, feel free to
nudge the advisory thread — it means the notification was missed, not that the
report was dismissed.

## Supported versions

Jot is pre-1.0 and ships releases frequently. **Only the most recent release is
supported.**

| Version | Supported |
| --- | --- |
| Most recent release (`hanzei/jot:latest` / `:stable`) | ✅ |
| Any earlier release | ❌ |
| `hanzei/jot:unstable` (built from `master`) | Best effort — fixes land here first |

Security fixes ship **forward**, in the next release. There are no maintenance
branches and no backports to earlier minor versions: if you are on an older
release, the upgrade path is to move to the current one. Practically, that means
self-hosters should plan to update rather than pin — running a version several
releases behind means running without fixes that have already shipped.

Releases are cut by pushing a tag, and each one publishes versioned Docker
images alongside `latest` and `stable`. See "Releasing" in the
[README](README.md) for the mechanics.

## Threat model

Knowing what Jot does and does not currently defend against will save you
wasted effort. This mirrors the threat model in
[`CLAUDE.md`](CLAUDE.md#threat-model).

**Logged-in users are treated as trustworthy collaborators.** Jot is built for
small, self-hosted, mutually-trusting groups — a household, a team, one person
and their devices. Hardening specifically against a malicious *authenticated*
insider is not a current design goal.

That is a statement about hardening, not about access control. **Baseline
authentication and authorization guarantees are mandatory and firmly in scope.**
A logged-in user must not be able to reach another user's data.

### In scope

- **Authentication bypass** — signing in without valid credentials, forging or
  fixating a session, or using an expired or revoked session or PAT.
- **Authorization and access-boundary bypass** — reading, modifying, or deleting
  a note, list, label, or image you neither own nor have shared with you;
  escaping a share's intended permissions.
- **Privilege escalation** — a non-admin user reaching an admin-only route or
  action, including through the MCP endpoint or a PAT.
- **Credential and token handling** — flaws in bcrypt password hashing, session
  token generation or storage (only SHA-256 hashes are stored server-side), PAT
  generation, or the password-change flow.
- **Injection** — SQL injection, stored or reflected XSS through note content
  (Markdown is rendered through `marked` and sanitized with DOMPurify), or
  HTML/script injection through any user-supplied field.
- **Blob storage escapes** — path traversal or unauthorized reads against the
  content-addressed image store under `JOT_UPLOAD_DIR`.
- **Remote code execution, SSRF, or unauthenticated data exposure** of any kind.
- **Vulnerable dependencies** where you can show the vulnerable code path is
  actually reachable in Jot.

### Out of scope

These are known, deliberate, or not something Jot can fix. Reports about them
will be closed with a pointer back here:

- **Attacks by an authenticated user that do not cross an ownership, share, or
  role boundary.** Per the threat model above, a logged-in user consuming
  resources or abusing a feature they legitimately have access to is not
  currently treated as a vulnerability. Resource-exhaustion concerns are handled
  as reliability work — see "Known and accepted" below.
- **Running Jot with insecure configuration.** In particular
  `JOT_COOKIE_SECURE=false`, which disables the session cookie's `Secure` flag
  and is documented for local HTTP development only. Serving Jot over plain HTTP
  in production, exposing the metrics port publicly, or disabling rate limiting
  are operator choices, not flaws.
- **Missing hardening headers, TLS configuration, or cipher suites**, unless you
  can demonstrate concrete exploitability. Jot expects to run behind a reverse
  proxy that terminates TLS.
- **Self-XSS**, clickjacking on unauthenticated pages, or issues requiring a
  victim to paste attacker-supplied content into their own browser console.
- **Automated scanner output with no demonstrated impact**, and reports that
  amount to a version number compared against a CVE list.
- **Social engineering** of maintainers or users, and physical access attacks.
- **Denial of service through raw traffic volume.** Rate limiting exists to
  contain accidental client-side request loops, not to withstand a deliberate
  flood; that is the reverse proxy's job.

### Known and accepted

Already documented, already understood — no need to report these:

- **The auth rate-limit bucket is keyed by the direct TCP peer address.** Behind
  a reverse proxy, every client shares one bucket, so one user's failed logins
  can throttle others' login attempts for up to a minute. Keying on a
  client-supplied header instead would be trivially spoofable. The README
  documents this under "Rate limiting", including the variable to raise.
- **`GET /config` is intentionally unauthenticated and not rate-limited.** It is
  fetched on every page load and returns no user data.
- **The first registered user automatically becomes admin.** Set
  `JOT_REGISTRATION_ENABLED=false` once your users have accounts.

If you are unsure whether something is in scope, report it. A short "probably
nothing, but" report is much better than a silent one.

## Disclosure

Jot follows **coordinated disclosure**:

- We will work with you on a fix and aim to release it within **90 days** of
  confirming the report.
- A **GitHub Security Advisory** is published for every confirmed vulnerability
  once a fixed release is available, including a CVE where warranted.
- **Reporters are credited by default** in the advisory and release notes. Tell
  us if you would rather stay anonymous, or how you would like to be named.
- Please hold public details until a fixed release is out. If 90 days pass with
  no fix and no explanation from us, you are free to disclose — that is a
  failure on our side, not on yours.

There is no bug bounty. This is an unpaid hobby project, and we are grateful for
reports regardless.
