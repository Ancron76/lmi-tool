# Operational Runbook — lmi-tool / Loopenta

> Last updated: 2026-05-28. When something breaks at 2am, this is the
> first thing to read.

## Health-check dashboard

In order, every check should return what's noted. If any fails, jump to
the matching incident section below.

```bash
# 1. Main worker live
curl -s -o /dev/null -w "%{http_code}\n" https://lmitool.com/
# Expect: 200

# 2. LMI search worker handler reached (not falling through to static)
curl -s -w "HTTP %{http_code}, %{content_type}\n" -o /dev/null \
  "https://lmitool.com/?zip=93702"
# Expect: HTTP 200, application/json

# 3. Proxy worker live
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://lmi-proxy.aaronsimonson.workers.dev/?zip=93702"
# Expect: 200

# 4. Strict Firestore rules enforcing (from browser Console)
await db.collection('deals').get().then(s=>s.size).catch(e=>e.code)
# Expect: 'permission-denied' (or a number if you're SA)

# 5. No-cache HTML deploys
curl -sI https://lmitool.com/ | grep -i cache-control
# Expect: Cache-Control: no-cache, must-revalidate

# 6. CSP header live
curl -sI https://lmitool.com/ | grep -i content-security-policy
# Expect: a long policy string starting with default-src 'self'
```

---

## When the deploy is broken

**Symptom:** GitHub Actions deploy fails, OR live site returns 5xx, OR
console shows new JS errors.

```bash
gh run list --limit 5 --workflow=deploy.yml
gh run view <RUN_ID> --log-failed
```

**Quick rollback (worker code only):**

```bash
# Find the last known-good commit
git log --oneline -10
# Revert to it
git revert <bad-sha>
git push
# Wait for GHA to redeploy
gh run watch
```

**Force-deploy from local without GitHub Actions** (when GHA itself is
down):

```bash
npx wrangler deploy --config wrangler.jsonc
npx wrangler deploy --config wrangler-proxy.jsonc
```

(Requires `CLOUDFLARE_API_TOKEN` env var with Workers Edit scope.)

**If `wrangler tail` shows nothing during requests:**

The CF route binding may have been knocked off. Re-check at
https://dash.cloudflare.com/<account-id>/workers/services/view/lmi-tool/production/domains
and confirm `lmitool.com`, `loopenta.com`, `www.loopenta.com` are
listed as Custom Domains pointing at the `lmi-tool` worker.

---

## When Firebase Auth is broken

**Symptom:** Login form shows "Sign-in service unavailable" or
"Network error" repeatedly. Console shows
`firebase.auth().signInWithEmailAndPassword` rejected with a
non-credential error.

**Check Firebase status:** https://status.firebase.google.com

**If you're locked out personally:**

1. Click "Forgot password?" on the login screen — sends a reset email
   via Firebase Auth (independent of any code path you might have
   broken locally).
2. If no email arrives within 5 min, check spam.
3. If still nothing, sign into the Firebase Console at
   https://console.firebase.google.com/project/lmi-prospect-finder
   with your Google account → Authentication → Users → find your
   email → "Reset password" sends the same email.
