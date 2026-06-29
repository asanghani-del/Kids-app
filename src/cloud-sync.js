// Optional Firebase-backed cross-device sync.
//
// This module is entirely opt-in: if firebase-config.js still has placeholder
// values, isCloudConfigured is false and nothing here ever runs or makes a
// network call. The rest of app.js falls back to pure localStorage behaviour,
// exactly as before.
//
// Firebase's own SDK and Firestore's offline persistence layer (enabled
// below) handle the "write while offline, sync when back online" problem,
// so we don't need to hand-roll a sync queue for cloud writes -- we just
// also mirror every local write to Firestore when signed in, and let
// Firestore's IndexedDB cache deal with retrying it once back online.
import { firebaseConfig } from './firebase-config.js';

const SDK_VERSION = '10.12.5';
const BASE = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;

export const isCloudConfigured = !!(firebaseConfig.apiKey && firebaseConfig.apiKey !== 'YOUR_API_KEY');

let app, auth, db;
let authMod, fsMod;
let loadPromise = null;

function loadFirebase() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const [appModule, authModule, fsModule] = await Promise.all([
      import(`${BASE}/firebase-app.js`),
      import(`${BASE}/firebase-auth.js`),
      import(`${BASE}/firebase-firestore.js`)
    ]);
    authMod = authModule;
    fsMod = fsModule;
    app = appModule.initializeApp(firebaseConfig);
    auth = authMod.getAuth(app);
    db = fsMod.getFirestore(app);
    try { await fsMod.enableIndexedDbPersistence(db); } catch { /* multiple tabs open, or unsupported browser: fine, just no offline cache */ }
    return { authMod, fsMod };
  })();
  return loadPromise;
}

export async function signUpParent(email, password) {
  await loadFirebase();
  return authMod.createUserWithEmailAndPassword(auth, email, password);
}
export async function signInParent(email, password) {
  await loadFirebase();
  return authMod.signInWithEmailAndPassword(auth, email, password);
}
export async function signOutParent() {
  await loadFirebase();
  return authMod.signOut(auth);
}
export async function resetParentPassword(email) {
  await loadFirebase();
  return authMod.sendPasswordResetEmail(auth, email);
}
// Calls callback(user|null) immediately and on every future auth change.
// Returns an unsubscribe function.
export async function onAuthChange(callback) {
  await loadFirebase();
  return authMod.onAuthStateChanged(auth, callback);
}

function collectionRef(uid, name) {
  return fsMod.collection(db, 'users', uid, name);
}
function docRef(uid, name, id) {
  return fsMod.doc(db, 'users', uid, name, id);
}

// Each subscribe* function returns an unsubscribe function. callback receives
// the full current array of documents every time anything changes (initial
// load, this device's own writes, or another device's writes).
export async function subscribeChildren(uid, callback) {
  await loadFirebase();
  return fsMod.onSnapshot(collectionRef(uid, 'children'), snap => {
    callback(snap.docs.map(d => ({ ...d.data(), id: d.id })));
  });
}
export async function subscribeAttempts(uid, callback) {
  await loadFirebase();
  return fsMod.onSnapshot(collectionRef(uid, 'attempts'), snap => {
    callback(snap.docs.map(d => ({ ...d.data(), id: d.id })));
  });
}
export async function subscribeLessonSummaries(uid, callback) {
  await loadFirebase();
  return fsMod.onSnapshot(collectionRef(uid, 'lessonSummaries'), snap => {
    callback(snap.docs.map(d => ({ ...d.data(), id: d.id })));
  });
}

export async function saveChildCloud(uid, child) {
  await loadFirebase();
  return fsMod.setDoc(docRef(uid, 'children', child.id), child);
}
export async function deleteChildCloud(uid, childId) {
  await loadFirebase();
  return fsMod.deleteDoc(docRef(uid, 'children', childId));
}
export async function saveAttemptCloud(uid, attempt) {
  await loadFirebase();
  return fsMod.setDoc(docRef(uid, 'attempts', attempt.id), attempt);
}
export async function saveLessonSummaryCloud(uid, summary) {
  await loadFirebase();
  return fsMod.setDoc(docRef(uid, 'lessonSummaries', summary.id), summary);
}
