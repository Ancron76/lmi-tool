# Migration Plan: DIY Auth → Firebase Auth

## Current state (what has to change)

- `/users/{uid}` docs store `password` in cleartext.
- `tryLogin()` in `index.html` (line ~5518) compares `u.password === pass` client-side.
- Sessions live in `sessionStorage.g1_session`; there is no Firebase Auth session.
- Invite acceptance (`submitInviteSetup`, ~line 1985) writes a new `/users/*` doc with the invitee's cleartext password.
- Realtor portal has its own login entry point but reuses the same DIY flow.
- Because no user is Firebase-authenticated, `request.auth` is always null, so Firestore rules that reference `request.auth` deny everything.

## Target state

- Every human user has a Firebase Auth account (email + password managed by Firebase).
- `tryLogin()` calls `firebase.auth().signInWithEmailAndPassword()` and awaits the ID token.
- A single `firebase.auth().onAuthStateChanged()` listener drives the show/hide of login/app/admin/realtor screens.
- The `currentUser` Firestore record is looked up by `firebase.auth().currentUser.uid` (which is now the canonical `id`).
- The `password` field on `/users/{uid}` does not exist.
- Invite acceptance creates a Firebase Auth account via `createUserWithEmailAndPassword()` and then writes the `/users/{uid}` record with `id = userCredential.user.uid`.
- The Cloudflare Worker has an admin-gated `/admin/migrate-users` endpoint that uses the Firebase Admin SDK to batch-create Firebase Auth accounts for every existing `/users/*` doc, setting their password to the current cleartext value, then clearing the `password` field. A `mustResetPassword: true` flag forces each user to pick a new password on first Firebase-Auth login.
- After all users migrate, Phase 1 Firestore rules (already written) become deployable.

## Migration approach (zero-downtime cutover)

1. **Ship the Worker migration endpoint.** Adds Firebase Admin SDK and a `/admin/migrate-users` route. Doesn't touch the app's login flow yet. Safe to deploy in isolation.
2. **Run the migration from the superadmin UI.** Iterates over `/users/*`, creates Firebase Auth accounts with the existing plaintext password, stamps the user doc with `firebaseAuthUid = <uid>` and `mustResetPassword = true`, then strips the `password` field.
3. **Deploy the new client code.** `tryLogin()` now calls Firebase Auth. Because the migration set each user's Firebase password to their existing cleartext password, everyone's existing password keeps working — they just authenticate through Firebase instead of the DIY comparison.
4. **Force password reset on first login.** If `mustResetPassword === true`, the UI blocks app access and shows a "set a new password" screen before continuing.
5. **Deploy Phase 1 Firestore rules.** Now that every read/write is authenticated, the rules file enforces role + tenant isolation.
6. **Deploy TOTP MFA (Phase 2B).** Enable the Console toggle; the app gates everyone into the enrollment flow on next login.

## Worker changes

Add to `worker.js`:

