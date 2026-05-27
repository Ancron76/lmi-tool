# Firestore Rules Deploy — Phase 2 Tenant Isolation

The strict tenant-isolation rules in `firestore.rules` are committed to git
but **NOT deployed automatically**. Firebase rules don't ship via the
GitHub Actions worker pipeline — they need a separate `firebase deploy`.

## Prerequisites

```bash
npm install -g firebase-tools
firebase login
firebase use lmi-prospect-finder  # from .firebaserc
```

## Pre-flight check

Before deploying, confirm the client code is on `b691542` or later (the
Stage 2A + 2B commits that add `_scopeOrg` to every PII-collection
`.get()`). On older client code, the new rules will return
permission_denied for any unfiltered `.get()` and dashboards will
show empty panels.

```bash
git log --oneline -1   # expect: b691542 or newer
```

Confirm prod is serving that version:

```bash
curl -s https://lmitool.com/ | grep -c "_scopeOrg"
# Expected: 28+ (one per query site + helper)
```

## Deploy procedure

### 1. Dry-run the rules locally first

```bash
firebase deploy --only firestore:rules --dry-run
```

This validates the syntax but doesn't push. Should output
`✔ Deploy complete!` with no rule-evaluation errors.

### 2. Deploy the composite indexes FIRST

Indexes can take minutes to build. Deploy them, wait for them to be
ready, **then** deploy the rules. If you deploy rules first, the new
rule paths that need indexes will throw FAILED_PRECONDITION errors
until the indexes finish building.

```bash
firebase deploy --only firestore:indexes
```

Then check status in the Firebase Console
(https://console.firebase.google.com/project/lmi-prospect-finder/firestore/indexes)
until every index says **Enabled** (not "Building").

### 3. Deploy the rules

```bash
firebase deploy --only firestore:rules
```

The Firebase Console will show the new rules version under
`Firestore Database → Rules → History`.

### 4. Smoke-test

Within 30 seconds of the rules deploy:

- Sign in as a normal MLO in any tenant.
- Reload the dashboard. Required actions panel should populate.
- Visit Deal Pipeline tab. Your deals should appear.
- Visit Contacts → Realtors. Your realtors should appear.
- Visit Open Houses. Your tenant's events should appear.
- Visit Communications. Your messages should appear.

If any of those panels show empty when they shouldn't, an unfiltered
`.get()` is still in the wild. The browser console will show
`FirebaseError: Missing or insufficient permissions`. Note the
collection name and either:
  - Patch the offending `.get()` to use `_scopeOrg(query)`, or
  - **Roll back immediately** (see below).

### 5. Sign in as Super Admin

Should still see cross-tenant data on the SA tabs. If those panels
break, the rule's `isSuperAdmin()` bypass isn't firing — check the
user doc's `role` field.

## Rollback

If anything important breaks:

```bash
git revert <strict-rules-commit-sha>
firebase deploy --only firestore:rules
```

Or paste the previous rules version directly into the Firebase
Console (it keeps history under
`Firestore Database → Rules → Release history`).

The client `_scopeOrg` wrapper keeps working under the older rules —
it just becomes a harmless extra `.where()` filter. So rolling back
the rules only does not require rolling back any client code.

## What this deploy fixes

Closes the catastrophic finding from the 2026-05-26 security audit:
**any signed-in MLO at any tenant could read every borrower / deal /
realtor / open-house / communication record across every other
customer of the platform** by opening DevTools and running
`db.collection('deals').get()`. With the new rules:

- Per-doc `orgId`/`tenantId` check on every operational collection.
- Cross-tenant updates/deletes blocked.
- Super-admin still has cross-tenant access for legitimate ops.
- `auditLog` actor is pinned to `request.auth.uid` (no more forged
  log entries impersonating other users).
- Tenant-admin cannot promote any user to `superadmin` (closes the
  lateral-pivot-to-root vector).
