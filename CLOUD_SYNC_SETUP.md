# Cross-device sync setup (optional)

By default this app works exactly as before: everything is saved to
`localStorage` on one device only. Following these steps turns on real
cross-device sync (e.g. Mac and iPad both see the same children, lessons,
and progress) using Firebase Authentication + Firestore, both on Firebase's
free "Spark" tier, which easily covers a personal/family use case.

If you skip this entirely, nothing changes — the app never contacts
Firebase unless it's configured below.

## 1. Create a Firebase project

1. Go to https://console.firebase.google.com
2. Click **Add project**, give it a name (e.g. "kids-maths-app"), and finish
   the wizard (Google Analytics is optional, you can decline it).

## 2. Register a web app

1. In your new project, click the **</>** (web) icon to add a web app.
2. Give it a nickname (e.g. "kids-maths-app-web"). You don't need Firebase
   Hosting for this — Netlify already covers that.
3. Firebase will show you a `firebaseConfig` object with `apiKey`,
   `authDomain`, `projectId`, etc. Copy it.

## 3. Fill in `src/firebase-config.js`

Paste your values in, replacing every `YOUR_...` placeholder:

```js
export const firebaseConfig = {
  apiKey: 'AIza...',
  authDomain: 'kids-maths-app-xxxxx.firebaseapp.com',
  projectId: 'kids-maths-app-xxxxx',
  storageBucket: 'kids-maths-app-xxxxx.appspot.com',
  messagingSenderId: '123456789',
  appId: '1:123456789:web:abcdef'
};
```

## 4. Turn on Email/Password sign-in

1. In the Firebase console, go to **Build → Authentication → Sign-in method**.
2. Enable **Email/Password**.
3. You don't need to pre-create a user here — the app's sign-in screen has
   a "Create account" option that does this for you the first time.

## 5. Create a Firestore database

1. Go to **Build → Firestore Database → Create database**.
2. Choose **Start in production mode** (the security rules below replace
   the default, so this is safe) and pick any region close to you.

## 6. Apply the security rules

1. In Firestore, go to the **Rules** tab.
2. Replace the contents with what's in `firestore.rules` in this project
   (it's a small, deliberately narrow version of the rules sketched out in
   the handoff bundle — scoped to just the 3 collections this app uses,
   nested under each signed-in user).
3. Click **Publish**.

## 7. Deploy and use it

1. Commit and push your filled-in `src/firebase-config.js`:
   ```
   git add src/firebase-config.js
   git commit -m "Enable cross-device sync"
   git push
   ```
2. Netlify redeploys automatically.
3. On your first device, open the app — you'll now see a sign-in screen.
   Tap **"First time? Create account"**, enter an email and password (this
   doesn't need to be a real inbox you check, just an email/password
   combination you'll remember and reuse on every device).
4. On your second device (e.g. the iPad), open the same Netlify URL and
   sign in with the **same email and password**. Children, attempts, and
   lesson history will sync automatically from then on.

## What this does and doesn't do

- **Syncs:** child profiles (including mastery/level), every question
  attempt, and every completed lesson summary.
- **Does not sync:** the parent PIN (still local-only, still not real
  security — see the comment in `app.js`), and the local-only
  `contentVersion`/refresh button state (these are device-level, not
  meaningful to share).
- **Offline behaviour:** Firestore caches data locally (via
  `enableIndexedDbPersistence`) and queues writes made while offline,
  syncing automatically once back online — no separate sync queue needed
  for cloud data, on top of the existing localStorage copy.
- **Security note:** anyone who knows the sign-in email/password can see
  this family's data — there's no per-child login, just one shared parent
  account. That's a reasonable tradeoff for a personal family tool, but
  worth knowing if you ever share the URL or credentials more widely.
