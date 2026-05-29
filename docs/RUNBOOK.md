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

# 7. MFA crypto self-test (worker-side TOTP)
curl -s https://lmitool.com/mfa/health
# Expect (JSON):
#   totp_rfc6238_test_vector_ok: true
#   aes_gcm_roundtrip_ok:        true
#   config.kv_namespace:         true
#   config.mfa_encryption_key:   true
#   config.firebase_service_account: true
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

### Operator-side recovery: `/admin/clear-mfa`

If the user has no backup codes left AND no authenticator:

1. **Identity-verify the user.** Call them on a known phone
   number from `/users/{uid}`. Confirm DOB / last 4 of SSN /
   something not stored in their record. Letting a
   social-engineer through here is the highest-risk path in this
   whole system.

2. **Find their Firebase UID.** Firebase Console → Authentication
   → Users → search email → copy `User UID`.

3. **Hit `/admin/clear-mfa`** (requires SA password):
   ```bash
   curl -X POST https://lmitool.com/admin/clear-mfa \
     -H "Authorization: Bearer $ADMIN_PASSWORD" \
     -H "Content-Type: application/json" \
     -d '{"uid":"<UID>","reason":"user lost phone, identity-verified via call to NMLS phone on 2026-MM-DD"}'
   ```
   The endpoint validates the SA password, requires a >=10-char
   reason, wipes all four KV keys (`mfa_totp_<uid>`,
   `mfa_totp_pending_<uid>`, `mfa_backup_<uid>`, `mfa_lock_<uid>`),
   clears the Firebase custom claims, and logs the operation to
   Cloudflare Logs with actor IP, target UID, and reason.

4. Tell the user to sign in with just their password and
   re-enroll immediately at Settings → Security.

### Fallback: direct KV wipe via wrangler

If for any reason `/admin/clear-mfa` is unavailable (worker down,
admin password rotated, etc.), the wrangler-CLI path still works:

```powershell
npx wrangler kv key delete --binding=KV_NAMESPACE "mfa_totp_<UID>"
npx wrangler kv key delete --binding=KV_NAMESPACE "mfa_backup_<UID>"
npx wrangler kv key delete --binding=KV_NAMESPACE "mfa_lock_<UID>"
# Then clear customAttributes via gcloud or the Firebase console.
```

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

## Firestore automated backups

**Why:** Firestore is your system of record for every deal,
prospect, customer communication, audit log entry, and tenant
configuration. A single bad client-side write (or a malicious
insider with admin) can permanently destroy customer data. The
strict Firestore rules we deployed make this hard, but not
impossible. A nightly snapshot is your last line of defense.

**Cost:** $0 with the right configuration on Spark. Storage cost
is ~$0.026 per GiB/month for the first 5 GiB after which you
hit Blaze. At our current size (~600 MB at 100 users projected)
we'd be under 1 GiB for years.

### Recommended setup

Firebase doesn't expose nightly backups directly on Spark, but
the **Point-in-time recovery (PITR)** feature does, and it's the
gold standard — recovers to any second in the trailing 7 days.

1. Firebase Console → Firestore Database → **`(default)`** → click
   the gear icon (⚙️) → **Settings**
2. Scroll to **Point-in-time recovery** → toggle **ON**
3. Confirm the 7-day window. (PITR storage is billed but small —
   typically <$1/mo at our scale.)

### Manual export to GCS (deeper retention)

For backups older than 7 days (audit / compliance / legal-hold):

1. Set up a Google Cloud Storage bucket in the same project:
   - GCP Console → Cloud Storage → **Create bucket**
   - Name: `lmi-prospect-finder-firestore-backups`
   - Region: `us-west1` (or wherever the Firestore is)
   - Storage class: **Nearline** (cheap for backup data)
   - Lifecycle rule: delete objects after 365 days (or 7 years
     for hard regulatory retention — depends on your state's
     MLO record-keeping law)