- `import { initializeApp, cert } from 'firebase-admin/app'` (or the compat equivalent compatible with Cloudflare Workers — firebase-admin doesn't run natively on Workers, so use `firebase-admin`-compatible HTTPS calls via `https://identitytoolkit.googleapis.com/v1/accounts:signUp` + service-account JWT signing instead).
- A Service-account JWT signer (RS256, using `crypto.subtle.sign` in the Worker runtime) so the Worker can mint OAuth2 tokens for the Firebase Admin REST API.
- Secrets:
  - `FIREBASE_SERVICE_ACCOUNT` — full service-account JSON, one line.
- Endpoints:
  - `POST /admin/migrate-users` — authenticated with `ADMIN_PASSWORD`. Body: `{ users: [{ email, password, uid }, ...] }`. Returns `{ migrated: n, failed: [{ email, err }, ...] }`.
  - `POST /admin/set-password` — admin-initiated password reset for a single user.

## Client changes (`index.html`)

Add near Firebase init (~line 4603):

```js
firebase.initializeApp(firebaseConfig);
const db   = firebase.firestore();
const auth = firebase.auth();
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
```

Replace `tryLogin()` body:

```js
async function tryLogin() {
  const email = document.getElementById('login-email').value.trim().toLowerCase();
  const pass  = document.getElementById('login-password').value;
  const btn   = document.querySelector('.login-btn');
  btn.textContent = 'Signing in...';
  try {
    const cred = await auth.signInWithEmailAndPassword(email, pass);
    // onAuthStateChanged takes over from here.
  } catch (err) {
    btn.textContent = 'Sign In';
    const el = document.getElementById('login-error');
    el.textContent = _authErrMessage(err);
    el.style.display = 'block';
    try { await db.collection('auditLog').add({
      action: 'login_failed', resource: 'auth', userId: null,
      userName: email, tenantId: '', errCode: err.code||'',
      timestamp: new Date().toISOString(), userAgent: navigator.userAgent
    }); } catch(e) {}
    // loginAttempts counter increment (Phase 4 lockout)
    try { await _bumpLoginAttempts(email); } catch(e) {}
  }
}
```

Replace `logout()` body:

```js
async function logout() {
  _auditLog('logout', 'auth', currentUser?.id||null, currentUser?.name||null, null);
  _clearSessionTimer();
  if (_featureFlagsUnsub) { try { _featureFlagsUnsub(); } catch(e){} _featureFlagsUnsub = null; }
  _featureFlags = {};
  try { await auth.signOut(); } catch(e) {}
  // onAuthStateChanged(null) takes over below.
}
```

Add the driver listener:

```js
auth.onAuthStateChanged(async function(fbUser){
  if (!fbUser) {
    // Show login screen, clear UI state.
    _resetLoggedOutState();
    return;
  }
  // Look up the Firestore user record.
  let uDoc = await db.collection('users').doc(fbUser.uid).get();
  if (!uDoc.exists) {
    // Try by email (legacy users not yet re-keyed to Firebase UID).
    const byEmail = await db.collection('users')
      .where('email','==',fbUser.email).limit(1).get();
    if (byEmail.empty) {
      await auth.signOut();
      alert('Your account is not provisioned. Contact your admin.');
      return;
    }
    uDoc = byEmail.docs[0];
    // One-time rekey: copy doc to /users/{fbUser.uid} and delete old.
    await db.collection('users').doc(fbUser.uid).set(
      Object.assign({}, uDoc.data(), { id: fbUser.uid, firebaseAuthUid: fbUser.uid })
    );
    await db.collection('users').doc(uDoc.id).delete();
    uDoc = await db.collection('users').doc(fbUser.uid).get();
  }
  currentUser = Object.assign({ id: fbUser.uid }, uDoc.data());
  if (currentUser.mustResetPassword) {
    _showForcedPasswordResetScreen();
    return;
  }
  if (currentUser.role === 'realtor') {
    const rLoginAgrOk = await _checkAgreementVersion();
    if (rLoginAgrOk) { await showRealtorPortal(); } else { showTOSModal(); }
    return;
  }
  await _postLoginSetup(currentUser);
});
```

Replace `submitInviteSetup()` (invite signup):

```js
async function submitInviteSetup(){
  const pw  = document.getElementById('invite-pw').value;
  const pw2 = document.getElementById('invite-pw-confirm').value;
  if (pw.length < 12) { _toast('Password must be at least 12 characters'); return; }
  if (pw !== pw2) { _toast('Passwords do not match'); return; }
  // Password policy (Phase 3) — complexity + HaveIBeenPwned will be
  // added here. Until then, just the length check.
  try {
    const cred = await auth.createUserWithEmailAndPassword(
      inviteUserData.email, pw
    );
    await db.collection('users').doc(cred.user.uid).set({
      id: cred.user.uid,
      firebaseAuthUid: cred.user.uid,
      name: inviteUserData.name,
      email: inviteUserData.email,
      role: inviteUserData.role,
      type: inviteUserData.type,
      region: inviteUserData.region,
      active: true,
      branches: [],
      created: new Date().toLocaleDateString(),
      accountStatus: 'active',
      subscriptionTier: 'team',
      subscriptionStatus: 'active',
      orgId: inviteUserData.orgId || '',
      mfaEnrolled: false,
      mustResetPassword: false,
      linkedMloId: inviteUserData.linkedMloId || '',
      realtorDocId: inviteUserData.realtorDocId || '',
    });
    await db.collection('invites').doc(inviteUserData.token).update({
      used: true, usedAt: new Date().toISOString(), usedBy: cred.user.uid
    });
    // onAuthStateChanged will pick up from here.
  } catch (err) {
    _toast(_authErrMessage(err));
  }
}
```

Delete `getSessionUser()`/sessionStorage restore logic — replaced by `onAuthStateChanged`.

Remove every `sessionStorage.setItem('g1_session', ...)` and `sessionStorage.getItem('g1_session')` — Firebase Auth persistence replaces it.

Remove the plaintext `password` field from any client-side user-creation code (admin "Add MLO", etc.) — those now call `/admin/create-user` on the Worker, which uses Admin SDK to create the Auth account without cleartext touching Firestore.

## Forced-password-reset screen

A new `<div id="forced-reset-screen">` with two password fields and a "Continue" button. On submit:

```js
async function submitForcedReset(){
  const pw  = document.getElementById('fr-pw').value;
  const pw2 = document.getElementById('fr-pw-confirm').value;
  if (!_validateNewPassword(pw)) return;
  if (pw !== pw2) { _toast('Passwords do not match'); return; }
  try {
    await auth.currentUser.updatePassword(pw);
    await db.collection('users').doc(auth.currentUser.uid).update({
      mustResetPassword: false,
      passwordChangedAt: new Date().toISOString()
    });
    _auditLog('password_reset_forced', 'auth', auth.currentUser.uid,
              currentUser.name, null);
    // Restart post-login flow.
    document.getElementById('forced-reset-screen').style.display = 'none';
    await _postLoginSetup(currentUser);
  } catch (err) {
    if (err.code === 'auth/requires-recent-login') {
      // Re-auth prompt.
      ...
    }
  }
}
```

## Testing plan

Test each flow end-to-end in an isolated worktree before merging:

1. Fresh login with migrated user → forced password reset → app loads
2. Already-reset user login → straight into app
3. Invite flow → creates Firebase Auth user + Firestore record, logs in
4. Realtor portal login
5. Logout → returns to login screen, sessionStorage cleared
6. Page refresh mid-session → stays logged in via Firebase persistence
7. Failed login → auditLog entry + loginAttempts increment
8. Admin "Add MLO" → Worker creates Auth account + Firestore record
9. Firestore rules deployed → all flows still work

## Rollback

- Worker migration endpoint is idempotent: re-running skips users who already have `firebaseAuthUid`.
- If the client rewrite breaks anything critical, revert index.html to the previous commit. The Firebase Auth accounts stay — no data loss.
- Firestore rules can be rolled back via Console history tab in one click.
