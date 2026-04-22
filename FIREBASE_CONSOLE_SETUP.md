# Firebase Setup — 5 Steps

## 1. Turn on Email/Password sign-in

**Click this link:** https://console.firebase.google.com/project/lmi-prospect-finder/authentication/providers

- Click **Email/Password**
- Flip the top toggle **on** (the "Email link" toggle below, leave off)
- Click **Save**

---

## 2. Upgrade to Blaze plan

**Click this link:** https://console.firebase.google.com/project/lmi-prospect-finder/usage/details

- Click **Modify plan** (or **Upgrade**)
- Pick **Blaze**
- Add your credit card
- When it asks for a budget alert, type **25** (dollars/month)
- Click **Purchase**

---

## 3. Download the service-account key

**Click this link:** https://console.firebase.google.com/project/lmi-prospect-finder/settings/serviceaccounts/adminsdk

- Click **Generate new private key**
- Confirm **Generate key**
- A file downloads to your computer. Remember where it goes.

---

## 4. Paste the key into Cloudflare

Open your Terminal (Mac: Spotlight → type "Terminal". Windows: Start → type "PowerShell").

Paste these in, one line at a time, pressing Enter after each:

```
cd ~/Desktop/lmi-tool
```

```
npx wrangler login
```

(browser opens → click **Allow** → come back)

```
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT
```

When it asks for the value:

- Double-click the downloaded `.json` file to open it in TextEdit / Notepad
- Select all (**Cmd+A** / **Ctrl+A**)
- Copy (**Cmd+C** / **Ctrl+C**)
- Click back into Terminal
- Paste (**Cmd+V** / **Ctrl+V**)
- Press **Enter**

You should see ✨ Successfully created secret.

---

## 5. Delete the downloaded file

Find the `.json` file from Step 3 → delete it → empty Trash.

---

## Done?

Reply **done**.