2. Schedule a daily export from Cloud Scheduler:
   - GCP Console → Cloud Scheduler → **Create job**
   - Frequency: `0 7 * * *` (07:00 UTC = 23:00 PT, after nightly cron)
   - Target: HTTP
   - URL: `https://firestore.googleapis.com/v1/projects/lmi-prospect-finder/databases/(default):exportDocuments`
   - Auth: OAuth token → service account with `roles/datastore.importExportAdmin`
   - Body:
     ```json
     {"outputUriPrefix":"gs://lmi-prospect-finder-firestore-backups"}
     ```

3. Test the first run manually and verify the export landed in
   the bucket.

### Restore procedure

To restore from PITR (within 7 days):
```bash
# Pick a timestamp — must be within trailing 7 days
gcloud firestore databases restore \
  --source-database='projects/lmi-prospect-finder/databases/(default)' \
  --destination-database='projects/lmi-prospect-finder/databases/restore-2026-MM-DD' \
  --point-in-time='2026-MM-DDTHH:MM:SS.000000Z'
```
This creates a new database alongside the original — you can
inspect it before promoting. Old data stays untouched.

To restore from GCS export:
```bash
gcloud firestore import gs://lmi-prospect-finder-firestore-backups/2026-MM-DD/
```

### Verify

Once monthly, check the GCS bucket has new exports landing. If
they stop, the Cloud Scheduler job has probably hit a quota or
the service account permissions drifted.

---

## HSTS preload-list submission

**Why:** Once lmitool.com is in the Chrome / Firefox / Safari / Edge
HSTS preload list, the first time anyone in the world visits the
domain — even on a brand new device that's never seen our cert —
the browser automatically upgrades to HTTPS before any HTTP request
is made. Forecloses SSL-stripping man-in-the-middle attacks at
session-start. Required posture for regulated financial sites.

**Current header (verified 2026-05-29 via `curl -sI`):**

```
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
```