4. As a LAST resort, use the second SA account (see Task #3 in the
   security plan — if you haven't created one yet, do that NOW).

**If a customer is locked out:**

Have them click "Forgot password?" themselves. Don't try to "set" a
password on their /users doc — that field has been forbidden by
Firestore rules. The Firebase Auth password lives only in
Firebase Auth.

---

## When Firestore rules deploy needs to be rolled back

**Symptom:** Right after `firebase deploy --only firestore:rules`,
the app starts showing empty panels everywhere. Browser console is
full of `permission-denied` errors.

**Roll back to the previous rules in the Firebase Console:**

https://console.firebase.google.com/project/lmi-prospect-finder/firestore/rules

Look at the right-hand "Release history" panel. Click the previous
release. Click "Restore". Live within ~30 seconds.

**Then patch the rules locally and re-deploy:**

```bash
# Make whatever fix you need to firestore.rules
firebase deploy --only firestore:rules
```

**Common rule-deploy failure modes:**

- Strict tenant rules block a query the client wasn't `_scopeOrg`-wrapped
  for. Patch the client query (add `.where('orgId','==',orgId)`), wait
  for CF deploy, then re-try the rule deploy.
- Composite index missing. Browser console will show a Firebase Console
  link to auto-create it. Or edit `firestore.indexes.json` and run
  `firebase deploy --only firestore:indexes`.

---

## When RentCast quota is exhausted

**Symptom:** Admin dashboard shows usage at the cap, listings stop
refreshing, error logs say `monthly_limit_reached`.

**Check current usage:**

Super Admin tab → RentCast Data. Shows current count vs. the
50/month cap (or whatever `RENTCAST_MONTHLY_LIMIT` is set to in
`worker.js`).

**If it's a real monthly cap hit:**

Wait until the 1st of next month (counter auto-resets via KV TTL),
OR upgrade your RentCast plan at https://app.rentcast.io and bump
`RENTCAST_MONTHLY_LIMIT` in `worker.js`.

**If the counter is wrong (overshot due to race):**

Super Admin → RentCast Data → "Reset monthly counter". Requires
typing `RESET` to confirm. Counter goes back to 0.

`QUOTA_SAFETY_MARGIN=2` in `worker.js` reserves 2 slots as race
headroom — usable cap is effective LIMIT-2 (e.g. 48 of 50). If
concurrency demand grows, raise the margin to 5.

---

## When the cron has fired twice on the same day

**Symptom:** RentCast quota burned double the expected amount on a
single day, or "Last run" history shows two runs same date.

**Verification:**

```bash
# Browser Console
await fetch('/admin/rentcast-status', {
  headers: {Authorization:'Bearer '+sessionStorage.getItem('rc_admin_pw')}
}).then(r=>r.json())
# Inspect lastRun and history
```

**Mitigation:**

Already protected: `worker.js` writes a `cron_lock_YYYY-MM-DD` KV key
at the start of each run with a 25-hour TTL. A second invocation in
the same day refuses early. If this still happens, the KV write may
have failed — check `wrangler tail` for `[cron-lock] KV write failed`.

---

## When you (or a customer) think you've been compromised

**First 10 minutes — contain:**

1. **Force-sign out every user in Firebase Auth:** Firebase Console
   → Authentication → ⋮ menu → "Sign out all users". Forces every
   active session token to be invalidated. Customers will have to
   re-authenticate. (You can do this even if you don't yet know who
   was compromised.)

2. **Rotate ADMIN_PASSWORD:**
   ```powershell
   npx wrangler secret put ADMIN_PASSWORD
   # paste a fresh 32+ char random string
   ```
   Every active session that cached the old one is now locked out
   of /admin/* — including yours. Re-enter the new one on the admin
   page.

3. **Clear the per-IP admin throttle KV keys** if you want to let
   yourself back in immediately (your IP may have been locked from
   the rotation attempt):
   ```bash
   # From browser Console as SA
   await fetch('/admin/rentcast-status', {
     headers:{Authorization:'Bearer '+sessionStorage.getItem('rc_admin_pw')}
   })
   # If you get 429, wait the window or clear directly via wrangler kv
   ```

**Next 30 minutes — investigate:**

4. Pull the audit log:
   ```js
   // browser Console as SA
   (await db.collection('auditLog')
     .orderBy('timestamp','desc').limit(500).get()
   ).docs.map(d=>d.data())
   ```
5. Check `loginAttempts` for unusual patterns:
   ```js
   (await db.collection('loginAttempts').get()).docs.map(d=>d.data())
   ```

**Next 24 hours — notify:**

6. If any customer PII was touched (deal, prospect, communication
   collections), the regulator notification clock starts. State
   data-breach laws vary; GLBA notice to FTC + Treasury within 30
   days is the federal baseline.
7. Open a Cloudflare ticket if the worker was abused (they can
   trace the attacker's traffic patterns).
8. Open a Firebase support ticket if Auth was compromised.

---

## When you're locked out of MFA

**Symptom:** You enrolled a TOTP authenticator, then lost your
phone / authenticator app data, OR a customer says the same.

MFA is implemented in the worker (RFC 6238 TOTP). Secrets are
stored AES-GCM encrypted in Cloudflare KV under
`mfa_totp_<firebase_uid>`. Backup codes (hashed) under
`mfa_backup_<firebase_uid>`. Five wrong codes → 30 min lockout
(`mfa_lock_<firebase_uid>`).

### Self-recovery (preferred): use a backup code

At enrollment, each user got 10 single-use recovery codes. On
sign-in, when the TOTP prompt appears, type a backup code in
the form `XXXXX-XXXXX` instead of the 6-digit number. The worker
detects the format and routes to `/mfa/verify-backup`, consuming
the code. Once signed in, immediately go to **Settings → Security
→ Regenerate backup codes** (requires a fresh authenticator
enrollment first via Remove → Re-enroll).

### Operator-side recovery: wipe via wrangler

If the user has no backup codes left AND no authenticator:

1. **Identity-verify the user.** Call them on a known phone
   number from `/users/{uid}`. Confirm DOB / last 4 of SSN /
   something not stored in their record. Letting a
   social-engineer through here is the highest-risk path in this
   whole system.

2. **Find their Firebase UID.** Firebase Console → Authentication
   → Users → search email → copy `User UID`.

3. **Wipe the KV records:**
   ```powershell
   npx wrangler kv key delete --binding=KV_NAMESPACE "mfa_totp_<UID>"
   npx wrangler kv key delete --binding=KV_NAMESPACE "mfa_backup_<UID>"
   npx wrangler kv key delete --binding=KV_NAMESPACE "mfa_lock_<UID>"
   ```

4. **Clear the custom claims** so the sign-in flow stops
   demanding MFA:
   ```powershell
   # Via the worker's /admin/clear-mfa-claims endpoint (if you
   # add one), or via gcloud CLI with the FIREBASE_SERVICE_ACCOUNT
   # key file. Minimum: set customAttributes to "{}" via the
   # identitytoolkit accounts:update REST call.
   ```

5. Tell the user to sign in with just their password and
   re-enroll immediately at Settings → Security.

### Lockout (5 wrong codes / 30 min)

If the user is in the lockout window but still has their
authenticator:

```powershell
npx wrangler kv key delete --binding=KV_NAMESPACE "mfa_lock_<UID>"
```

### Self-check the worker MFA crypto

`GET https://lmitool.com/mfa/health` returns a JSON report:
- `totp_rfc6238_test_vector_ok: true` — TOTP math is correct
- `aes_gcm_roundtrip_ok: true` — secret encryption works
- `config.{kv_namespace, mfa_encryption_key, firebase_service_account}: true`

Use it after every deploy to confirm the crypto path is intact.

### Audit trail

Every MFA operation writes two records:
- Worker console (Cloudflare Logs / wrangler tail) — structured
  JSON `[mfa-audit] {action, uid, ip, ua, status, ts}`
- Firestore `/auditLog` — immutable per rules
  (`mfa_enrolled`, `mfa_verified`, `mfa_verification_failed`,
  `mfa_locked_out`, `mfa_unenrolled`, etc.)

Pulling either tells you what happened. The pair gives both
server-side observability and a regulator-friendly database trail.

---

## When RentCast / CFPB / Census APIs are down

**Symptom:** LMI search returns 502 with `reason: cfpb_all_years_failed`
or similar. Worker logs show fetch failures.

The worker has fallbacks built in:
- LMI search tries the local CFPB CSV; if that fails it tries 2023
  ACS via Census.
- Property Intelligence has separate sub-fetches; partial data is
  returned with warnings.

**Manual check:**

```bash
# CFPB direct
curl -sI 'https://ffiec.cfpb.gov/v2/data-browser-api/view/nationwide/csv?years=2023&actions_taken=1,2,3'
# Census Geocoder
curl -s 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=1600+Pennsylvania+Ave+NW&benchmark=Public_AR_Current&format=json'
# Twilio (SMS path)
curl -s -u $TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN \
  https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID.json
```

If any return 5xx, there's nothing to do but wait. Tweet the relevant
status page. Add a customer-facing banner if it'll be long
(`worker.js` `/admin/rentcast-status` could be extended to surface
an "ops banner" KV flag).

---

## When the audit log is full of failed-login spam

**Symptom:** `auditLog` collection has thousands of `login_failed`
entries from the same IP/email pair within minutes.

**Verify:**

```js
const recent = (await db.collection('auditLog')
  .where('action','==','login_failed')
  .orderBy('timestamp','desc').limit(200).get()
).docs.map(d=>d.data());
console.table(recent.slice(0,20));
```

**Already protected:** `loginAttempts` rule caps `failedLoginCount`
at 20 and `lockedUntil` to ≤ now+30m, so an attacker can't lock a
victim out forever. But the noise pollutes logs and quota.

**Mitigation:**

The admin/public rate limiters cover the worker, but the Firebase
Auth surface (the actual sign-in attempt) goes to Google. They have
their own throttling — `auth/too-many-requests` should kick in after
~5 attempts in a short window. If it isn't, file a Firebase ticket
because that's anomalous.

---

## Escalation list (who to call)

| What | Who | Where |
|---|---|---|
| Cloudflare incident | Cloudflare Support | https://dash.cloudflare.com → Support |
| Firebase incident | Firebase Support | https://firebase.google.com/support |
| Domain DNS issue | Domain registrar | (whoever owns lmitool.com + loopenta.com) |
| GitHub Actions broken | GitHub Status | https://www.githubstatus.com |
| Security incident | Insurance + counsel | (fill in your contacts) |
| Regulatory notification | State AG + FTC | varies by state |

---

## Routine maintenance (monthly)

- [ ] First of month: confirm RentCast counter auto-reset
- [ ] First of month: review prior month's auditLog for anomalies
- [ ] Every Monday: check Firebase Auth users list for unexpected accounts
- [ ] Every push to main: deploy completes within ~30s; if not, investigate
- [ ] Once per quarter: rotate ADMIN_PASSWORD
- [ ] Once per quarter: review who has super-admin role
- [ ] Once per quarter: regenerate VAPID keys for web push
