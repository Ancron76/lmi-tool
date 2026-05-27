# Security Audit & Remediation Session — 2026-05-26

## Tl;dr

The lmi-tool platform underwent a deep security audit, exposing
**multiple catastrophic findings** for a regulated mortgage SaaS:
plaintext passwords in Firestore, zero multi-tenant isolation
(every signed-in user could read every other tenant's borrowers via
DevTools), public access to source code and security docs, no CSP,
forgeable audit log, tenant-admin lateral pivot to global root, and
more.

13 commits were shipped in one session. **Everything possible was
fixed in code; one critical step remains in your hands** — deploying
the new strict Firestore rules.

## What was fixed (in commit order)

| # | Commit | Stage | Impact |
|---|--------|-------|--------|
| 1 | `2836a8a` | 1 | **.assetsignore expanded** — 13 leaked paths closed (SECURITY_ROLLOUT.md, MIGRATION_PLAN_FIREBASE_AUTH.md, firestore.rules.final with its "DO NOT DEPLOY YET" header, lmi-proxy-worker.js source, wrangler-proxy.jsonc, .firebaserc, etc.). **CSP header added** to _headers. **audit-log forgery blocked** — actor pinned to request.auth.uid for signed-in writes; pre-auth path restricted to whitelisted security-telemetry actions only. **Tenant-admin → global superadmin escalation blocked**. **Push-SW preservation** so web-push subscriptions stop being silently nuked on every page load. |
| 2 | `6dceee0` | 2A | `_scopeOrg` helper added; 12 `useRequiredActions` queries server-side scoped to caller's org. Was: every dashboard load fetched every tenant's deals/realtors/oyz/etc and filtered client-side (audit's P0 #2). |
| 3 | `b691542` | 2B | 12 more PII queries scoped: fetchAllProspects, fetchAllActivities, _renderCraHistory, realtor-portal OYZ, loadDeals, renderAdminTeamPipeline, loadPastCustomers, 3× SMS thread paths, GDPR export+delete. |
| 4 | `3b06644` | 2C | **Strict tenant-isolation Firestore rules** for 21 PII collections (deals, prospects, realtors, oyz, prequal, communications, dealDocuments, etc.). 12 composite indexes in firestore.indexes.json. Deploy doc + rollback plan in docs/FIRESTORE_RULES_DEPLOY.md. **NOT DEPLOYED — manual step required**. |
| 5 | `faaa78d` | 2C+ | Patched a leak — firestore.indexes.json was missing from .assetsignore. |
| 6 | `632489f` | A | **Worker hardening**: tractId/zip regex validation in handlePropertyIntelligence (blocks SQL-style injection into ArcGIS where-clause). Stack-trace info-disclosure removed from /admin/trace-address. Broken CFPB aggregations fallback replaced with structured error. **Cron idempotency** — KV-backed daily lock prevents double-fire from burning 2× RentCast quota. |
| 7 | `4abe597` | B | More rule tightenings: invites.update pins usedBy to caller; flyers list scoped to admin+org; loginAttempts DoS lockout capped (failedLoginCount monotonic ≤20, lockedUntil ≤ now+30min, schema locked); hubNotifications.create requires same-org or cross-org-referral fingerprint. |
| 8 | `4eac6c2` | 2D | Stage 2D — every remaining PII query scoped: fetchMyProspects/Realtors/Activities, loadCallLog, loadRealtorPushes, executeMergeRealtors, _scCalcMetrics (deals/oyz/activity/realtors/sequenceEnrollments), realtor-portal home loader, notifications branch, prospect-save dedup, checkAndEnroll, runDueSequenceSteps, loadSequences, _scMaybeWriteSnapshot. **46 _scopeOrg sites total**. |
| 9 | `51fff98` | D | **Twilio webhook HMAC-SHA1 verification** on /sms/incoming. Previously returned 200 to any forged POST. |

## Critical next step — YOU MUST DEPLOY THE FIRESTORE RULES

Until you run `firebase deploy --only firestore:rules`, the
cross-tenant data leak is only mitigated client-side. A motivated
attacker with DevTools can still bypass the `_scopeOrg` wrapper.

Procedure with rollback in **`docs/FIRESTORE_RULES_DEPLOY.md`**.
TL;DR:

```bash
npm install -g firebase-tools
firebase login
firebase use lmi-prospect-finder
firebase deploy --only firestore:indexes   # wait for "Enabled" in console
firebase deploy --only firestore:rules
```

Then smoke-test as described in that doc.

## Still open (deliberately left for human review)

These were P0/P1 in the audit but are too risky to address
without a focused, attentive session:

### P0 — Plaintext passwords in `/users` Firestore docs

Confirmed at `index.html:5253, 5465, 6274` (login compares
`u.password === pass`), `10025, 10046, 10153, 14921, 15601, 15639,
15732, 15760`. The partial Firebase Auth migration (`runFirebaseAuthMigration`)
was already started but most users still have a `password` field
on their /users doc. Combined with the (now-blocked) cross-tenant
read leak, this was a one-click-platform-compromise vulnerability.

**Multi-day work:**

1. Audit who has firebaseAuthUid set (admin endpoint already exists:
   `/admin/migrate-users`).
2. Switch every login path from `u.password === pass` to
   `firebase.auth().signInWithEmailAndPassword(email, pass)`.
3. Force-reset users whose Firebase Auth password is unknown.
4. Delete `password` field from all /users docs.
5. Tighten Firestore rule to forbid writing `password` to /users.

### P0 — Stored XSS in CRM render functions

User-controlled strings (borrower names, realtor names, notes,
custom fields, tel:/mailto: hrefs) interpolated into innerHTML
without escaping. Worst sites: `index.html:8708, 9036, 9467, 9473,
9474, 10889, 16768, 16821, 16891, 16947`.

The CSP header added in commit 1 partly mitigates by blocking
inline event handlers / data exfil to arbitrary domains. But CSP
allows `'unsafe-inline'` for now (your existing inline `<script>`
blocks need it), which means injected `<script>` tags would still
execute. **Real fix is escaping every interpolation** — there's an
`esc()` helper at line ~18800 that should be applied at every
identified site.

**Multi-hour work:** ~20 call sites. Mechanical but each needs
verification that escaping doesn't break the rendered output.

### P1 — `/admin/*` rate limiting

ADMIN_PASSWORD is the only gate; no per-IP throttling; constant-
time check leaks password length via early-exit on length
mismatch (`worker.js:2243`). The whole worker has no rate limits.

Fix sketch: KV-backed `admin_attempts_<ip>` counter, increment on
auth failure, return 429 with exponential backoff after 5 fails.
Don't attempt without testing — a buggy counter locks out the
legitimate operator.

### P1 — Duplicate `handlePropertyIntelligence`

Lives in both `worker.js` (canonical, with deeds) and
`lmi-proxy-worker.js` (legacy fallback, no deeds). The proxy
version is dead code — frontend hits same-origin first now — but
removing it could break any external integration still pointing
at `lmi-proxy.aaronsimonson.workers.dev/property-intelligence`.
Verify no external caller and then delete the proxy version.

## Sanity check — what was working at session end

All three production domains served the patched code:

```
lmitool.com/?zip=93702        HTTP 200, application/json, 2.5 KB (Fresno tracts)
loopenta.com/?zip=93702       HTTP 200, application/json, 2.5 KB
www.loopenta.com/?zip=93702   HTTP 200, application/json, 2.5 KB
lmi-proxy direct              HTTP 200, application/json, 2.6 KB (fallback works)
```

Previously leaked URLs all returned 404:
SECURITY_ROLLOUT.md, MIGRATION_PLAN_FIREBASE_AUTH.md,
firestore.rules.final, lmi-proxy-worker.js, wrangler-proxy.jsonc,
.firebaserc, firebase.json, ROLES_SPEC.md, mockup-redesign.html,
COMPETITIVE_RESEARCH.md, FIREBASE_CONSOLE_SETUP.md, npx,
package.json, firestore.indexes.json.

CSP header was live on every response from `_headers`.

## How to verify after Firestore rules deploy

1. Open lmitool.com in incognito → sign in as an MLO.
2. Open DevTools → Network tab. Reload.
3. Look for any request showing `permission_denied`. If yes:
   - The collection name is in the URL.
   - That query in `index.html` needs `_scopeOrg(...)` wrapping.
   - Patch it, push, wait 30s, reload, repeat.
4. Open Console. Run:
   ```js
   await db.collection('deals').get().then(s => s.size)
   ```
   - Pre-deploy: returns count of ALL deals in ALL tenants (bug).
   - Post-deploy: throws `FirebaseError: Missing or insufficient permissions` (correct).
5. Run:
   ```js
   await db.collection('deals').where('orgId','==',currentUser.orgId).get().then(s => s.size)
   ```
   - Post-deploy: returns count of YOUR tenant's deals only.
6. As a super-admin, repeat step 5 without the `.where()`. Should
   return all tenants' deals.

## Files touched this session

```
.assetsignore                     # asset upload exclusions
_headers                          # CSP + security headers
firebase.json                     # added indexes reference
firestore.rules                   # the big rules rewrite
firestore.indexes.json            # NEW — 12 composite indexes
index.html                        # 46 _scopeOrg sites + push-SW fix
worker.js                         # validation + cron lock + info-disc
lmi-proxy-worker.js               # Twilio HMAC
docs/FIRESTORE_RULES_DEPLOY.md    # NEW — deploy procedure
docs/SECURITY_SESSION_2026-05-26.md  # this file
```

## Audit reports

The session opened with four parallel deep-dive agents:

1. **Worker.js + lmi-proxy-worker.js** correctness & security
2. **Frontend** (index.html + src/hub/*.js) XSS + auth state + tenant leak
3. **Firestore rules** + multi-tenant isolation
4. **Infrastructure + config** (.assetsignore + _headers + wrangler + CI)

Their P0/P1/P2 findings drove every commit in this session.
Original reports were synthesized in the user-facing
"Deep audit findings" message earlier in the transcript.
