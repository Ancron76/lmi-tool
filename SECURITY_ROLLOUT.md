# Bank-Grade Security Rollout

Target posture: FFIEC-aligned authentication, mandatory TOTP MFA, role-based + tenant-isolated Firestore access, hardened sessions, complete audit log, defence-in-depth headers, rate-limited worker.

Rollout proceeds in phases so production is never in a broken state. **Never skip ahead** — each phase depends on the previous one being stable.

## Phase 1 — Firestore rules lockdown (deploy now)

File: `firestore.rules`

What it changes versus today's wide-open rules:
- `allow read, write: if true` is gone everywhere.
- Privilege-escalation on `/users/{uid}`: a user cannot modify their own `role`, `orgId`, `tier`, `lockedUntil`, `failedLoginCount`, or `superAdmin` field. Only a tenant-admin (within their org) or superadmin can.
- `/tenants` and `/organizations` writes require admin (in-tenant) or superadmin.
- `/auditLog` is append-only forever — no updates, no deletes, not even by superadmin.
- `/invites` acceptance is one-shot: `used=false` → `used=true` only, and only the `used/usedAt/usedBy` fields may change.
- `/flyers` and `/invites` allow anonymous GET by opaque token (needed for public share links) but no list, no unauthenticated writes.
- Immutable collections: `auditLog`, `agreementLog`, `email_log`, `scorecardSnapshots`, `securityEvents`, `dataDeleteRequests`.
- Catch-all `match /{document=**}` denies read and write. Any collection not explicitly enumerated is blocked.

What it intentionally does NOT do (yet):
- Per-doc tenant isolation on operational collections (deals, prospects, realtors, oyz, etc.). Those stay at signed-in-only so the app's existing unfiltered `.get()` calls don't break.
- MFA enforcement. That's Phase 8.

Rollout steps:
1. Copy the full contents of `firestore.rules` into Firebase Console → Firestore → Rules.
2. Click **Publish**.
3. Tail `auditLog` for ~30 minutes watching for `permission-denied` anomalies. Any normal user workflow failing is a bug in the rules file — revert to the previous ruleset via the Console's history tab and report.
4. Leave Phase 1 in place for at least 48 hours before moving to Phase 2.

## Phase 2 — TOTP MFA enrollment (requires Blaze plan)

Prerequisite: **upgrade Firebase project to the Blaze pay-as-you-go plan**. Firebase Auth MFA (TOTP) requires Blaze. TOTP itself has no per-use cost; the plan change just unlocks the feature. You stay inside the free Spark quota for everything else as long as you don't exceed it.

1. Firebase Console → Billing → Upgrade to Blaze.
2. Firebase Console → Authentication → Sign-in method → Multi-factor Authentication → **Enable Authenticator app (TOTP)**.
3. Deploy `index.html` with the MFA enrollment UI (delivered in this phase).
4. First login after deploy, every user is routed to an enrollment screen: scan a QR with their authenticator app (Google Authenticator, Authy, 1Password, etc.), enter the 6-digit code, receive 10 one-time recovery codes. They download/print the codes before proceeding.
5. Their `mfaEnrolled=true` flag is flipped via self-update (allowed without MFA precisely so this flow works).
6. On every subsequent login, Firebase prompts for the 6-digit code after password. Sessions without the `firebase.sign_in_second_factor` claim cannot access anything gated by `hasMfa()` once Phase 8 is live.

## Phase 3 — FFIEC password policy

On every password set or change, enforce:
- 12-character minimum.
- At least one of each: upper, lower, digit, symbol.
- Not present in HaveIBeenPwned breach corpus (k-anonymity API, first 5 chars of SHA-1 sent; no password ever leaves the client in cleartext).
- Not equal to any of the last 5 passwords for that user (hashed entries in `users/{uid}/passwordHistory`).

## Phase 4 — Session + lockout

- 15-minute inactivity auto-logout (idle timer on pointer/key events).
- 5 failed logins in 15 minutes → account locked for 15 minutes. Tracked in `/loginAttempts/{uidOrEmailHash}` with `{count, windowStart, lockedUntil}`.
- Absolute session cap of 12 hours regardless of activity.

## Phase 5 — Audit log completeness

Every sensitive operation must write `auditLog`:
login, logout, failed login, account lockout, unlock, MFA enrollment, MFA recovery-code redemption, password change, feature flag flip, tier change, DPA/ToS signing, data export, tenant create/delete, user promote/demote, invite create/revoke, CRA report generation.

## Phase 6 — Security headers

Cloudflare `_headers` file + Worker response headers:
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `Content-Security-Policy: default-src 'self'; ...`
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(self)`

## Phase 7 — Worker rate limiting

KV-backed token bucket on:
- `/admin/*` (admin-tier limits, 60 requests/min per IP)
- Auth-adjacent endpoints (10 requests/min per IP)

429 response with `Retry-After` header when bucket empty.

## Phase 8 — Final Firestore rules (MFA required)

File: `firestore.rules.final`

Deploy only after Phase 2 rollout is complete and all users have `mfaEnrolled=true`. Identical to `firestore.rules` but every sensitive read/write adds `hasMfa()` — the caller's ID token must carry a `firebase.sign_in_second_factor` claim.

## Emergency rollback

Firebase Console → Firestore → Rules → **History** tab → restore the previous ruleset with one click. No data loss, no code change needed.