That satisfies the [preload requirements](https://hstspreload.org/):
- `max-age` ≥ 31536000 (1 year) ✓
- `includeSubDomains` ✓
- `preload` directive ✓

**Submit:**

1. Open https://hstspreload.org/
2. Enter `lmitool.com` → click **Check HSTS preload status**
3. If all green, click **Submit** at the bottom
4. Repeat for `loopenta.com` and `www.loopenta.com`

**Read this before you click Submit** — preload submission is
**hard to reverse** (browsers can take 12 months to honor a removal
request). Don't submit until you're confident:

- Every subdomain works on HTTPS (test `www.`, any others)
- Your cert auto-renewal is rock solid (Cloudflare handles this for
  us, so it's fine)
- No internal/dev subdomain you'd ever want to run on HTTP for
  troubleshooting (e.g. `staging.lmitool.com`)

If you ever need to remove: https://hstspreload.org/removal/

---

## SPF / DKIM / DMARC — email authentication

**Why:** Without these DNS records, any spammer in the world can
send "From: support@lmitool.com" and the receiving mail server
has no way to know it's a fake. Gmail / Outlook / Apple Mail
increasingly send unauthenticated mail to spam (or refuse it
outright). Banks have been the targets of phishing campaigns for
years; mortgage CRMs are next.

### Current state

We send email via **EmailJS** (`service_g1ghxq2`, `template_fksjm5e`).
EmailJS routes through whatever SMTP provider you configured in
their dashboard — probably Gmail / Google Workspace / SendGrid /
Mailgun. The records you need depend on that provider.

### What to add

Open your domain registrar's DNS panel for `lmitool.com` (and
`loopenta.com`). Add these three records:

**1. SPF** (Sender Policy Framework) — TXT record on root domain:

```
Name:  @  (or lmitool.com)
Type:  TXT
Value: v=spf1 include:_spf.google.com ~all
```

Replace `_spf.google.com` with your actual SMTP provider's include
directive:
- Google Workspace: `include:_spf.google.com`
- SendGrid:         `include:sendgrid.net`
- Mailgun:          `include:mailgun.org`
- Microsoft 365:    `include:spf.protection.outlook.com`

Combine multiple if you send through more than one (e.g. Google
Workspace for human email + SendGrid for transactional):

```
v=spf1 include:_spf.google.com include:sendgrid.net ~all
```

The `~all` at the end means "soft-fail" — receivers will mark
mismatches as suspicious but still deliver. Switch to `-all`
("hard-fail, reject") once you're confident no legit mail comes
from anywhere outside the listed providers (usually after running
`~all` for 30-60 days and watching DMARC reports).

**2. DKIM** (DomainKeys Identified Mail) — your provider gives you
a public-key TXT record to publish:

- **Google Workspace:** Admin Console → Apps → Google Workspace →
  Gmail → Authenticate email → Generate new record → publish the
  TXT they show you (selector usually `google._domainkey.lmitool.com`)
- **SendGrid:** Settings → Sender Authentication → Authenticate
  Your Domain → publish all the CNAMEs they show (typically 3
  CNAMEs: `s1._domainkey`, `s2._domainkey`, and one for return-path)
- **Mailgun:** Sending → Domains → click your domain → DNS records
  tab → publish the TXT record (selector usually `mta._domainkey`)

Only publish ONE provider's DKIM at a time per selector. Multiple
providers can coexist if each uses a different selector.

**3. DMARC** (Domain-based Message Authentication, Reporting, and
Conformance) — TXT record telling receivers what to do when SPF
or DKIM fails, plus where to send reports:

```
Name:  _dmarc  (creates _dmarc.lmitool.com)
Type:  TXT
Value: v=DMARC1; p=none; rua=mailto:dmarc-reports@lmitool.com; pct=100; aspf=r; adkim=r
```

- `p=none` — "monitor only, don't quarantine or reject." START
  HERE. Run for 30-60 days, read the reports, then graduate to
  `p=quarantine` (send to spam) and finally `p=reject` (refuse).
- `rua=mailto:…` — where to send daily DMARC aggregate reports.
  Use a real inbox you check, or sign up for a free service like
  https://dmarc.postmarkapp.com/ (10K msgs/mo free) to parse them
  automatically.
- `pct=100` — apply policy to 100% of mail. Some teams start with
  `pct=10` during the migration.
- `aspf=r` and `adkim=r` — "relaxed" alignment (subdomain matches
  count). Use `s` (strict) only if you're certain about your
  setup.

### Verify

After publishing, wait 5-30 min for DNS propagation, then:

```bash
# SPF
dig +short TXT lmitool.com | grep spf1
# DKIM (replace google with your selector)
dig +short TXT google._domainkey.lmitool.com
# DMARC
dig +short TXT _dmarc.lmitool.com
```

Or use https://mxtoolbox.com/SuperTool.aspx — enter your domain,
pick "SPF Record Lookup" / "DKIM Lookup" / "DMARC Lookup" from
the dropdown. Green checks = good.

**Send a test:** https://www.mail-tester.com/ shows you exactly
what receivers see. Goal: 10/10 score before going live.

### Why this matters for the regulator story

- FFIEC Examination Handbook (Section on Customer Authentication)
  expects authenticated email for any communication about
  consumer financial accounts.
- GLBA Safeguards Rule requires reasonable email protections;
  unauthenticated email fails this test.
- The CFPB has cited unauthenticated email as a phishing-enablement
  finding in enforcement actions against mortgage servicers.

Get these records published before you have any volume of customer
emails flowing. Cheaper now than after a phishing incident.

---

## Routine maintenance (monthly)

- [ ] First of month: confirm RentCast counter auto-reset
- [ ] First of month: review prior month's auditLog for anomalies
- [ ] Every Monday: check Firebase Auth users list for unexpected accounts
- [ ] Every push to main: deploy completes within ~30s; if not, investigate
- [ ] Once per quarter: rotate ADMIN_PASSWORD
- [ ] Once per quarter: review who has super-admin role
- [ ] Once per quarter: regenerate VAPID keys for web push
