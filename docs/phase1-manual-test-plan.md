# Phase 1 — Manual Test Plan
_Referral lifecycle + permissions + notifications_

You'll need two browser profiles (or one regular + one incognito) signed in as different users in different orgs. Call them **Sender** (e.g., a mortgage officer in Org A) and **Receiver** (e.g., a realtor in Org B).

## 1. Stage transitions — happy path

As **Sender**:

- [ ] Open **Referrals** → click **Send a referral**.
- [ ] Pick the Receiver's org, kind = Borrower, fill out client details, submit.
- [ ] Back on the Referrals list: the new referral appears with `Pending` status.
- [ ] The timeline on the detail view shows one event: `Referral sent`.

As **Receiver** (other browser profile):

- [ ] Bell in the top-right shows a red `1` badge.
- [ ] Open the bell → the notification appears. Click it → deep-links to the referral detail.
- [ ] Timeline now has a `viewed` event.
- [ ] Click **Accept** → status flips to `Accepted`, stepper moves to the first stage.
- [ ] Click the next stage in the stepper (e.g., `Pre-qualified`) → status flips to `In process`, stage advances.
- [ ] Walk forward through each stage. Each click adds a `Stage advanced` event.
- [ ] Click an earlier stage → writes a `Stage reverted` event.
- [ ] Click **Close · Won** → status becomes `Closed · Won`, timeline gets a `closed_won` event, card moves out of the active pipeline.

## 2. Stage transitions — close lost path

- [ ] Send a second referral from Sender to Receiver.
- [ ] Receiver declines it with a reason → status becomes `Declined`, reason shows in the timeline.
- [ ] Send a third referral. Receiver accepts, advances once, then clicks **Close · Lost** with a reason → status `Closed · Lost`, reason captured.

## 3. Partner Network scorecard

As **Sender**:

- [ ] Navigate to **Partner Network**.
- [ ] Top KPIs reflect: Total Touched, Active, Won, Close Rate, Stuck.
- [ ] The Receiver's row shows: referrals sent, accepted, won, avg days to close.
- [ ] A stuck-pipeline banner appears if any active referral has been in the same stage > 14 days.

## 4. Notifications — in-app feed

As **Sender**, while a Receiver-side event is happening:

- [ ] Bell badge increments in real-time (Firestore `onSnapshot`).
- [ ] Feed items show actor name, org, and human-readable action.
- [ ] Click a feed item → marks that notification read, deep-links to the lead.
- [ ] **Mark all read** clears the badge.
- [ ] **Preferences** (gear icon in the bell menu) toggles in-app / email / push independently.

## 5. Notifications — email (requires deployed worker)

Pre-requisites: worker deployed, `COWORK_WORKER_BASE` and VAPID keys set, Resend API key in worker env.

- [ ] With email toggle on, trigger any event. Inbox receives a message within ~30 seconds.
- [ ] Email subject mirrors the in-app title. Body has the action, actor, org, and a deep link to the referral.
- [ ] Clicking the link opens the referral detail.

## 6. Notifications — browser push (requires VAPID)

- [ ] Open Preferences → toggle **Browser push** on. Browser permission prompt appears; allow it.
- [ ] A row appears in Firestore `pushSubscriptions/{subId}` for your uid.
- [ ] From the other browser, trigger an event.
- [ ] A system-level notification appears on your OS.
- [ ] Click it → focuses an existing Loopenta tab and deep-links to the referral.

## 7. Permissions — cross-org write rejection

As **Receiver**, open DevTools Console and try to write to a lead you don't own:

```js
firebase.firestore().collection('leads').doc('<some-id-from-another-org>').update({ status: 'closed_won' });
```

- [ ] Request fails with `PERMISSION_DENIED`.

Also:

- [ ] Open another user's `notificationPrefs` doc in the console — read fails.
- [ ] Try to create a `hubNotifications` doc with someone else's `createdBy` — write fails.

## 8. Role gates

Sign in once as each role and confirm the sidebar only shows relevant sections:

- [ ] Loan Officer → Hub Home, Team Activity (if manager), Referrals, Partner Network.
- [ ] Realtor → Listings, Buyer Pipeline, Referrals.
- [ ] Referral Partner → Partner Desk, Referrals.
- [ ] Title / Escrow → Title Desk or Escrow Desk respectively.
- [ ] Super Admin → everything.

---

## Reporting results

For each unchecked box: note what happened (screenshot + console output if errors). Send back and we'll chase down each one.
