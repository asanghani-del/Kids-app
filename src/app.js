import {
  isCloudConfigured, onAuthChange, signInParent, signUpParent, signOutParent,
  subscribeChildren, subscribeAttempts, subscribeLessonSummaries,
  saveChildCloud, saveAttemptCloud, saveLessonSummaryCloud, resetParentPassword
} from './cloud-sync.js';

const storeKey = 'kidsMathsTutor.v1';
const app = document.querySelector('#app');
// A login maps to exactly one learner. This single-item default is only
// used in fully offline mode (no Firebase configured); a signed-in account
// gets its profile from the createProfile screen instead.
const defaultProfiles = [
  { id: 'child-a', name: 'Ava', avatar: '🦊', stage: 'Reception into Year 1', microLevel: 1, mastery: { add_1_within_10: 0.35, bonds_to_10_missing_addend: 0.2 } }
];
const state = loadState();
let route = { screen: 'home' };
let lessonSession = null;
let seed = null;
let misconceptionRules = null;
// Cloud sync state: cloudUser is the signed-in Firebase user (or null if
// not using cloud sync at all, or not yet signed in on this device).
let cloudUser = null;
let cloudUnsubscribers = [];
let authError = '';
let resetMessage = '';

init();

async function init() {
  [seed, misconceptionRules] = await Promise.all([
    fetch('/data/seed-content.json').then(r => r.json()).catch(() => ({ questionTemplates: [] })),
    fetch('/data/misconception-rules.json').then(r => r.json()).catch(() => ({ rules: [] }))
  ]);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  window.addEventListener('online', render);
  window.addEventListener('offline', render);
  if (isCloudConfigured) {
    route = { screen: 'signIn' };
    onAuthChange(handleAuthChange);
  }
  render();
}

// Called once at startup (with whatever Firebase already knows from a
// previous session on this device) and again any time the user signs in
// or out. Wires up live Firestore listeners so changes made on *any*
// signed-in device show up here automatically, and vice versa.
function handleAuthChange(user) {
  cloudUser = user;
  cloudUnsubscribers.forEach(unsub => unsub());
  cloudUnsubscribers = [];
  if (!user) {
    // Each login owns exactly one learner's data, so a different account
    // signing in on this device must not inherit whatever was showing.
    state.profiles = [];
    state.currentProfileId = null;
    if (route.screen !== 'signIn') setRoute('signIn');
    return;
  }
  let sawChildrenYet = false;
  Promise.all([
    subscribeChildren(user.uid, children => {
      // Two devices can both edit the same learner offline (e.g. each
      // finishing a lesson before either reconnects). Firestore's snapshot
      // here is just "whatever document is currently stored" -- a naive
      // overwrite would let one device's write silently erase the other's
      // progress. Merge field-by-field against whatever this device
      // already has in memory, then push the merged result back to the
      // cloud so both devices converge on the same, more-complete profile.
      // While admin test mode is on, state.profiles holds the sandbox
      // profile, not the real one -- the real snapshot is parked in the
      // stash and applied once admin mode exits, instead of overwriting
      // the sandbox or getting merged against it.
      const incoming = children.slice(0, 1);
      const target = state.adminMode ? state._stash : state;
      target.profiles = incoming.map(remote => {
        const local = target.profiles.find(p => p.id === remote.id);
        if (!local) return remote;
        const merged = mergeProfiles(local, remote);
        if (JSON.stringify(merged) !== JSON.stringify(remote)) {
          saveChildCloud(user.uid, merged).catch(() => {});
        }
        return merged;
      });
      if (!target.profiles.find(p => p.id === target.currentProfileId)) {
        target.currentProfileId = target.profiles[0]?.id || null;
      }
      saveState();
      if (!sawChildrenYet) {
        sawChildrenYet = true;
        // First snapshot after sign-in tells us whether this account has
        // already set up its one learner, or needs to do that now.
        if (!state.adminMode) setRoute(target.profiles.length ? 'home' : 'createProfile');
      } else {
        render();
      }
    }),
    subscribeAttempts(user.uid, attempts => {
      if (state.adminMode) { state._stash.attempts = attempts; saveState(); return; }
      state.attempts = attempts; saveState(); render();
    }),
    subscribeLessonSummaries(user.uid, summaries => {
      if (state.adminMode) { state._stash.lessonSummaries = summaries; saveState(); return; }
      state.lessonSummaries = summaries; saveState(); render();
    })
  ]).then(unsubs => { cloudUnsubscribers = unsubs; });
}

function loadState() {
  const saved = localStorage.getItem(storeKey);
  const defaults = {
    profiles: defaultProfiles,
    attempts: [],
    lessonSummaries: [],
    // NOTE: this PIN is a speed-bump to stop a young child wandering into
    // the parent area, NOT a security control. It is stored in plain text
    // in localStorage and is readable/editable by anyone with device access
    // or devtools. Do not reuse this pattern for anything that needs real
    // authentication (e.g. account access, payments, data export to a server).
    parentPin: '1234',
    contentVersion: 1,
    currentProfileId: null,
    adminMode: false,
    sandboxProfile: null,
    sandboxAttempts: [],
    sandboxLessonSummaries: [],
    _stash: null
  };
  if (!saved) return defaults;
  try {
    return { ...defaults, ...JSON.parse(saved) };
  } catch {
    return defaults;
  }
}
function saveState() { localStorage.setItem(storeKey, JSON.stringify(state)); }
function html(strings, ...values) { return strings.map((s, i) => s + (values[i] ?? '')).join(''); }
function setRoute(screen, data = {}) { clearQuestionTimer(); route = { screen, ...data }; render(); }
function currentProfile() { return state.profiles.find(p => p.id === state.currentProfileId) || state.profiles[0]; }
// Combines two copies of the same learner profile (this device's in-memory
// copy and a Firestore snapshot from possibly-another-device) into one
// that never loses progress either side made. Every field here is
// monotonic -- mastery/tiers/level only ever go up as a child practises,
// so "take the higher value" can't accidentally undo real progress in
// either direction, unlike a raw last-write-wins overwrite would.
function mergeProfiles(a, b) {
  const mergeNumberMap = (x = {}, y = {}) => {
    const out = { ...x };
    for (const key of Object.keys(y)) out[key] = Math.max(out[key] ?? -Infinity, y[key]);
    return out;
  };
  const newer = (a.updatedAt || 0) >= (b.updatedAt || 0) ? a : b;
  const streak = (a.streak?.lastActiveDate || '') >= (b.streak?.lastActiveDate || '')
    ? a.streak : b.streak;
  const speedBest = { ...(a.speedBest || {}), ...(b.speedBest || {}) };
  for (const key of Object.keys(b.speedBest || {})) {
    const x = a.speedBest?.[key], y = b.speedBest[key];
    speedBest[key] = !x ? y : (y.correctCount ?? y.correctAmount ?? 0) > (x.correctCount ?? x.correctAmount ?? 0) ? y : x;
  }
  return {
    ...newer,
    id: a.id,
    mastery: mergeNumberMap(a.mastery, b.mastery),
    skillTiers: mergeNumberMap(a.skillTiers, b.skillTiers),
    skillLastSeenLesson: mergeNumberMap(a.skillLastSeenLesson, b.skillLastSeenLesson),
    microLevel: Math.max(a.microLevel || 1, b.microLevel || 1),
    totalPoints: Math.max(a.totalPoints || 0, b.totalPoints || 0),
    badgesEarned: [...new Set([...(a.badgesEarned || []), ...(b.badgesEarned || [])])],
    reviewSkillIds: [...new Set([...(a.reviewSkillIds || []), ...(b.reviewSkillIds || [])])],
    streak,
    speedBest,
    seenModeIntro: !!(a.seenModeIntro || b.seenModeIntro),
    updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0)
  };
}
function escapeText(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
function shell(content) {
  app.innerHTML = `<main class="app-shell"><section class="card">${content}</section></main>`;
  bindGlobalButtons();
  focusMainHeading();
}
function focusMainHeading() {
  // Re-rendering via innerHTML drops focus entirely, which strands
  // keyboard and screen-reader users on every screen change. Move focus
  // to the screen's main heading (falling back to the card itself) so
  // assistive tech announces the new screen and tabbing resumes sensibly.
  const heading = app.querySelector('h1, h2');
  const target = heading || app.querySelector('.card');
  if (!target) return;
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: false });
}
function statusPill() { return `<span class="offline">${navigator.onLine ? 'Online, ready to refresh' : 'Offline, lesson bank available'}</span>`; }
function authBadge() {
  if (!isCloudConfigured || !cloudUser) return '';
  const profile = currentProfile();
  return `<span class="badge" title="${escapeText(cloudUser.email)}">${profile?.avatar || '☁️'} <button class="ghost" data-signout>Sign out</button></span>`;
}
function bindGlobalButtons() {
  document.querySelectorAll('[data-route]').forEach(btn => btn.addEventListener('click', () => setRoute(btn.dataset.route)));
  document.querySelectorAll('[data-speak]').forEach(btn => btn.addEventListener('click', () => speak(btn.dataset.speak)));
  document.querySelectorAll('[data-signout]').forEach(btn => btn.addEventListener('click', () => { signOutParent().catch(() => {}); }));
}
// The browser's default TTS voice (often an old robotic-sounding compact
// voice) is rarely the nicest one actually installed -- most platforms also
// ship at least one much more natural-sounding voice (Edge/Windows "Natural"
// neural voices, Chrome's "Google UK English Female", Safari's "Samantha"/
// "Kate"/"Serena"), it's just not selected by default. We rank whatever
// `getVoices()` returns and cache the best match, since voice lists load
// asynchronously in some browsers (notably Chrome) and querying them is
// otherwise a bit slow to repeat on every single "Hear" tap.
let cachedVoice;
function pickVoice() {
  if (cachedVoice !== undefined) return cachedVoice;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null; // not loaded yet -- caller will retry
  const score = v => {
    const name = v.name.toLowerCase();
    let s = 0;
    if (v.lang?.startsWith('en-GB')) s += 5;
    else if (v.lang?.startsWith('en')) s += 2;
    if (name.includes('natural')) s += 10; // Edge/Windows neural voices
    if (/google uk english female|google us english/.test(name)) s += 8;
    if (/samantha|kate|serena|stephanie/.test(name)) s += 7; // Apple voices
    if (name.includes('female')) s += 3;
    if (/compact|robot|espeak/.test(name)) s -= 10;
    return s;
  };
  cachedVoice = [...voices].sort((a, b) => score(b) - score(a))[0] || null;
  return cachedVoice;
}
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = pickVoice();
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  } else {
    utterance.lang = 'en-GB';
    // Voices not loaded yet (common on first call in Chrome) -- pick one as
    // soon as they arrive so the *next* "Hear" tap sounds natural too.
    speechSynthesis.addEventListener('voiceschanged', () => { cachedVoice = undefined; }, { once: true });
  }
  // Slightly higher pitch and a touch slower than 1x reads as warmer and
  // clearer for young children than the flat, fast monotone most engines
  // default to -- this is what actually fixes "robotic", more than voice
  // choice alone.
  utterance.pitch = 1.08;
  utterance.rate = 0.92;
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}

function render() {
  if (!seed) return;
  const screens = { signIn, resetPassword, createProfile, home, learningProgressionPath, skillsArea, learningZone, timesTablesHub, fractionsLibrary, numberBondsChart, moneyReference, speedTestSetup, lesson, results, review, celebration, parentGate, parentDashboard, sessionDetail, adminLogin };
  screens[route.screen]?.();
}

function signIn() {
  shell(html`
    <h1>Sign in</h1>
    <p>Sign in once on this device to sync lessons and progress across your devices. Use the same email and password on each device/browser.</p>
    <div class="grid" style="max-width:380px">
      <label class="small">Email<input class="field" type="email" id="signin-email" autocomplete="email"></label>
      <label class="small">Password
        <div class="password-row">
          <input class="field" type="password" id="signin-password" autocomplete="current-password">
        </div>
      </label>
      <label class="check-row"><input type="checkbox" id="signin-show-password"> Show password</label>
      <button class="link-button" data-forgot style="text-align:left; width:fit-content">Forgotten password?</button>
      <p class="small" id="signin-error">${escapeText(authError)}</p>
      <button class="primary cta-large" data-signin>Sign in</button>
      <button class="ghost" data-signup>First time? Create account</button>
    </div>
  `);
  document.querySelector('[data-signin]').addEventListener('click', () => submitAuth(signInParent));
  document.querySelector('[data-signup]').addEventListener('click', () => submitAuth(signUpParent));
  document.querySelector('#signin-show-password').addEventListener('change', e => {
    document.querySelector('#signin-password').type = e.target.checked ? 'text' : 'password';
  });
  document.querySelector('[data-forgot]').addEventListener('click', () => { resetMessage = ''; setRoute('resetPassword'); });
}
async function submitAuth(authFn) {
  const email = document.querySelector('#signin-email').value.trim();
  const password = document.querySelector('#signin-password').value;
  authError = '';
  if (!email || !password) { authError = 'Please enter both email and password.'; render(); return; }
  try {
    await authFn(email, password);
    authError = '';
  } catch (err) {
    authError = err?.message || 'Sign in failed. Please try again.';
    render();
  }
}
function resetPassword() {
  shell(html`
    <h1>Reset password</h1>
    <p>Enter the email you sign in with. We'll send a link to set a new password.</p>
    <div class="grid" style="max-width:380px">
      <label class="small">Email<input class="field" type="email" id="reset-email" autocomplete="email"></label>
      <p class="small" id="reset-message">${escapeText(resetMessage)}</p>
      <button class="primary cta-large" data-send-reset>Send reset link</button>
      <button class="ghost" data-route="signIn">Back to sign in</button>
    </div>
  `);
  document.querySelector('[data-send-reset]').addEventListener('click', async () => {
    const email = document.querySelector('#reset-email').value.trim();
    if (!email) { resetMessage = 'Please enter your email.'; render(); return; }
    try {
      await resetParentPassword(email);
      resetMessage = 'Check your email for a link to reset your password.';
    } catch (err) {
      resetMessage = err?.message || 'Could not send the reset email. Please try again.';
    }
    render();
  });
}

function createProfile() {
  shell(html`
    <h1>Set up your learner</h1>
    <p>This account is linked to one child. You can edit these details anytime from the Parent Area.</p>
    <div class="grid" style="max-width:420px">
      <label class="small">Name<input class="field" id="profile-name" placeholder="Name" maxlength="24"></label>
      <label class="small">Avatar<input class="field" id="profile-avatar" placeholder="🐧" maxlength="2" value="🐧"></label>
      <label class="small">Stage<input class="field" id="profile-stage" placeholder="Reception into Year 1" maxlength="40" value="Reception into Year 1"></label>
      <p class="small" id="profile-error"></p>
      <button class="primary cta-large" data-create-profile>Start learning</button>
    </div>
  `);
  document.querySelector('[data-create-profile]').addEventListener('click', () => {
    const name = document.querySelector('#profile-name').value.trim();
    const avatar = document.querySelector('#profile-avatar').value.trim() || '🐧';
    const stage = document.querySelector('#profile-stage').value.trim() || 'Reception into Year 1';
    const errorEl = document.querySelector('#profile-error');
    if (!name) { errorEl.textContent = 'Please enter a name.'; return; }
    const profile = { id: `child-${Date.now()}`, name, avatar, stage, microLevel: 1, mastery: {}, updatedAt: Date.now() };
    state.profiles = [profile];
    state.currentProfileId = profile.id;
    saveState();
    if (cloudWritesEnabled()) saveChildCloud(cloudUser.uid, profile).catch(() => {});
    setRoute('home');
  });
}

// Home *is* the mode-select screen now -- a separate "Start Lesson" holding
// page with per-skill stat boxes duplicated the parent dashboard's own
// breakdown and added an extra tap before a child could actually do
// anything. Greeting/streak/points stay (they're motivational, kid-facing),
// but the numeric "Level X of 12" is replaced with the animal badge below;
// the raw tier number is parent-area-only now (see parentDashboard).
const MODE_INTRO = [
  { icon: '📚', label: 'Learning Progression', text: "Your everyday lesson — a mix of everything, at just the right level for you." },
  { icon: '⏱️', label: 'Speed Test', text: 'Quick-fire questions against the clock — great for when you want to beat your best score!' },
  { icon: '🎯', label: 'Skills Area', text: "Stuck on something, like fractions or times tables? Pick it here and practise just that." },
  { icon: '🧩', label: 'Learning Zone', text: 'A place to look things up and learn, like the times tables grid, before you get tested on them.' }
];
function home() {
  if (!state.profiles.length) return setRoute('createProfile');
  const profile = currentProfile();
  const animal = animalForTier(profile.microLevel || 1);
  const showIntro = route.showIntro || !profile?.seenModeIntro;
  shell(html`
    <div class="home-wrap">
    <div class="top-row"><div></div><div class="nav">${state.adminMode ? '<span class="badge" style="background:#f4d35e">🧪 Admin test mode</span><button class="ghost" data-exit-admin>Exit</button>' : ''}<button class="ghost" data-route="parentGate">Parent Area</button>${statusPill()}${authBadge()}</div></div>
    <h1>Hello, ${escapeText(profile.name)}</h1>
    <div class="rewards-row">
      <span class="reward-chip">${animal.emoji} ${escapeText(animal.name)}</span>
      <span class="reward-chip">🔥 ${profile.streak?.count || 0}-day streak</span>
      <span class="reward-chip">⭐ ${profile.totalPoints || 0} points</span>
      ${(profile.badgesEarned || []).length ? `<span class="reward-chip">🏅 ${profile.badgesEarned.length} badge${profile.badgesEarned.length === 1 ? '' : 's'}</span>` : ''}
    </div>
    ${showIntro ? '' : html`<button class="link-button" data-show-intro style="margin-bottom:10px">What do these mean?</button>`}
    <div class="grid mode-grid">
      <button class="mode-card" data-route="learningProgressionPath">
        <strong>📚 Learning Progression</strong>
        <span class="small">Your next lesson</span>
      </button>
      <button class="mode-card" data-route="speedTestSetup">
        <strong>⏱️ Speed Test</strong>
        <span class="small">Beat the clock</span>
      </button>
      <button class="mode-card" data-route="skillsArea">
        <strong>🎯 Skills Area</strong>
        <span class="small">Pick a topic</span>
      </button>
      <button class="mode-card" data-route="learningZone">
        <strong>🧩 Learning Zone</strong>
        <span class="small">Look things up</span>
      </button>
    </div>
    </div>
    ${showIntro ? html`
      <div class="modal-overlay">
        <div class="modal-card">
          <h2>Four ways to practise</h2>
          <div class="grid" style="gap:8px">
            ${MODE_INTRO.map(m => `<div class="nudge-row">${m.icon} <strong>${escapeText(m.label)}</strong> — ${escapeText(m.text)}</div>`).join('')}
          </div>
          <button class="primary cta-large" style="margin-top:12px" data-dismiss-intro>Got it, let's go!</button>
        </div>
      </div>
    ` : ''}
  `);
  document.querySelector('[data-dismiss-intro]')?.addEventListener('click', () => {
    if (profile) {
      profile.seenModeIntro = true;
      profile.updatedAt = Date.now();
      saveState();
      if (cloudWritesEnabled()) saveChildCloud(cloudUser.uid, profile).catch(() => {});
    }
    setRoute('home');
  });
  document.querySelector('[data-show-intro]')?.addEventListener('click', () => setRoute('home', { showIntro: true }));
  document.querySelector('[data-exit-admin]')?.addEventListener('click', exitAdminMode);
}
// A simple, fun "path" visualisation for Learning Progression: stepping
// stones for a window of lesson numbers around the next one, joined by a
// different mode-of-transport emoji each gap (purely decorative variety),
// with the child's current animal badge sitting on today's stone. Replaces
// jumping straight from the mode card into the lesson with no context, and
// doubles as the "did I pick the wrong mode?" Back point requested.
const TRANSPORT_EMOJI = ['🚲', '⛵', '🚂', '✈️', '🚀', '🎈'];
function learningProgressionPath() {
  const profile = currentProfile();
  const completedCount = state.lessonSummaries.filter(l => l.childId === profile.id).length;
  const nextLessonNumber = completedCount + 1;
  const animal = animalForTier(profile.microLevel || 1);
  const start = Math.max(1, nextLessonNumber - 3);
  const end = nextLessonNumber + 3;
  const stones = [];
  for (let n = start; n <= end; n++) stones.push(n);
  shell(html`
    <div class="top-row"><button class="ghost" data-route="home">Back</button><div class="nav">${authBadge()}</div></div>
    <h1>Learning Progression</h1>
    <p class="small">${animal.emoji} ${escapeText(animal.name)}</p>
    <div class="stepping-path">
      ${stones.map((n, i) => {
        const isDone = n < nextLessonNumber;
        const isCurrent = n === nextLessonNumber;
        const isFuture = n > nextLessonNumber;
        return `<div class="stone-group">
          <div class="stone ${isDone ? 'done' : ''} ${isCurrent ? 'current' : ''} ${isFuture ? 'future' : ''}">
            ${isCurrent ? animal.emoji : (isDone ? '✓' : n)}
            <span class="stone-label">${isFuture ? 'Lesson ' + n : (isCurrent ? 'Today' : 'Lesson ' + n)}</span>
          </div>
          ${i < stones.length - 1 ? `<span class="transport">${TRANSPORT_EMOJI[i % TRANSPORT_EMOJI.length]}</span>` : ''}
        </div>`;
      }).join('')}
    </div>
    <button class="primary cta-large" data-start-progression>Start Lesson ${nextLessonNumber}</button>
  `);
  document.querySelector('[data-start-progression]').addEventListener('click', startLesson);
}

// Learning Zone: a reference-and-practice hub, distinct from the other
// three modes (which are all "answer N questions now"). A child can look
// facts up here before being tested on them. Times tables is the only
// topic wired up so far -- the grid below intentionally shows the others
// as locked placeholders so the mode reads as a real section that'll grow,
// not a one-off times-tables screen.
const LEARNING_ZONE_TOPICS = [
  { id: 'times_tables', label: 'Times Tables', icon: '✖️', route: 'timesTablesHub' },
  { id: 'fractions', label: 'Fractions', icon: '🍕', route: 'fractionsLibrary' },
  { id: 'number_bonds', label: 'Number Bonds', icon: '🔗', route: 'numberBondsChart' },
  { id: 'money', label: 'Money', icon: '💰', route: 'moneyReference' }
];
function learningZone() {
  shell(html`
    <div class="top-row"><button class="ghost" data-route="home">Back</button><div class="nav">${authBadge()}</div></div>
    <h1>Learning Zone</h1>
    <div class="grid mode-grid">
      ${LEARNING_ZONE_TOPICS.map(t => `<button class="mode-card" data-zone-topic="${t.id}">
        <strong>${t.icon} ${escapeText(t.label)}</strong>
      </button>`).join('')}
    </div>
  `);
  document.querySelectorAll('[data-zone-topic]').forEach(btn => {
    btn.addEventListener('click', () => setRoute(LEARNING_ZONE_TOPICS.find(t => t.id === btn.dataset.zoneTopic).route));
  });
}
function timesTablesGridHtml(quizMode) {
  const nums = Array.from({ length: 12 }, (_, i) => i + 1);
  return `<div class="times-grid-wrap"><table class="times-grid">
    <thead><tr><th></th>${nums.map(n => `<th>${n}</th>`).join('')}</tr></thead>
    <tbody>${nums.map(r => `<tr><th>${r}</th>${nums.map(c => {
      const val = r * c;
      return quizMode ? `<td class="grid-hidden" data-answer="${val}">?</td>` : `<td>${val}</td>`;
    }).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}
function timesTablesHub() {
  const profile = currentProfile();
  const selected = route.factor || null;
  const showGrid = !!route.showGrid;
  const quizMode = !!route.quizMode;
  shell(html`
    <div class="top-row"><button class="ghost" data-route="learningZone">Back</button><div class="nav">${authBadge()}</div></div>
    <h1>Times Tables</h1>
    <div class="nav" style="margin-bottom:12px">
      <button class="secondary" data-toggle-grid>${showGrid ? 'Hide' : 'Show'} grid</button>
      ${showGrid ? `<button class="secondary" data-toggle-quiz>${quizMode ? 'Show all answers' : 'Hide answers (quiz me!)'}</button>` : ''}
    </div>
    ${showGrid ? timesTablesGridHtml(quizMode) : ''}
    <div class="grid" style="grid-template-columns:repeat(6,1fr);gap:8px;margin-bottom:14px">
      ${Array.from({ length: 12 }, (_, i) => i + 1).map(n => `<button class="topic-card ${selected === n ? 'selected' : ''}" style="padding:10px 4px" data-factor="${n}" aria-pressed="${selected === n}">
        <strong>${n}×</strong>
      </button>`).join('')}
    </div>
    ${selected ? `
      <div class="dashboard-card">
        <h2>The ${selected} times table</h2>
        <div class="grid" style="grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:14px">
          ${Array.from({ length: 12 }, (_, i) => i + 1).map(i => `<div class="nudge-row" style="text-align:center">${i} × ${selected} = ${i * selected}</div>`).join('')}
        </div>
        <button class="primary cta-large" data-practice-factor="${selected}">Practise the ${selected}× table</button>
      </div>
    ` : ''}
  `);
  document.querySelector('[data-toggle-grid]').addEventListener('click', () => setRoute('timesTablesHub', { factor: selected, showGrid: !showGrid, quizMode }));
  document.querySelector('[data-toggle-quiz]')?.addEventListener('click', () => setRoute('timesTablesHub', { factor: selected, showGrid, quizMode: !quizMode }));
  document.querySelectorAll('[data-factor]').forEach(btn => {
    btn.addEventListener('click', () => setRoute('timesTablesHub', { factor: Number(btn.dataset.factor), showGrid, quizMode }));
  });
  const practiceBtn = document.querySelector('[data-practice-factor]');
  if (practiceBtn) practiceBtn.addEventListener('click', () => startFactorPractice(Number(practiceBtn.dataset.practiceFactor)));
  // Revealing an answer is a direct DOM tweak rather than a full render()
  // -- a re-render would be triggered by every single tap for a purely
  // decorative 3-second peek, and would also wipe out anyone else's
  // in-progress reveal timers elsewhere in the grid.
  document.querySelectorAll('.grid-hidden[data-answer]').forEach(td => {
    td.addEventListener('click', () => {
      if (td.classList.contains('revealed')) return;
      td.textContent = td.dataset.answer;
      td.classList.add('revealed');
      setTimeout(() => {
        td.textContent = '?';
        td.classList.remove('revealed');
      }, 3000);
    });
  });
  void profile;
}
// A reference library a parent can sit and teach from -- every denominator
// 2-12 shown as a row of fraction circles (1/n through n/n), reusing the
// same fractionCircleSvg renderer questions already use, so what's taught
// here visually matches what shows up in lesson questions later.
const FRACTION_DENOMS = [2, 3, 4, 5, 6, 8, 10, 12];
function fractionsLibrary() {
  const selected = route.denom || null;
  shell(html`
    <div class="top-row"><button class="ghost" data-route="learningZone">Back</button><div class="nav">${authBadge()}</div></div>
    <h1>Fractions</h1>
    <div class="grid" style="grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px">
      ${FRACTION_DENOMS.map(d => `<button class="topic-card ${selected === d ? 'selected' : ''}" style="padding:10px 4px" data-denom="${d}">
        <strong>${d === 2 ? 'Halves' : d === 3 ? 'Thirds' : d === 4 ? 'Quarters' : `${d}ths`}</strong>
      </button>`).join('')}
    </div>
    ${selected ? `
      <div class="dashboard-card">
        <h2>${selected === 2 ? 'Halves' : selected === 3 ? 'Thirds' : selected === 4 ? 'Quarters' : `${selected}ths`}</h2>
        <div class="grid" style="grid-template-columns:repeat(auto-fit, minmax(110px, 1fr));gap:14px;margin-bottom:14px;text-align:center">
          ${Array.from({ length: selected }, (_, i) => i + 1).map(n => `<div>
            <div style="width:90px;height:90px;margin:0 auto">${fractionCircleSvg(selected, n)}</div>
            <strong>${n}/${selected}</strong>
          </div>`).join('')}
        </div>
        <button class="primary cta-large" data-practice-skill="fractions_visual">Practise fractions</button>
      </div>
    ` : ''}
  `);
  document.querySelectorAll('[data-denom]').forEach(btn => {
    btn.addEventListener('click', () => setRoute('fractionsLibrary', { denom: Number(btn.dataset.denom) }));
  });
  document.querySelector('[data-practice-skill]')?.addEventListener('click', e => startSkillPractice(e.target.dataset.practiceSkill));
}
// Bonds to 10 and bonds to 20 as a flip-card style wall chart -- quiz mode
// hides the second addend (tap to reveal for 3s), same interaction as the
// times-tables grid's quiz mode, so the two reference tools feel consistent.
function numberBondsChart() {
  const target = route.bondsTo || 10;
  const quizMode = !!route.quizMode;
  const rows = Array.from({ length: target - 1 }, (_, i) => i + 1);
  shell(html`
    <div class="top-row"><button class="ghost" data-route="learningZone">Back</button><div class="nav">${authBadge()}</div></div>
    <h1>Number Bonds</h1>
    <div class="nav" style="margin-bottom:12px">
      <button class="secondary ${target === 10 ? 'selected' : ''}" data-bonds="10">Bonds to 10</button>
      <button class="secondary ${target === 20 ? 'selected' : ''}" data-bonds="20">Bonds to 20</button>
      <button class="secondary" data-toggle-quiz>${quizMode ? 'Show all answers' : 'Hide answers (quiz me!)'}</button>
    </div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:8px;margin-bottom:14px">
      ${rows.map(n => `<div class="nudge-row" style="text-align:center">${n} + ${quizMode ? `<span class="grid-hidden" data-answer="${target - n}">?</span>` : (target - n)} = ${target}</div>`).join('')}
    </div>
    <button class="primary cta-large" data-practice-skill="${target === 10 ? 'number_bonds_to_10' : 'number_bonds_to_20'}">Practise number bonds</button>
  `);
  document.querySelectorAll('[data-bonds]').forEach(btn => {
    btn.addEventListener('click', () => setRoute('numberBondsChart', { bondsTo: Number(btn.dataset.bonds), quizMode }));
  });
  document.querySelector('[data-toggle-quiz]').addEventListener('click', () => setRoute('numberBondsChart', { bondsTo: target, quizMode: !quizMode }));
  document.querySelector('[data-practice-skill]').addEventListener('click', e => startSkillPractice(e.target.dataset.practiceSkill));
  document.querySelectorAll('.grid-hidden[data-answer]').forEach(span => {
    span.addEventListener('click', () => {
      if (span.classList.contains('revealed')) return;
      span.textContent = span.dataset.answer;
      span.classList.add('revealed');
      setTimeout(() => { span.textContent = '?'; span.classList.remove('revealed'); }, 3000);
    });
  });
}
// UK coin reference -- every coin a child will see in money questions,
// shown at once as a simple lookup chart for a parent to point at and name.
function moneyReference() {
  shell(html`
    <div class="top-row"><button class="ghost" data-route="learningZone">Back</button><div class="nav">${authBadge()}</div></div>
    <h1>Money</h1>
    <div class="coin-row" style="flex-wrap:wrap;gap:14px;margin-bottom:18px">
      ${COINS.map(c => `<span class="coin" style="font-size:1.3rem;padding:18px 22px">${c >= 100 ? '£' + c / 100 : c + 'p'}</span>`).join('')}
    </div>
    <div class="dashboard-card">
      <h2>Ways to make 50p</h2>
      <div class="grid" style="gap:6px">
        <div class="nudge-row">50p = one 50p coin</div>
        <div class="nudge-row">50p = two 20p + one 10p</div>
        <div class="nudge-row">50p = five 10p coins</div>
        <div class="nudge-row">50p = ten 5p coins</div>
      </div>
    </div>
    <button class="primary cta-large" style="margin-top:14px" data-practice-skill="uk_money_total">Practise money</button>
  `);
  document.querySelector('[data-practice-skill]').addEventListener('click', e => startSkillPractice(e.target.dataset.practiceSkill));
}
function startFactorPractice(factor) {
  const profile = currentProfile();
  const lessonNumber = state.lessonSummaries.filter(l => l.childId === profile.id).length + 1;
  lessonSession = {
    id: `lesson-${Date.now()}`,
    lessonNumber,
    childId: profile.id,
    startedAt: new Date().toISOString(),
    index: 0,
    maxIndexReached: 0,
    totalQuestions: 10,
    answers: [],
    questions: [],
    tierBySkill: {},
    streakBySkill: {},
    skillCursor: 0,
    keypad: '',
    hintOpen: false,
    questionStartedAt: performance.now(),
    topicFilter: 'multiplication_division',
    skillFilter: 'times_tables',
    factorFilter: factor,
    topicLevelBefore: topicLevel(profile, 'multiplication_division')
  };
  setRoute('lesson');
}
// Shared by every Learning Zone "Practise this" button (fractions, number
// bonds, money, ...) -- pins a 10-question session to exactly one skill,
// same shape as startFactorPractice but without a factor pin.
function startSkillPractice(skillId) {
  const profile = currentProfile();
  const lessonNumber = state.lessonSummaries.filter(l => l.childId === profile.id).length + 1;
  const topicId = topicForSkill(skillId);
  lessonSession = {
    id: `lesson-${Date.now()}`,
    lessonNumber,
    childId: profile.id,
    startedAt: new Date().toISOString(),
    index: 0,
    maxIndexReached: 0,
    totalQuestions: 10,
    answers: [],
    questions: [],
    tierBySkill: {},
    streakBySkill: {},
    skillCursor: 0,
    keypad: '',
    hintOpen: false,
    questionStartedAt: performance.now(),
    topicFilter: topicId,
    skillFilter: skillId,
    topicLevelBefore: topicLevel(profile, topicId)
  };
  setRoute('lesson');
}

function startLesson() {
  const profile = currentProfile();
  const skills = eligibleSkills(profile);
  const lessonNumber = state.lessonSummaries.filter(l => l.childId === profile.id).length + 1;
  lessonSession = {
    id: `lesson-${Date.now()}`,
    lessonNumber,
    childId: profile.id,
    startedAt: new Date().toISOString(),
    index: 0,
    maxIndexReached: 0,
    totalQuestions: 20,
    answers: [],
    questions: [],
    tierBySkill: {},
    streakBySkill: {},
    skillCursor: randomInt(0, skills.length - 1),
    keypad: '',
    hintOpen: false,
    questionStartedAt: performance.now()
  };
  setRoute('lesson');
}

function skillsArea() {
  const profile = currentProfile();
  shell(html`
    <div class="top-row"><button class="ghost" data-route="home">Back</button><div class="nav">${authBadge()}</div></div>
    <h1>Skills Area</h1>
    <div class="grid topic-grid">
      ${TOPIC_DEFS.map(t => {
        const level = topicLevel(profile, t.id);
        const needsWork = topicLevel(profile, t.id, { onlyEligible: true }) < 3;
        const animal = animalForTier(level);
        return `<button class="topic-card ${needsWork ? 'needs-work' : ''}" data-topic="${t.id}">
          <strong>${escapeText(t.label)}</strong>
          <span class="small">${animal.emoji} ${escapeText(animal.name)}</span>
          ${needsWork ? '<span class="topic-flag">Needs practice</span>' : ''}
        </button>`;
      }).join('')}
    </div>
  `);
  document.querySelectorAll('[data-topic]').forEach(btn => btn.addEventListener('click', () => startTopicSession(btn.dataset.topic)));
}
function startTopicSession(topicId) {
  const profile = currentProfile();
  const lessonNumber = state.lessonSummaries.filter(l => l.childId === profile.id).length + 1;
  lessonSession = {
    id: `lesson-${Date.now()}`,
    lessonNumber,
    childId: profile.id,
    startedAt: new Date().toISOString(),
    index: 0,
    maxIndexReached: 0,
    totalQuestions: 10,
    answers: [],
    questions: [],
    tierBySkill: {},
    streakBySkill: {},
    skillCursor: 0,
    keypad: '',
    hintOpen: false,
    questionStartedAt: performance.now(),
    topicFilter: topicId,
    topicLevelBefore: topicLevel(profile, topicId)
  };
  setRoute('lesson');
}

function speedTestSetup() {
  shell(html`
    <div class="top-row"><button class="ghost" data-route="home">Back</button><div class="nav">${authBadge()}</div></div>
    <h1>Speed Test</h1>
    <p class="small">${SPEED_QUESTION_MS / 1000}s per question</p>
    <div class="grid topic-grid">
      <button class="topic-card" data-speed-topic="">
        <strong>Mixed</strong>
      </button>
      ${TOPIC_DEFS.map(t => `<button class="topic-card" data-speed-topic="${t.id}"><strong>${escapeText(t.label)}</strong></button>`).join('')}
    </div>
  `);
  document.querySelectorAll('[data-speed-topic]').forEach(btn => btn.addEventListener('click', () => startSpeedTest(btn.dataset.speedTopic || null)));
}
function startSpeedTest(topicId) {
  const profile = currentProfile();
  const lessonNumber = state.lessonSummaries.filter(l => l.childId === profile.id).length + 1;
  const key = topicId || 'mixed';
  lessonSession = {
    id: `lesson-${Date.now()}`,
    lessonNumber,
    childId: profile.id,
    startedAt: new Date().toISOString(),
    index: 0,
    maxIndexReached: 0,
    totalQuestions: 25,
    answers: [],
    questions: [],
    tierBySkill: {},
    streakBySkill: {},
    skillCursor: 0,
    keypad: '',
    hintOpen: false,
    questionStartedAt: performance.now(),
    topicFilter: topicId,
    mode: 'speed',
    speedKey: key,
    speedBestBefore: profile.speedBest?.[key] || null
  };
  setRoute('lesson');
}

// --- Skill bank -----------------------------------------------------------
// Each skill knows how to build a question at a given difficulty tier
// (1 = easiest, 4 = hardest). minTier gates whether the skill appears at
// all yet, based on the child's overall profile.microLevel. Tiers within
// a skill then adapt up/down *during* a lesson based on streaks (see
// generateNextQuestion/updateAdaptive), so a child who's flying through
// easy questions gets pushed harder until something actually trips them up.
const MAX_TIER = 12;
// Looks up a tier's range from an explicit ladder of brackets, clamping to
// the last bracket if tier somehow exceeds how many are defined -- this
// avoids the earlier bug where ranges silently flatlined past tier 4
// because the bracket ladder only had 3-4 rungs while MAX_TIER kept rising.
function tieredRange(tier, brackets) { return brackets[Math.min(tier, brackets.length) - 1]; }
const CLOCK_WORDS = { 5: 'five', 10: 'ten', 15: 'quarter', 20: 'twenty', 25: 'twenty-five', 30: 'half' };
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS_WORDS = { 20: 'twenty', 30: 'thirty', 40: 'forty', 50: 'fifty' };
function minuteWord(n) {
  if (CLOCK_WORDS[n]) return CLOCK_WORDS[n];
  if (n < 20) return NUMBER_WORDS[n];
  const tens = Math.floor(n / 10) * 10;
  const ones = n % 10;
  return ones ? `${TENS_WORDS[tens]}-${NUMBER_WORDS[ones]}` : TENS_WORDS[tens];
}
function skillPassed(profile, skillId, microSkillId, minTier = 4, minMastery = 0.82) {
  return (profile.skillTiers?.[skillId] || 0) >= minTier || (profile.mastery?.[microSkillId] || 0) >= minMastery;
}
function skillScore(childId, microSkillId) {
  const attempts = state.attempts.filter(a => a.childId === childId && a.microSkillId === microSkillId);
  const correct = attempts.filter(a => a.isCorrect).length;
  return { correct, total: attempts.length, label: attempts.length ? `${correct}/${attempts.length}` : '0/0' };
}
const SHAPES = [
  { name: 'triangle', sides: 3, corners: 3 }, { name: 'square', sides: 4, corners: 4 },
  { name: 'rectangle', sides: 4, corners: 4 }, { name: 'pentagon', sides: 5, corners: 5 },
  { name: 'hexagon', sides: 6, corners: 6 }, { name: 'circle', sides: 0, corners: 0 }
];
const COINS = [1, 2, 5, 10, 20, 50, 100, 200];
const PATTERNS = [
  ['circle', 'square'], ['triangle', 'circle', 'circle'], ['red', 'blue'], ['2', '4', '6'], ['5', '10', '15']
];

const SKILL_DEFS = [
  {
    id: 'add_one_more', microSkillId: 'add_1_within_10', label: 'Adding one more',
    explanationType: 'addOne', visualType: 'numberLine',
    rangeForTier: tier => tieredRange(tier, [[1,5],[1,9],[10,19],[10,30],[20,40],[30,60],[50,90],[80,130],[120,180],[150,250],[200,350],[300,500]]),
    build: a => ({ prompt: `${a} + 1 = ?`, a, correctAnswer: a + 1 })
  },
  {
    id: 'add_two_more', microSkillId: 'add_2_within_20', label: 'Adding two more',
    explanationType: 'addTwo', visualType: 'numberLine',
    rangeForTier: tier => tieredRange(tier, [[1,7],[1,18],[10,28],[10,38],[20,48],[30,68],[50,98],[80,138],[120,188],[150,258],[200,358],[300,508]]),
    build: a => ({ prompt: `${a} + 2 = ?`, a, correctAnswer: a + 2 })
  },
  {
    id: 'subtract_one', microSkillId: 'subtract_1_within_20', label: 'Counting back one',
    explanationType: 'subtractOne', visualType: 'numberLine',
    rangeForTier: tier => tieredRange(tier, [[2,10],[2,20],[10,30],[10,40],[20,50],[30,70],[50,100],[80,140],[120,190],[150,260],[200,360],[300,510]]),
    build: a => ({ prompt: `${a} - 1 = ?`, a, correctAnswer: a - 1 })
  },
  {
    id: 'number_bonds_to_10', microSkillId: 'bonds_to_10_missing_addend', label: 'Number bonds to 10',
    explanationType: 'bond10', visualType: 'tenFrame',
    rangeForTier: () => [1, 9],
    build: a => ({ prompt: `${a} + __ = 10`, a, correctAnswer: 10 - a })
  },
  {
    id: 'number_bonds_to_20', microSkillId: 'bonds_to_20_missing_addend', label: 'Number bonds to 20',
    explanationType: 'bond20', visualType: 'tenFrame', minTier: 3,
    rangeForTier: () => [1, 19],
    build: a => ({ prompt: `${a} + __ = 20`, a, correctAnswer: 20 - a })
  },
  {
    id: 'times_tables', microSkillId: 'times_tables', label: 'Times tables',
    explanationType: 'timesTable', visualType: 'timesTable', minTier: 2,
    rangeForTier: () => [1, 12],
    build: (a, tier, opts) => {
      const table = opts?.factor || (tier <= 4 ? [2, 5, 10][randomInt(0, 2)] : tier <= 8 ? [2, 3, 4, 5, 10][randomInt(0, 4)] : [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12][randomInt(0, 10)]);
      return { prompt: `${a} × ${table} = ?`, a, table, correctAnswer: a * table, choiceType: 'numericChoice', visualData: { a, table } };
    }
  },
  {
    id: 'read_oclock', microSkillId: 'identify_oclock_analogue', label: "Reading o'clock",
    explanationType: 'oclock', visualType: 'clock', clockSkill: true,
    rangeForTier: () => [1, 12],
    build: hour => ({ prompt: `Which clock shows ${hour} o'clock?`, a: hour, correctAnswer: `${hour}:00`, choiceType: 'clock' })
  },
  {
    id: 'read_half_past', microSkillId: 'identify_half_past_analogue', label: 'Reading half past',
    explanationType: 'halfPast', visualType: 'clock', minTier: 1, clockSkill: true,
    rangeForTier: () => [1, 12],
    build: hour => ({ prompt: `Which clock shows half past ${hour}?`, a: hour, correctAnswer: `${hour}:30`, choiceType: 'clock' })
  },
  {
    id: 'read_quarter_hours', microSkillId: 'identify_quarter_hour_analogue', label: 'Reading quarter past and quarter to',
    explanationType: 'quarterHour', visualType: 'clock', minTier: 2, clockSkill: true,
    rangeForTier: () => [1, 12],
    build: hour => {
      const past = Math.random() < 0.5;
      const answerHour = past ? hour : ((hour + 10) % 12) + 1;
      const correctAnswer = `${answerHour}:${past ? '15' : '45'}`;
      return { prompt: `Which clock shows quarter ${past ? 'past' : 'to'} ${hour}?`, a: hour, correctAnswer, choiceType: 'clock', minutePrecision: true };
    }
  },
  {
    id: 'read_five_minute_intervals', microSkillId: 'identify_five_minute_analogue', label: 'Reading five-minute times',
    explanationType: 'fiveMinuteClock', visualType: 'clock', minTier: 2, clockSkill: true,
    rangeForTier: () => [1, 12],
    build: hour => {
      const minutes = [5, 10, 20, 25, 35, 40, 50, 55][randomInt(0, 7)];
      const past = minutes < 30;
      const shownHour = past ? hour : ((hour % 12) + 1);
      const correctAnswer = `${hour}:${String(minutes).padStart(2, '0')}`;
      const phrase = past ? `${CLOCK_WORDS[minutes]} past ${hour}` : `${CLOCK_WORDS[60 - minutes]} to ${shownHour}`;
      return { prompt: `Which clock shows ${phrase}?`, a: hour, correctAnswer, choiceType: 'clock', minutePrecision: true };
    }
  },
  {
    id: 'read_one_minute_intervals', microSkillId: 'identify_one_minute_analogue', label: 'Reading one-minute times',
    explanationType: 'oneMinuteClock', visualType: 'clock', minTier: 4, clockSkill: true, requiresSkill: 'read_five_minute_intervals', requiresMicroSkill: 'identify_five_minute_analogue',
    rangeForTier: () => [1, 12],
    build: hour => {
      let minutes = randomInt(1, 59);
      if (minutes % 5 === 0) minutes = minutes === 59 ? 58 : minutes + 1;
      const past = minutes <= 30;
      const shownHour = past ? hour : ((hour % 12) + 1);
      const correctAnswer = `${hour}:${String(minutes).padStart(2, '0')}`;
      const phrase = past ? `${minuteWord(minutes)} past ${hour}` : `${minuteWord(60 - minutes)} to ${shownHour}`;
      return { prompt: `Which clock shows ${phrase}?`, a: hour, correctAnswer, choiceType: 'clock', minutePrecision: true, exactMinute: true };
    }
  },
  {
    id: 'place_value_tens_ones', microSkillId: 'place_value_tens_ones', label: 'Tens and ones',
    explanationType: 'placeValue', visualType: 'placeValue', minTier: 2,
    rangeForTier: tier => tier <= 3 ? [11, 49] : tier <= 5 ? [20, 99] : [100, 999],
    build: n => ({ prompt: 'What number is shown?', a: n, correctAnswer: n, visualData: { number: n } })
  },
  {
    id: 'bar_model_word_problems', microSkillId: 'bar_model_add_subtract', label: 'Bar model word problems',
    explanationType: 'barModel', visualType: 'barModel', minTier: 2,
    rangeForTier: tier => tier <= 3 ? [4, 14] : [10, 60],
    build: (a, tier) => {
      const b = randomInt(2, tier <= 3 ? 8 : 35);
      const add = Math.random() < 0.6;
      if (add) return { prompt: `Tom has ${a} stickers. He gets ${b} more. How many stickers does he have now?`, a, b, correctAnswer: a + b, visualData: { model: 'partWhole', known: a, unknown: b, revealTotal: false } };
      const total = a + b;
      return { prompt: `Maya has ${total} shells. She gives away ${b}. How many shells are left?`, a: total, b, correctAnswer: a, visualData: { model: 'partWhole', known: b, unknown: a, total, revealTotal: true } };
    }
  },
  {
    id: 'fractions_visual', microSkillId: 'fractions_shaded_shapes', label: 'Fractions of shapes',
    explanationType: 'fractionShape', visualType: 'fractionShape', minTier: 3,
    rangeForTier: tier => tier <= 4 ? [2, 4] : tier <= 6 ? [2, 8] : [2, 12],
    build: denom => {
      const shaded = randomInt(1, denom - 1);
      const style = ['bar', 'circle', 'dots'][randomInt(0, 2)];
      return { prompt: 'What fraction is shaded?', a: shaded, correctAnswer: `${shaded}/${denom}`, choiceType: 'fraction', visualData: { shaded, denom, style } };
    }
  },
  {
    id: 'shape_geometry', microSkillId: 'identify_2d_shapes', label: 'Shapes and corners',
    explanationType: 'shape', visualType: 'shape', minTier: 2,
    rangeForTier: () => [0, SHAPES.length - 1],
    build: idx => {
      const shape = SHAPES[idx];
      const askSides = Math.random() < 0.45 && shape.name !== 'circle';
      return { prompt: askSides ? `How many sides does this ${shape.name} have?` : 'What shape is this?', a: idx, correctAnswer: askSides ? shape.sides : shape.name, choiceType: askSides ? 'numericChoice' : 'shape', visualData: { shape: shape.name, sides: shape.sides, corners: shape.corners, askSides } };
    }
  },
  {
    id: 'measurement_compare', microSkillId: 'compare_measurement_lengths', label: 'Measurement and comparison',
    explanationType: 'measurement', visualType: 'measurement', minTier: 2,
    rangeForTier: () => [4, 15],
    build: a => {
      let b = randomInt(4, 15); if (b === a) b += 2;
      return { prompt: 'Which bar is longer?', a, b, correctAnswer: a > b ? 'A' : 'B', choiceType: 'compare', visualData: { a, b } };
    }
  },
  {
    id: 'uk_money_total', microSkillId: 'uk_coin_totals', label: 'UK coin totals',
    explanationType: 'money', visualType: 'money', minTier: 3,
    rangeForTier: tier => tier <= 4 ? [2, 4] : tier <= 6 ? [3, 6] : [4, 8],
    // Past tier 6, half the questions switch from "add these coins" to
    // "work out the change" -- same coin-handling skill, but a genuinely
    // harder real-world variant (subtraction, not just addition).
    build: (count, tier = 1) => {
      if (tier >= 7 && Math.random() < 0.5) {
        const price = randomInt(10, 95);
        const paidOptions = [50, 100, 200].filter(p => p > price);
        const paid = paidOptions[randomInt(0, paidOptions.length - 1)] || 200;
        const change = paid - price;
        return { prompt: `An item costs ${price}p. You pay with a ${paid >= 100 ? '£' + paid / 100 : paid + 'p'} coin. How much change do you get?`, a: price, b: paid, correctAnswer: change, choiceType: 'numericChoice', visualData: { mode: 'change', price, paid } };
      }
      const usable = COINS.slice(0, count <= 4 ? 5 : 8);
      const coins = Array.from({ length: count }, () => usable[randomInt(0, usable.length - 1)]);
      const total = coins.reduce((sum, coin) => sum + coin, 0);
      return { prompt: 'How much money is this?', a: total, correctAnswer: total, choiceType: 'numericChoice', visualData: { coins, mode: 'total' } };
    }
  },
  {
    id: 'patterns_sequences', microSkillId: 'patterns_sequences_missing', label: 'Patterns and sequences',
    explanationType: 'pattern', visualType: 'pattern', minTier: 2,
    rangeForTier: () => [0, PATTERNS.length - 1],
    build: idx => {
      const base = PATTERNS[idx];
      const sequence = Array.from({ length: 6 }, (_, i) => base[i % base.length]);
      const missingIndex = randomInt(2, 5);
      const correctAnswer = sequence[missingIndex];
      return { prompt: 'What goes in the missing place?', a: idx, correctAnswer, choiceType: 'pattern', visualData: { sequence, missingIndex } };
    }
  },
  {
    id: 'division_facts', microSkillId: 'division_facts', label: 'Division facts',
    explanationType: 'division', visualType: 'timesTable', minTier: 6,
    rangeForTier: () => [1, 12],
    build: (quotient, tier) => {
      const table = tier <= 8 ? [2, 5, 10][randomInt(0, 2)] : [2, 3, 4, 5, 6, 7, 8, 9, 10][randomInt(0, 8)];
      const dividend = quotient * table;
      return { prompt: `${dividend} ÷ ${table} = ?`, a: dividend, table, correctAnswer: quotient, choiceType: 'numericChoice', visualData: { a: quotient, table } };
    }
  },
  {
    id: 'elapsed_time', microSkillId: 'elapsed_time_minutes', label: 'Elapsed time',
    explanationType: 'elapsedTime', visualType: 'elapsedTime', minTier: 5,
    rangeForTier: () => [1, 12],
    build: hour => {
      const startMinute = [0, 15, 30, 45][randomInt(0, 3)];
      const gap = [5, 10, 15, 20, 30, 45][randomInt(0, 5)];
      let endMinute = startMinute + gap;
      let endHour = hour;
      if (endMinute >= 60) { endMinute -= 60; endHour = (hour % 12) + 1; }
      const start = `${hour}:${String(startMinute).padStart(2, '0')}`;
      const end = `${endHour}:${String(endMinute).padStart(2, '0')}`;
      return { prompt: `It is ${start}. How many minutes until ${end}?`, a: gap, b: hour, correctAnswer: gap, choiceType: 'numericChoice', visualData: { start, end } };
    }
  },
  {
    id: 'measurement_units', microSkillId: 'measurement_unit_conversion', label: 'Measurement units',
    explanationType: 'unitConversion', visualType: 'unitConversion', minTier: 5,
    rangeForTier: tier => tier <= 6 ? [1, 5] : [1, 9],
    build: m => {
      const toCm = Math.random() < 0.5;
      if (toCm) return { prompt: `How many centimetres are in ${m} metres?`, a: m, correctAnswer: m * 100, choiceType: 'numericChoice', visualData: { m, mode: 'm_to_cm' } };
      return { prompt: `How many metres are in ${m * 100} centimetres?`, a: m * 100, correctAnswer: m, choiceType: 'numericChoice', visualData: { m, mode: 'cm_to_m' } };
    }
  },
  {
    id: 'fractions_of_amounts', microSkillId: 'fractions_of_amount', label: 'Fractions of amounts',
    explanationType: 'fractionOfAmount', visualType: 'fractionOfAmount', minTier: 5,
    rangeForTier: tier => tier <= 6 ? [2, 4] : [2, 10],
    build: denom => {
      const groupsPerPart = randomInt(1, 6);
      const amount = denom * groupsPerPart;
      const numerator = denom === 2 ? 1 : randomInt(1, denom - 1);
      const correctAnswer = numerator * groupsPerPart;
      return { prompt: `What is ${numerator}/${denom} of ${amount}?`, a: amount, b: denom, correctAnswer, choiceType: 'numericChoice', visualData: { amount, denom, numerator, groupsPerPart } };
    }
  },
  {
    id: 'rounding_nearest_10', microSkillId: 'rounding_nearest_10', label: 'Rounding to the nearest 10',
    explanationType: 'rounding', visualType: 'rounding', minTier: 4,
    rangeForTier: tier => tier <= 5 ? [11, 49] : [10, 199],
    build: n => ({ prompt: `Round ${n} to the nearest 10.`, a: n, correctAnswer: Math.round(n / 10) * 10, choiceType: 'numericChoice', visualData: { n } })
  },
  {
    id: 'data_handling_pictogram', microSkillId: 'data_handling_pictogram', label: 'Reading pictograms',
    explanationType: 'pictogram', visualType: 'pictogram', minTier: 6,
    rangeForTier: () => [0, 0],
    build: () => {
      const categories = shuffle([['Football', '⚽'], ['Tennis', '🎾'], ['Swimming', '🏊'], ['Running', '🏃']]).slice(0, 3);
      const counts = categories.map(() => randomInt(1, 8));
      const askIdx = randomInt(0, categories.length - 1);
      return { prompt: `How many children chose ${categories[askIdx][0]}?`, a: askIdx, correctAnswer: counts[askIdx], choiceType: 'numericChoice', visualData: { categories, counts } };
    }
  },
  {
    id: 'missing_number_equations', microSkillId: 'missing_number_equations', label: 'Missing number equations',
    explanationType: 'missingNumber', visualType: 'missingNumber', minTier: 5,
    rangeForTier: tier => tier <= 6 ? [5, 20] : [10, 50],
    build: total => {
      const form = ['addRight', 'addLeft', 'subRight'][randomInt(0, 2)];
      if (form === 'addRight') { const a = randomInt(1, total - 1); return { prompt: `${a} + __ = ${total}`, a, b: total, correctAnswer: total - a, visualData: { form } }; }
      if (form === 'addLeft') { const a = randomInt(1, total - 1); return { prompt: `__ + ${a} = ${total}`, a, b: total, correctAnswer: total - a, visualData: { form } }; }
      const b = randomInt(1, total - 1);
      return { prompt: `${total} - __ = ${b}`, a: total, b, correctAnswer: total - b, visualData: { form } };
    }
  },
  {
    id: 'negative_numbers_intro', microSkillId: 'negative_numbers_intro', label: 'Negative numbers',
    explanationType: 'negativeNumbers', visualType: 'negativeNumbers', minTier: 8,
    rangeForTier: () => [1, 10],
    build: start => {
      const drop = randomInt(start + 1, start + 8);
      return { prompt: `The temperature is ${start}°C. It drops by ${drop}°C. What is the new temperature?`, a: start, b: drop, correctAnswer: start - drop, choiceType: 'numericChoice', visualData: { start, drop } };
    }
  },
  {
    id: 'decimals_intro', microSkillId: 'decimals_compare', label: 'Decimals',
    explanationType: 'decimalCompare', visualType: 'decimalCompare', minTier: 7,
    rangeForTier: () => [1, 9],
    build: () => {
      const compareMode = Math.random() < 0.5;
      const mk = () => Math.round((randomInt(1, 9) / 10 + randomInt(0, 5)) * 10) / 10;
      if (compareMode) {
        const a = mk();
        let b = mk();
        if (b === a) b = Math.round((b + 0.3) * 10) / 10;
        return { prompt: 'Which decimal is bigger?', a, b, correctAnswer: a > b ? 'A' : 'B', choiceType: 'compare', visualData: { a, b, mode: 'compare' } };
      }
      const a = mk();
      const b = Math.round((randomInt(1, 9) / 10) * 10) / 10;
      const correctAnswer = Math.round((a + b) * 10) / 10;
      return { prompt: `${a} + ${b} = ?`, a, b, correctAnswer, choiceType: 'numericChoice', visualData: { a, b, mode: 'add' } };
    }
  },
  {
    id: 'multi_step_word_problems', microSkillId: 'multi_step_word_problems', label: 'Multi-step word problems',
    explanationType: 'multiStep', visualType: 'multiStep', minTier: 8,
    rangeForTier: tier => tier <= 9 ? [2, 6] : [2, 10],
    build: n => {
      const groupSize = randomInt(2, 6);
      const extra = randomInt(2, 10);
      const step1 = n * groupSize;
      if (Math.random() < 0.5) {
        return { prompt: `Maya has ${n} bags with ${groupSize} marbles in each. She is then given ${extra} more marbles. How many marbles does she have in total?`, a: n, b: groupSize, correctAnswer: step1 + extra, choiceType: 'numericChoice', visualData: { step1, n, groupSize, extra, op: 'add' } };
      }
      const give = Math.min(extra, step1 - 1);
      return { prompt: `Tom has ${n} packs of ${groupSize} stickers. He gives away ${give} stickers. How many does he have left?`, a: n, b: groupSize, correctAnswer: step1 - give, choiceType: 'numericChoice', visualData: { step1, n, groupSize, extra: give, op: 'subtract' } };
    }
  },
  {
    id: 'digital_24hr_conversion', microSkillId: 'digital_24hr_conversion', label: '24-hour time conversion',
    explanationType: 'digitalClock', visualType: 'digitalClock', minTier: 7,
    rangeForTier: () => [0, 23],
    build: hour24 => {
      const minute = [0, 15, 30, 45][randomInt(0, 3)];
      if (Math.random() < 0.5) {
        const period = hour24 < 12 ? 'am' : 'pm';
        let h12 = hour24 % 12; if (h12 === 0) h12 = 12;
        const time24 = `${String(hour24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
        return { prompt: `What is ${time24} in 12-hour time?`, a: hour24, b: minute, correctAnswer: `${h12}:${String(minute).padStart(2, '0')} ${period}`, choiceType: 'digitalClock', visualData: { time24, mode: 'to12' } };
      }
      const h12 = randomInt(1, 12);
      const period = Math.random() < 0.5 ? 'am' : 'pm';
      const hour24calc = period === 'am' ? (h12 === 12 ? 0 : h12) : (h12 === 12 ? 12 : h12 + 12);
      const time12 = `${h12}:${String(minute).padStart(2, '0')} ${period}`;
      return { prompt: `What is ${time12} in 24-hour time?`, a: hour24calc, b: minute, correctAnswer: `${String(hour24calc).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, choiceType: 'digitalClock', visualData: { time12, mode: 'to24' } };
    }
  }
];
function eligibleSkills(profile) {
  const level = profile.microLevel || 1;
  return SKILL_DEFS.filter(s => {
    if (s.requiresSkill && !skillPassed(profile, s.requiresSkill, s.requiresMicroSkill)) return false;
    if (s.clockSkill) return !s.minTier || (profile.skillTiers?.[s.id] || level) >= s.minTier;
    return !s.minTier || level >= s.minTier;
  });
}
function skillLabelForMicroId(microId) {
  return SKILL_DEFS.find(s => s.microSkillId === microId)?.label || microId;
}

// --- Topic taxonomy --------------------------------------------------------
// Groups the fine-grained skills above into the handful of major areas a
// parent or child actually thinks in ("Fractions", "Division"), so progress
// can be reported and practised at that level rather than only per-skill.
const TOPIC_DEFS = [
  { id: 'addition_subtraction', label: 'Addition & Subtraction', skillIds: ['add_one_more', 'add_two_more', 'subtract_one', 'number_bonds_to_10', 'number_bonds_to_20', 'bar_model_word_problems', 'missing_number_equations', 'multi_step_word_problems'] },
  { id: 'multiplication_division', label: 'Multiplication & Division', skillIds: ['times_tables', 'division_facts'] },
  { id: 'fractions', label: 'Fractions', skillIds: ['fractions_visual', 'fractions_of_amounts'] },
  { id: 'number_place_value', label: 'Number & Place Value', skillIds: ['place_value_tens_ones', 'rounding_nearest_10', 'negative_numbers_intro', 'decimals_intro'] },
  { id: 'money', label: 'Money', skillIds: ['uk_money_total'] },
  { id: 'measurement', label: 'Measurement', skillIds: ['measurement_compare', 'measurement_units'] },
  { id: 'time', label: 'Time', skillIds: ['read_oclock', 'read_half_past', 'read_quarter_hours', 'read_five_minute_intervals', 'read_one_minute_intervals', 'elapsed_time', 'digital_24hr_conversion'] },
  { id: 'shape_geometry', label: 'Shape & Geometry', skillIds: ['shape_geometry'] },
  { id: 'patterns_data', label: 'Patterns & Data', skillIds: ['patterns_sequences', 'data_handling_pictogram'] }
];
const SKILL_TO_TOPIC = Object.fromEntries(TOPIC_DEFS.flatMap(t => t.skillIds.map(id => [id, t.id])));
function topicForSkill(skillId) { return SKILL_TO_TOPIC[skillId]; }
// Rolled-up 1-12 level for a topic, reusing the same tier scale as
// individual skills. `onlyEligible` restricts the average to skills the
// child could plausibly have attempted already (per eligibleSkills) --
// used for the "needs practice" flag so a topic that's mostly locked but
// has one strong unlocked skill doesn't get mislabelled as weak. Without
// that flag (used for "what tier are they about to be tested at"), every
// skill counts, defaulting unattempted ones to tier 1, since that's
// literally what they'd be tested at next.
function topicLevel(profile, topicId, { onlyEligible = false } = {}) {
  const topic = TOPIC_DEFS.find(t => t.id === topicId);
  if (!topic) return 1;
  let skillIds = topic.skillIds;
  if (onlyEligible) {
    const eligibleIds = new Set(eligibleSkills(profile).map(s => s.id));
    skillIds = skillIds.filter(id => eligibleIds.has(id));
  }
  if (!skillIds.length) return 1;
  const tiers = skillIds.map(id => profile.skillTiers?.[id] || 1);
  return Math.round(tiers.reduce((sum, t) => sum + t, 0) / tiers.length);
}
function clampTier(t) { return Math.max(1, Math.min(MAX_TIER, t || 1)); }
// The 1-12 tier scale is an internal engine detail (it drives which number
// ranges/brackets a question is built from) -- showing "Level 8 of 12" to a
// child reads as an arbitrary, slightly discouraging stopping point. This
// maps the same scale to a fun, ascending animal+alliteration badge instead;
// the raw numeric tier stays available to parents only (parentDashboard).
const ANIMAL_TIERS = [
  { tier: 1, name: 'Curious Caterpillar', emoji: '🐛' },
  { tier: 2, name: 'Plucky Penguin', emoji: '🐧' },
  { tier: 3, name: 'Bouncy Bunny', emoji: '🐰' },
  { tier: 4, name: 'Speedy Squirrel', emoji: '🐿️' },
  { tier: 5, name: 'Clever Chameleon', emoji: '🦎' },
  { tier: 6, name: 'Daring Dolphin', emoji: '🐬' },
  { tier: 7, name: 'Mighty Meerkat', emoji: '🦦' },
  { tier: 8, name: 'Inquisitive Owl', emoji: '🦉' },
  { tier: 9, name: 'Brave Badger', emoji: '🦡' },
  { tier: 10, name: 'Wise Wolf', emoji: '🐺' },
  { tier: 11, name: 'Soaring Eagle', emoji: '🦅' },
  { tier: 12, name: 'Legendary Lion', emoji: '🦁' }
];
function animalForTier(tier) { return ANIMAL_TIERS[clampTier(tier) - 1]; }

// --- Streaks, points and badges --------------------------------------------
// A lightweight motivation layer that sits entirely on top of the existing
// engine: it reads the same state.attempts/profile.skillTiers/speedBest that
// already drive adaptive difficulty, so it can't drift out of sync with
// what actually happened, and writes only new, additive profile fields
// (streak, totalPoints, badgesEarned).
const BADGE_DEFS = [
  { id: 'first_lesson', label: 'First Lesson', icon: '🎉', check: (profile, stats) => stats.totalAttempts >= 1 },
  { id: 'fifty_correct', label: '50 Correct Answers', icon: '🌟', check: (profile, stats) => stats.totalCorrect >= 50 },
  { id: 'hundred_correct', label: '100 Correct Answers', icon: '💯', check: (profile, stats) => stats.totalCorrect >= 100 },
  { id: 'three_day_streak', label: '3-Day Streak', icon: '🔥', check: profile => (profile.streak?.count || 0) >= 3 },
  { id: 'seven_day_streak', label: '7-Day Streak', icon: '🔥🔥', check: profile => (profile.streak?.count || 0) >= 7 },
  { id: 'topic_master', label: 'Topic Master', icon: '🏆', check: profile => TOPIC_DEFS.some(t => topicLevel(profile, t.id) >= 10) },
  { id: 'speed_star', label: 'Speed Star', icon: '⚡', check: profile => Object.values(profile.speedBest || {}).some(b => b.correctCount >= 20) }
];
function localDateString(date) { return date.toLocaleDateString('en-CA'); }
// A calendar-day streak in the child's local time, not a per-session
// counter -- finishing several lessons in one day only counts once;
// missing a whole day resets the count back to 1 rather than to 0, since
// the day just played still counts as a day played.
function updateStreak(profile) {
  const today = localDateString(new Date());
  const yesterday = localDateString(new Date(Date.now() - 86400000));
  const streak = profile.streak || { count: 0, lastActiveDate: null };
  if (streak.lastActiveDate !== today) {
    streak.count = streak.lastActiveDate === yesterday ? streak.count + 1 : 1;
    streak.lastActiveDate = today;
  }
  profile.streak = streak;
  return streak;
}
// Returns just the badge ids newly earned this session (for the "you've
// unlocked something!" celebration), while profile.badgesEarned keeps every
// badge ever earned, including ones that wouldn't necessarily re-trigger
// (e.g. if a topic level later dropped back below the threshold).
function evaluateBadges(profile) {
  const stats = {
    totalAttempts: state.attempts.filter(a => a.childId === profile.id).length,
    totalCorrect: state.attempts.filter(a => a.childId === profile.id && a.isCorrect).length
  };
  const earnedBefore = new Set(profile.badgesEarned || []);
  const earnedNow = BADGE_DEFS.filter(b => b.check(profile, stats)).map(b => b.id);
  profile.badgesEarned = [...new Set([...earnedBefore, ...earnedNow])];
  return earnedNow.filter(id => !earnedBefore.has(id));
}
function randomInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }
function normaliseClock(value) {
  const [hRaw, mRaw = 0] = String(value).split(':').map(Number);
  const h = ((hRaw - 1 + 12) % 12) + 1;
  const m = ((mRaw % 60) + 60) % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}
function clockChoices(correct, exactMinute = false) {
  const [h, m] = correct.split(':').map(Number);
  const step = exactMinute ? 1 : 5;
  const candidates = [correct, normaliseClock(`${h}:${m + step}`), normaliseClock(`${h}:${m - step}`), normaliseClock(`${h}:${m + 5}`), normaliseClock(`${h}:${m - 5}`), normaliseClock(`${(h % 12) + 1}:${m}`), normaliseClock(`${h === 1 ? 12 : h - 1}:${m}`)];
  return topUpChoices(candidates, () => normaliseClock(`${randomInt(1, 12)}:${String(exactMinute ? randomInt(1, 59) : randomInt(0, 11) * 5).padStart(2, '0')}`));
}
function fractionChoices(correct) {
  const [n, d] = correct.split('/').map(Number);
  return topUpChoices([correct, `${Math.max(1, n - 1)}/${d}`, `${Math.min(d - 1, n + 1)}/${d}`, `${n}/${Math.max(2, d + 1)}`, `${d - n}/${d}`], () => `${randomInt(1, 3)}/${randomInt(2, 6)}`);
}
function shapeChoices(correct) { return topUpChoices([correct, 'triangle', 'square', 'rectangle', 'pentagon', 'hexagon', 'circle'], () => SHAPES[randomInt(0, SHAPES.length - 1)].name); }
// Comparison questions only ever have 3 possible real answers (A, B,
// same) -- a 4th would have to be a fake/duplicate option, so this one
// stays at 3 choices deliberately, unlike every other choice type below.
function compareChoices(correct) { return topUpChoices([correct, correct === 'A' ? 'B' : 'A', 'same'], () => ['A', 'B', 'same'][randomInt(0, 2)], 3); }
function patternChoices(correct) { return topUpChoices([correct, 'circle', 'square', 'triangle', 'red', 'blue', '2', '4', '6', '10', '15'], () => String(randomInt(1, 20))); }
// Time-string answers (e.g. "2:30 pm" or "14:30") can't go through the
// numeric distractorChoices path -- perturb the hour by one step instead,
// wrapping correctly within whichever notation the question is using.
function digitalClockChoices(correct, mode) {
  const make = () => {
    if (mode === 'to12') {
      const [h, rest] = correct.split(':');
      const [m, period] = rest.split(' ');
      const wrappedH = ((Number(h) - 1 + (randomInt(0, 1) ? 1 : -1) + 12) % 12) + 1;
      return `${wrappedH}:${m} ${period}`;
    }
    const [h, m] = correct.split(':');
    const wrappedH = (Number(h) + (randomInt(0, 1) ? 1 : -1) + 24) % 24;
    return `${String(wrappedH).padStart(2, '0')}:${m}`;
  };
  return topUpChoices([correct, make(), make()], make);
}
function topUpChoices(candidates, makeCandidate, count = 4) {
  const set = candidates.map(String).filter(unique);
  let guard = 0;
  while (set.length < count && guard < 30) {
    const candidate = String(makeCandidate());
    if (!set.includes(candidate)) set.push(candidate);
    guard += 1;
  }
  return shuffle(set.slice(0, count));
}
// Returns plausible *wrong* answers that correspond to real misconceptions
// for a given skill (forgot to operate, went the wrong direction, did the
// opposite operation, off-by-one-extra-step, etc.) rather than just
// "numbers near the answer" -- e.g. for 23+1=24, this includes 22 (the
// "counted backwards" error), not just 23/25 either side of the answer.
function misconceptionSeeds(skillId, built) {
  const a = built.a, b = built.b, table = built.table;
  const correct = Number(built.correctAnswer);
  switch (skillId) {
    case 'add_one_more': return [correct, a, a - 1, a + 2];
    case 'add_two_more': return [correct, a, a + 1, a + 3];
    case 'subtract_one': return [correct, a, a + 1, a - 2];
    case 'number_bonds_to_10': case 'number_bonds_to_20': return [correct, a, correct + 1, correct - 1];
    case 'times_tables': return [correct, a + table, a * Math.max(1, table - 1), a * (table + 1)];
    case 'bar_model_word_problems': return (a !== undefined && b !== undefined) ? [correct, Math.abs(a - b), a + b, b] : [correct];
    case 'division_facts': return [correct, a, correct + 1, correct - 1];
    case 'rounding_nearest_10': return [correct, a, correct - 10, correct + 10];
    case 'missing_number_equations': return [correct, a, b, correct + a];
    case 'negative_numbers_intro': return [correct, Math.abs(correct), a, -a];
    case 'multi_step_word_problems': return [correct, built.visualData?.step1, a, b];
    // Plain correctAnswer±1 offsets in distractorChoices would otherwise hit
    // floating-point artifacts on a decimal (e.g. 4.1 - 1 -> 3.0999999999999996)
    // -- round explicitly here instead.
    case 'decimals_intro': return built.visualData?.mode === 'add' ? [correct, Math.round((correct - 1) * 10) / 10, Math.round((correct + 1) * 10) / 10] : null;
    default: return null;
  }
}
function choicesForBuiltQuestion(built, skillDef, min, max) {
  if (built.choiceType === 'clock') return clockChoices(built.correctAnswer, !!built.exactMinute);
  if (built.choiceType === 'fraction') return fractionChoices(built.correctAnswer);
  if (built.choiceType === 'shape') return shapeChoices(built.correctAnswer);
  if (built.choiceType === 'compare') return compareChoices(built.correctAnswer);
  if (built.choiceType === 'pattern') return patternChoices(built.correctAnswer);
  if (built.choiceType === 'digitalClock') return digitalClockChoices(built.correctAnswer, built.visualData?.mode);
  const smartSeeds = misconceptionSeeds(skillDef.id, built);
  if (built.choiceType === 'numericChoice') {
    const correct = Number(built.correctAnswer);
    // Distractors are normally clamped to >= 0 -- only relax that for
    // skills whose correct answer is itself negative (e.g. negative
    // numbers), so every other numeric skill keeps its existing,
    // never-negative distractor behaviour unchanged.
    const lowerBound = correct < 0 ? correct - 15 : 0;
    const seeds = (smartSeeds || [correct, correct + 1, correct - 1, correct + 2]).filter(v => v >= lowerBound);
    return distractorChoices(correct, seeds, lowerBound, Math.max(250, correct + 30));
  }
  const seeds = (smartSeeds || [built.correctAnswer, built.a ?? min, Number(built.correctAnswer) + 1, Number(built.correctAnswer) - 1]).filter(v => v >= 0);
  return distractorChoices(built.correctAnswer, seeds, Math.min(0, min - 5), max + 8);
}
function buildQuestion(skillDef, a, tier, opts) {
  const built = skillDef.build(a, tier, opts);
  const [min, max] = skillDef.rangeForTier(tier);
  const choices = choicesForBuiltQuestion(built, skillDef, min, max);
  const alwaysChoice = ['clock', 'fraction', 'shape', 'compare', 'pattern', 'numericChoice', 'digitalClock'].includes(built.choiceType);
  return {
    id: `q-${skillDef.id}-${Date.now()}-${Math.round(Math.random() * 1000)}`,
    type: alwaysChoice ? 'choice' : (Math.random() < 0.55 ? 'keypad' : 'choice'),
    skillId: skillDef.id,
    microSkillId: skillDef.microSkillId,
    tier,
    prompt: built.prompt,
    a: built.a ?? a,
    b: built.b,
    table: built.table,
    correctAnswer: built.correctAnswer,
    choices,
    explanationType: skillDef.explanationType,
    visualType: skillDef.visualType,
    visualData: built.visualData || null,
    minutePrecision: !!built.minutePrecision,
    exactMinute: !!built.exactMinute
  };
}
// Picks the next skill (prioritising anything flagged as shaky from the
// previous session for the first few questions), looks up that skill's
// current in-lesson difficulty tier, and builds a fresh randomised
// question for it.
function generateNextQuestion(session, profile) {
  let skills;
  if (session.topicFilter) {
    // Skills Area deliberately lets a child drill any topic at any time,
    // even one Learning Progression hasn't unlocked yet for them (minTier
    // gating is a pacing choice for the mixed mode, not a real
    // prerequisite) -- so use the topic's full skill list directly rather
    // than eligibleSkills(), keeping only genuine skill-chain dependencies
    // (e.g. one-minute clocks still require five-minute clocks first).
    skills = SKILL_DEFS.filter(s => topicForSkill(s.id) === session.topicFilter && (!s.requiresSkill || skillPassed(profile, s.requiresSkill, s.requiresMicroSkill)));
  } else {
    skills = eligibleSkills(profile);
  }
  // Learning Zone's "practise this number" pins the session to one exact
  // skill (e.g. times_tables) rather than a whole topic.
  if (session.skillFilter) skills = skills.filter(s => s.id === session.skillFilter);
  const priorityIds = (profile.reviewSkillIds || []).filter(id => skills.some(s => s.id === id));
  let skillDef;
  if (priorityIds.length && session.index < Math.min(4, priorityIds.length * 2)) {
    skillDef = skills.find(s => s.id === priorityIds[session.index % priorityIds.length]);
  }
  if (!skillDef) {
    // With a growing skill bank competing for only 10 questions/lesson,
    // plain round-robin can leave a skill (e.g. a newly-unlocked one like
    // times tables) unseen for many lessons purely by chance. Instead,
    // always pull from whichever eligible skills have gone longest without
    // appearing, with a little randomness among the most-overdue ones so
    // it isn't perfectly predictable.
    const lastSeen = profile.skillLastSeenLesson || {};
    const sorted = [...skills].sort((x, y) => (lastSeen[x.id] ?? -1) - (lastSeen[y.id] ?? -1));
    const pool = sorted.slice(0, Math.min(3, sorted.length));
    skillDef = pool[randomInt(0, pool.length - 1)];
  }
  profile.skillLastSeenLesson = { ...(profile.skillLastSeenLesson || {}), [skillDef.id]: session.lessonNumber || 0 };
  const tier = session.tierBySkill[skillDef.id] || clampTier(profile.skillTiers?.[skillDef.id] || profile.microLevel || 1);
  session.tierBySkill[skillDef.id] = tier;
  const [min, max] = skillDef.rangeForTier(tier);
  const a = randomInt(min, max);
  return buildQuestion(skillDef, a, tier, session.factorFilter ? { factor: session.factorFilter } : undefined);
}
// After each answer: two correct in a row on a skill nudges that skill's
// difficulty up a tier (looking for where understanding actually breaks);
// one wrong answer drops it back down a tier straight away.
function updateAdaptive(session, q, isCorrect) {
  const streak = (session.streakBySkill[q.skillId] || 0) + (isCorrect ? 1 : 0);
  if (isCorrect && streak >= 2) {
    session.tierBySkill[q.skillId] = clampTier((session.tierBySkill[q.skillId] || 1) + 1);
    session.streakBySkill[q.skillId] = 0;
  } else if (!isCorrect) {
    session.tierBySkill[q.skillId] = clampTier((session.tierBySkill[q.skillId] || 1) - 1);
    session.streakBySkill[q.skillId] = 0;
  } else {
    session.streakBySkill[q.skillId] = streak;
  }
}
function unique(value, index, arr) { return arr.indexOf(value) === index; }
function shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }
// Always returns exactly 4 distinct choices including the correct answer.
// Naive dedupe-then-slice could collapse to 1-2 options (e.g. a=9 gives
// [9,10,10,10] -> [9,10]), so we top up with nearby in-range numbers
// whenever the candidate pool has too few distinct values.
function distractorChoices(correctAnswer, candidates, min, max) {
  const set = [...candidates].filter(unique);
  let offset = 1;
  while (set.length < 4 && offset <= max - min) {
    [correctAnswer - offset, correctAnswer + offset].forEach(v => {
      if (set.length < 4 && v >= min && v <= max && !set.includes(v)) set.push(v);
    });
    offset += 1;
  }
  return shuffle(set.slice(0, 4));
}

function lesson() {
  if (!lessonSession) return setRoute('home');
  if (!lessonSession.questions[lessonSession.index]) {
    if (lessonSession.index >= lessonSession.totalQuestions) return finishLesson();
    lessonSession.questions[lessonSession.index] = generateNextQuestion(lessonSession, currentProfile());
  }
  lessonSession.maxIndexReached = Math.max(lessonSession.maxIndexReached || 0, lessonSession.index);
  const q = lessonSession.questions[lessonSession.index];
  const speakText = `${q.prompt.replace('__', 'blank')}`;
  const isSpeed = lessonSession.mode === 'speed';
  const isLastQuestion = lessonSession.index === lessonSession.totalQuestions - 1;
  const isAnswered = !!lessonSession.answers[lessonSession.index];
  // Speed Test is a timed mode -- going back to fix an earlier answer would
  // be meaningless once its clock has run out, so navigation/edit is only
  // offered in the untimed modes.
  const canNavigate = !isSpeed;
  shell(html`
    <div class="question-wrap">
      <div class="top-row">
        <div class="progress-dots">${Array.from({ length: lessonSession.totalQuestions }, (_, i) => {
          const jumpable = canNavigate && i <= lessonSession.maxIndexReached && i !== lessonSession.index;
          const classes = `dot ${i < lessonSession.index || lessonSession.answers[i] ? 'done' : ''} ${i === lessonSession.index ? 'current' : ''} ${jumpable ? 'jumpable' : ''}`;
          return jumpable
            ? `<button type="button" class="${classes}" data-jump="${i}" aria-label="Go to question ${i + 1}"></button>`
            : `<span class="${classes}" aria-label="Question ${i + 1}${i === lessonSession.index ? ' (current)' : ''}"></span>`;
        }).join('')}</div>
        ${isSpeed ? `<div class="timer-bar"><div class="timer-fill" data-timer-fill></div></div>` : ''}
        <button class="secondary" data-speak="${escapeText(speakText)}">Hear</button>
        ${authBadge()}
      </div>
      <div class="question-main">
        <div class="prompt">${escapeText(q.prompt)}</div>
        ${renderQuestionVisual(q)}
        ${renderQuestionInput(q)}
        ${canNavigate && isAnswered ? `<p class="small">Your answer: <strong>${escapeText(lessonSession.answers[lessonSession.index].childAnswer)}</strong> ${lessonSession.answers[lessonSession.index].isCorrect ? '✓' : '— tap a different answer to change it'}</p>` : ''}
        ${lessonSession.hintOpen ? `<div class="hint-box">${hintFor(q)}</div>` : ''}
      </div>
      <div class="question-actions">
        ${canNavigate && lessonSession.index > 0 ? '<button class="secondary" data-prev>← Back</button>' : ''}
        ${isSpeed ? '' : '<button class="secondary" data-hint>Hint</button>'}
        ${canNavigate && isLastQuestion && isAnswered ? '<button class="primary" data-finish>Finish</button>' : ''}
        ${canNavigate && !isLastQuestion && lessonSession.index < lessonSession.maxIndexReached ? '<button class="secondary" data-next>Next →</button>' : ''}
        <button class="ghost" data-route="home">Stop</button>
      </div>
    </div>
  `);
  bindQuestion(q);
  if (isSpeed) startQuestionTimer(q);
}
// Jumps to any question already visited this lesson (never ahead of
// maxIndexReached -- new questions are only generated by answering
// forward, not by this nav) so a wrong tap or typo can be fixed without
// losing the rest of the session.
function goToQuestion(index) {
  const clamped = Math.max(0, Math.min(lessonSession.maxIndexReached, index));
  lessonSession.index = clamped;
  const existing = lessonSession.answers[clamped];
  const q = lessonSession.questions[clamped];
  lessonSession.keypad = (existing && q?.type === 'keypad') ? String(existing.childAnswer ?? '') : '';
  lessonSession.hintOpen = false;
  lessonSession.questionStartedAt = performance.now();
  render();
}
// Speed Test gives each question a hard time limit (TTRS Soundcheck-style)
// instead of unlimited time -- the bar drains via direct DOM updates rather
// than calling render() every tick, since a full re-render would recreate
// the keypad/choice buttons and rebind listeners several times a second.
const SPEED_QUESTION_MS = 6000;
function startQuestionTimer(q) {
  clearQuestionTimer();
  const deadline = performance.now() + SPEED_QUESTION_MS;
  const fillEl = document.querySelector('[data-timer-fill]');
  lessonSession.timerHandle = setInterval(() => {
    const remaining = Math.max(0, deadline - performance.now());
    if (fillEl) fillEl.style.width = `${(remaining / SPEED_QUESTION_MS) * 100}%`;
    if (remaining <= 0) submitAnswer(q, null);
  }, 100);
}
function clearQuestionTimer() {
  if (lessonSession?.timerHandle) {
    clearInterval(lessonSession.timerHandle);
    lessonSession.timerHandle = null;
  }
}

function renderQuestionVisual(q) {
  if (!['barModel', 'fractionShape', 'shape', 'measurement', 'money', 'placeValue', 'pattern', 'timesTable', 'elapsedTime', 'unitConversion', 'fractionOfAmount', 'rounding', 'pictogram', 'missingNumber', 'negativeNumbers', 'decimalCompare', 'multiStep', 'digitalClock'].includes(q.visualType)) return '';
  return renderVisual({ question: q, correctAnswer: q.correctAnswer, childAnswer: '' });
}

function renderQuestionInput(q) {
  if (q.type === 'choice') {
    return `<div class="response-layout choice-layout"><div class="choices ${q.minutePrecision ? 'minute-choices' : ''}">${q.choices.map(choice => `<button class="choice ${q.minutePrecision ? 'minute-choice' : ''}" data-choice="${escapeText(choice)}">${formatChoice(q, choice)}</button>`).join('')}</div></div>`;
  }
  return html`
    <div class="response-layout">
      <div class="keypad-panel">
        <div class="answer-box" aria-label="Answer box">${lessonSession.keypad || '&nbsp;'}</div>
        <div class="keypad">
          ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="key" data-key="${n}">${n}</button>`).join('')}
          <button class="key" data-key="0">0</button><button class="key wide" data-delete aria-label="Backspace, remove last digit">⌫ Backspace</button>
        </div>
      </div>
      <button class="primary ok-button" data-ok>OK</button>
    </div>
  `;
}
function formatChoice(q, choice) {
  if (q.visualType === 'clock') return `<span aria-label="${choice}">${clockSvg(choice, q.minutePrecision ? 170 : 132)}</span><br><span class="small">${choice}</span>`;
  return escapeText(choice);
}
function bindQuestion(q) {
  document.querySelector('[data-hint]').addEventListener('click', () => { lessonSession.hintOpen = true; render(); });
  document.querySelectorAll('[data-key]').forEach(btn => btn.addEventListener('click', () => { lessonSession.keypad = (lessonSession.keypad + btn.dataset.key).slice(0, 5); render(); }));
  document.querySelector('[data-delete]')?.addEventListener('click', () => { lessonSession.keypad = lessonSession.keypad.slice(0, -1); render(); });
  document.querySelector('[data-ok]')?.addEventListener('click', () => submitAnswer(q, lessonSession.keypad));
  document.querySelectorAll('[data-choice]').forEach(btn => btn.addEventListener('click', () => submitAnswer(q, btn.dataset.choice)));
  document.querySelector('[data-prev]')?.addEventListener('click', () => goToQuestion(lessonSession.index - 1));
  document.querySelector('[data-next]')?.addEventListener('click', () => goToQuestion(lessonSession.index + 1));
  document.querySelector('[data-finish]')?.addEventListener('click', () => finishLesson());
  document.querySelectorAll('[data-jump]').forEach(btn => btn.addEventListener('click', () => goToQuestion(Number(btn.dataset.jump))));
}
function submitAnswer(q, rawAnswer) {
  if (rawAnswer === '') return;
  clearQuestionTimer();
  const elapsedMs = Math.round(performance.now() - lessonSession.questionStartedAt);
  const isTimeout = rawAnswer === null;
  const normalised = isTimeout ? null : (q.type === 'keypad' ? Number(rawAnswer) : rawAnswer);
  const isCorrect = !isTimeout && String(normalised) === String(q.correctAnswer);
  const misconception = isTimeout ? null : diagnose(q, normalised);
  // A stable, per-question id (rather than time-of-submit) means fixing a
  // wrong tap or typo *replaces* this question's attempt everywhere
  // (in-session, state.attempts, and the synced Firestore doc) instead of
  // appending a confusing duplicate alongside the original wrong answer.
  const wasAlreadyAnswered = !!lessonSession.answers[lessonSession.index];
  const attempt = {
    id: `attempt-${q.id}`,
    lessonId: lessonSession.id,
    childId: lessonSession.childId,
    questionId: q.id,
    prompt: q.prompt,
    skillId: q.skillId,
    microSkillId: q.microSkillId,
    childAnswer: normalised,
    correctAnswer: q.correctAnswer,
    isCorrect,
    usedHint: lessonSession.hintOpen,
    elapsedMs,
    misconceptionTag: misconception?.tag || null,
    createdAt: new Date().toISOString(),
    question: q
  };
  lessonSession.answers[lessonSession.index] = attempt;
  const priorIndex = state.attempts.findIndex(a => a.id === attempt.id);
  if (priorIndex >= 0) state.attempts[priorIndex] = attempt;
  else state.attempts.push(attempt);
  // Adaptive difficulty already reacted to this question the first time it
  // was answered (and later questions were generated off the back of
  // that) -- re-answering on a revisit corrects the score but shouldn't
  // double-apply the tier bump/drop a second time.
  if (!wasAlreadyAnswered) updateAdaptive(lessonSession, q, isCorrect);
  saveState();
  if (cloudWritesEnabled()) saveAttemptCloud(cloudUser.uid, attempt).catch(() => {});
  lessonSession.keypad = '';
  lessonSession.hintOpen = false;
  lessonSession.questionStartedAt = performance.now();
  const isSpeed = lessonSession.mode === 'speed';
  const isLastQuestion = lessonSession.index === lessonSession.totalQuestions - 1;
  // Forward flow auto-advances exactly like before; finishing the lesson
  // is now a deliberate Finish tap on the last question in untimed modes
  // (giving a chance to fix anything first), but Speed Test's clock makes
  // reviewing meaningless once it's run out, so that one still auto-
  // finishes on the last question exactly as before.
  if (!wasAlreadyAnswered && isLastQuestion && isSpeed) return finishLesson();
  if (!wasAlreadyAnswered && !isLastQuestion) lessonSession.index += 1;
  render();
}
function diagnose(q, answer) {
  const a = q.a;
  const correctAnswer = q.correctAnswer;
  const numAnswer = Number(answer);
  if (q.skillId === 'add_one_more') {
    if (numAnswer === a) return { tag: 'did_not_add' };
    if (numAnswer === a - 1) return { tag: 'counted_backwards_instead_of_forwards' };
    if (numAnswer === a + 2) return { tag: 'counted_on_too_far' };
    if (numAnswer === 10 && correctAnswer !== 10) return { tag: 'number_bond_confusion' };
  }
  if (q.skillId === 'add_two_more') {
    if (numAnswer === a + 1) return { tag: 'counted_on_too_few' };
    if (numAnswer === a) return { tag: 'did_not_add' };
  }
  if (q.skillId === 'subtract_one') {
    if (numAnswer === a) return { tag: 'did_not_subtract' };
    if (numAnswer === a + 1) return { tag: 'counted_forwards_instead_of_back' };
  }
  if (q.skillId === 'number_bonds_to_10' && numAnswer === a + 10) return { tag: 'added_instead_of_missing' };
  if (q.skillId === 'number_bonds_to_20' && numAnswer === a + 20) return { tag: 'added_instead_of_missing' };
  if (q.skillId === 'times_tables' && numAnswer === a + q.table) return { tag: 'added_instead_of_multiplied' };
  if (q.skillId === 'read_oclock' && String(answer).endsWith(':30')) return { tag: 'confused_oclock_and_half_past' };
  if (q.skillId === 'read_half_past' && String(answer).endsWith(':00')) return { tag: 'confused_half_past_and_oclock' };
  if (q.visualType === 'clock' && String(answer).split(':')[1] !== String(q.correctAnswer).split(':')[1]) return { tag: 'clock_minute_hand' };
  if (q.visualType === 'money' && q.visualData?.mode !== 'change' && numAnswer < Number(correctAnswer)) return { tag: 'coin_total_low' };
  if (q.visualType === 'placeValue' && !Number.isNaN(numAnswer) && Math.abs(numAnswer - Number(correctAnswer)) % 9 === 0) return { tag: 'tens_ones_swapped' };
  if (q.skillId === 'division_facts' && numAnswer === a) return { tag: 'wrote_dividend_instead_of_quotient' };
  if (q.skillId === 'rounding_nearest_10' && numAnswer === a) return { tag: 'did_not_round' };
  if (q.skillId === 'negative_numbers_intro' && numAnswer === Math.abs(Number(correctAnswer))) return { tag: 'ignored_negative_sign' };
  if (q.skillId === 'multi_step_word_problems' && numAnswer === q.visualData?.step1) return { tag: 'stopped_after_first_step' };
  return null;
}

function finishLesson() {
  const profile = currentProfile();
  const answers = lessonSession.answers;
  const correct = answers.filter(a => a.isCorrect).length;
  const summary = {
    id: lessonSession.id,
    lessonNumber: lessonSession.lessonNumber,
    childId: profile.id,
    childName: profile.name,
    startedAt: lessonSession.startedAt,
    completedAt: new Date().toISOString(),
    total: answers.length,
    correct,
    accuracy: answers.length ? correct / answers.length : 0,
    reviewCount: answers.filter(a => !a.isCorrect).length,
    mode: lessonSession.mode || null,
    topicFilter: lessonSession.topicFilter || null
  };
  // Skills Area and Speed Test sessions are deliberately narrow (one topic,
  // or a timed mixed set) -- per-skill tiers/mastery from them should feed
  // back everywhere (handled below, same as Learning Progression), but the
  // *global* microLevel breadth gate is specifically Learning Progression's
  // pacing mechanism. Letting a single strong topic session yank it forward
  // would prematurely unlock unrelated topics there, so only adjust it for
  // ordinary mixed lessons.
  const isFocusedSession = !!(lessonSession.topicFilter || lessonSession.mode === 'speed');
  updateMastery(profile, answers, summary.accuracy, { adjustGlobalLevel: !isFocusedSession });
  // Stashed on the session itself (not route data) so it survives
  // navigating into review() and back via the generic "Back to summary"
  // button, which re-routes to 'results' with no extra data.
  if (lessonSession.topicFilter) lessonSession.topicLevelAfter = topicLevel(profile, lessonSession.topicFilter);
  if (lessonSession.mode === 'speed') {
    const correctAnswers = answers.filter(a => a.isCorrect);
    const avgMs = correctAnswers.length ? Math.round(correctAnswers.reduce((sum, a) => sum + a.elapsedMs, 0) / correctAnswers.length) : null;
    const prevBest = lessonSession.speedBestBefore;
    const improved = !prevBest || correct > prevBest.correctCount;
    profile.speedBest = { ...(profile.speedBest || {}), ...(improved ? { [lessonSession.speedKey]: { correctCount: correct, avgMs } } : {}) };
    lessonSession.speedResult = { correctCount: correct, avgMs, prevBest, improved };
  }
  // Carry difficulty progress forward, and flag whichever skills broke down
  // this session so next lesson retests them early rather than starting
  // from scratch every time.
  profile.skillTiers = { ...(profile.skillTiers || {}), ...lessonSession.tierBySkill };
  profile.reviewSkillIds = [...new Set(answers.filter(a => !a.isCorrect).map(a => a.skillId))];
  // Motivation layer: completing any session (any mode) counts toward the
  // daily streak and points total, and may unlock a badge -- stashed on the
  // session so the celebration screen can show what's new this time.
  const streak = updateStreak(profile);
  const pointsEarned = correct * 10 + (summary.accuracy >= 0.9 ? 50 : 0);
  profile.totalPoints = (profile.totalPoints || 0) + pointsEarned;
  lessonSession.pointsEarned = pointsEarned;
  lessonSession.streakCount = streak.count;
  lessonSession.newBadges = evaluateBadges(profile);
  profile.updatedAt = Date.now();
  state.lessonSummaries.push(summary);
  saveState();
  if (cloudWritesEnabled()) {
    saveLessonSummaryCloud(cloudUser.uid, summary).catch(() => {});
    saveChildCloud(cloudUser.uid, profile).catch(() => {});
  }
  setRoute('results');
}
// A correct answer that took a long time isn't yet "mastered" the way a
// quick, confident one is — Times Tables Rock Stars and Kumon both treat
// slow-but-correct as not-fluent-yet. So a correct answer earns full credit
// only if it came in under this threshold; over it, it earns half credit,
// the same partial weight as the generic mid-accuracy band below.
const FLUENCY_MS_THRESHOLD = 7000;
function answerWeight(answer) {
  if (!answer.isCorrect) return 0;
  return answer.elapsedMs > FLUENCY_MS_THRESHOLD ? 0.5 : 1;
}
function updateMastery(profile, answers, accuracy, { adjustGlobalLevel = true } = {}) {
  const bySkill = groupBy(answers, 'microSkillId');
  Object.entries(bySkill).forEach(([skill, skillAnswers]) => {
    const skillAccuracy = skillAnswers.reduce((sum, a) => sum + answerWeight(a), 0) / skillAnswers.length;
    const current = profile.mastery[skill] || 0;
    const delta = skillAccuracy >= 0.9 ? 0.12 : skillAccuracy >= 0.8 ? 0.06 : skillAccuracy >= 0.6 ? 0.01 : -0.04;
    profile.mastery[skill] = Math.max(0, Math.min(1, current + delta));
  });
  if (!adjustGlobalLevel) return;
  if (accuracy >= 0.9) profile.microLevel = Math.min(MAX_TIER, (profile.microLevel || 1) + 1);
  if (accuracy < 0.6) profile.microLevel = Math.max(1, (profile.microLevel || 1) - 1);
}
function groupBy(items, key) { return items.reduce((acc, item) => ((acc[item[key]] ||= []).push(item), acc), {}); }

function results() {
  const answers = lessonSession?.answers || [];
  const correctCount = answers.filter(a => a.isCorrect).length;
  const allCorrect = answers.length > 0 && correctCount === answers.length;
  const wrongCount = answers.length - correctCount;
  const bySkill = groupBy(answers, 'skillId');
  const breakdown = Object.entries(bySkill).map(([skillId, list]) => {
    const skillCorrect = list.filter(a => a.isCorrect).length;
    return { skillId, label: SKILL_DEFS.find(s => s.id === skillId)?.label || skillId, total: list.length, correct: skillCorrect, wrong: list.length - skillCorrect };
  });
  const topicLabel = lessonSession?.topicFilter ? TOPIC_DEFS.find(t => t.id === lessonSession.topicFilter)?.label : null;
  const topicDelta = topicLabel ? lessonSession.topicLevelAfter - lessonSession.topicLevelBefore : 0;
  const speedResult = lessonSession?.speedResult;
  shell(html`
    <div class="top-row"><div></div>${authBadge()}</div>
    <div class="question-main" style="text-align:left; align-items:stretch">
      <h1 style="text-align:center">${allCorrect ? 'Amazing — all correct!' : 'Lesson complete!'}</h1>
      <p style="text-align:center">${correctCount} out of ${answers.length} correct overall.</p>
      ${topicLabel ? `<div class="level-banner" style="justify-content:center">
        <strong>${escapeText(topicLabel)}: Level ${lessonSession.topicLevelBefore} ${topicDelta > 0 ? `→ Level ${lessonSession.topicLevelAfter} 🎉` : topicDelta < 0 ? `→ Level ${lessonSession.topicLevelAfter}` : '(no change yet)'}</strong>
      </div>` : ''}
      ${speedResult ? `<div class="level-banner" style="justify-content:center">
        <strong>${speedResult.improved ? `New best! ${speedResult.correctCount} correct${speedResult.prevBest ? `, up from ${speedResult.prevBest.correctCount} 🎉` : ' 🎉'}` : `${speedResult.correctCount} correct (best so far: ${speedResult.prevBest.correctCount})`}</strong>
      </div>` : ''}
      <div class="grid stat-grid" style="margin-bottom:8px">
        ${breakdown.map(b => `
          <div class="stat-card">
            <strong>${b.correct}/${b.total}</strong>
            <span>${escapeText(b.label)}</span>
            <p class="small" style="margin:6px 0 0">${b.wrong ? `${b.wrong} wrong` : 'All correct'}</p>
          </div>`).join('')}
      </div>
      <div class="question-actions">
        ${wrongCount ? `<button class="secondary" data-review-mistakes>Review ${wrongCount} mistake${wrongCount === 1 ? '' : 's'}</button>` : ''}
        <button class="primary cta-large" data-route="celebration">Finish</button>
      </div>
    </div>
  `);
  document.querySelector('[data-review-mistakes]')?.addEventListener('click', () => setRoute('review', { reviewIndex: 0 }));
}
// Walks through wrong answers only, one at a time -- a full grid of every
// question (including the many correct ones) just made it harder to find
// the handful that actually need a second look.
function review() {
  const items = (lessonSession?.answers || []).filter(a => !a.isCorrect);
  if (!items.length) return setRoute('results');
  const idx = Math.max(0, Math.min(route.reviewIndex || 0, items.length - 1));
  const item = items[idx];
  const explanation = explain(item);
  shell(html`
    <div class="top-row"><h3>Mistake ${idx + 1} of ${items.length}</h3><div class="nav"><button class="secondary" data-speak="${escapeText(explanation)}">Hear</button>${authBadge()}</div></div>
    <div class="question-main">
      <div class="review-box">
        <h2>Question: ${escapeText(item.prompt)}</h2>
        <div class="review-grid">
          <div class="review-cell"><span class="small">Your answer</span><h2>${escapeText(item.childAnswer)}</h2></div>
          <div class="review-cell"><span class="small">Correct answer</span><h2>${escapeText(item.correctAnswer)}</h2></div>
        </div>
        <h3>Why?</h3>
        <p>${escapeText(explanation)}</p>
        ${renderVisual(item)}
      </div>
      <div class="question-actions">
        <button class="ghost" data-route="results">Back to summary</button>
        ${idx > 0 ? `<button class="secondary" data-prev>Previous</button>` : ''}
        ${idx < items.length - 1 ? `<button class="secondary" data-next>Next</button>` : ''}
        <button class="secondary" data-try>Try one like this</button>
      </div>
    </div>
  `);
  document.querySelector('[data-prev]')?.addEventListener('click', () => setRoute('review', { reviewIndex: idx - 1 }));
  document.querySelector('[data-next]')?.addEventListener('click', () => setRoute('review', { reviewIndex: idx + 1 }));
  document.querySelector('[data-try]').addEventListener('click', () => {
    lessonSession.questions[lessonSession.index] = similarQuestion(item.question);
    setRoute('lesson');
  });
}
function explain(item) {
  const q = item.question;
  if (q.explanationType === 'addOne') {
    let extra = '';
    if (item.misconceptionTag === 'number_bond_confusion') extra = ` You may have been thinking about making 10. This time, we only needed to add one more.`;
    if (item.misconceptionTag === 'did_not_add') extra = ` You may have stopped at the starting number. Remember to count one step on.`;
    if (item.misconceptionTag === 'counted_backwards_instead_of_forwards') extra = ` You may have counted backwards. Adding one means count forwards.`;
    if (item.misconceptionTag === 'counted_on_too_far') extra = ` You may have counted on two steps. This question only asks for one more.`;
    return `${q.a} + 1 means one more than ${q.a}. Count on one step: ${q.a}, ${q.a + 1}. The answer is ${q.a + 1}.${extra}`;
  }
  if (q.explanationType === 'addTwo') {
    let extra = '';
    if (item.misconceptionTag === 'counted_on_too_few') extra = ` You may have counted on only one step. This time we need two.`;
    if (item.misconceptionTag === 'did_not_add') extra = ` You may have stopped at the starting number.`;
    return `${q.a} + 2 means two more than ${q.a}. Count on two steps: ${q.a}, ${q.a + 1}, ${q.a + 2}. The answer is ${q.a + 2}.${extra}`;
  }
  if (q.explanationType === 'subtractOne') {
    let extra = '';
    if (item.misconceptionTag === 'counted_forwards_instead_of_back') extra = ` You may have counted forwards instead of backwards.`;
    if (item.misconceptionTag === 'did_not_subtract') extra = ` You may have stayed at the starting number.`;
    return `${q.a} - 1 means one less than ${q.a}. Count back one step: ${q.a}, ${q.a - 1}. The answer is ${q.a - 1}.${extra}`;
  }
  if (q.explanationType === 'bond10') return `A number bond to 10 is a pair that makes 10. Start with ${q.a}, then count up to 10. ${q.a} needs ${10 - q.a} more, so the answer is ${10 - q.a}.`;
  if (q.explanationType === 'bond20') return `A number bond to 20 is a pair that makes 20. Start with ${q.a}, then count up to 20. ${q.a} needs ${20 - q.a} more, so the answer is ${20 - q.a}.`;
  if (q.explanationType === 'oclock') return `For an o'clock time, the long minute hand points to 12. The short hour hand points to the hour. ${q.correctAnswer} means ${q.correctAnswer.split(':')[0]} o'clock.`;
  if (q.explanationType === 'halfPast') return `For half past, the long minute hand points to 6, and the short hour hand sits halfway between two numbers. ${q.correctAnswer} means half past ${q.correctAnswer.split(':')[0]}.`;
  if (q.explanationType === 'quarterHour') return `Quarter past means 15 minutes after the hour. Quarter to means 15 minutes before the next hour. Look for the long hand on 3 or 9, then check the short hand.`;
  if (q.explanationType === 'timesTable') {
    const extra = item.misconceptionTag === 'added_instead_of_multiplied' ? ` You may have added instead of multiplying.` : '';
    return `${q.a} × ${q.table} means ${q.a} groups of ${q.table}. Add ${q.table} up ${q.a} times: that's ${item.correctAnswer}.${extra}`;
  }
  if (q.explanationType === 'fiveMinuteClock') return `Count round the clock in fives with the long hand. Each big number is 5 more minutes. The correct clock shows ${q.correctAnswer}.`;
  if (q.explanationType === 'oneMinuteClock') return `Use the five-minute numbers first, then count the small tick marks one by one. The correct clock shows ${q.correctAnswer}.`;
  if (q.explanationType === 'placeValue') return `${q.correctAnswer} has ${Math.floor(Number(q.correctAnswer) / 10)} tens and ${Number(q.correctAnswer) % 10} ones. Count the tens rods first, then the ones cubes.`;
  if (q.explanationType === 'barModel') return `The bar model shows the whole amount split into parts. Use the known parts to find the missing part or total. The answer is ${item.correctAnswer}.`;
  if (q.explanationType === 'fractionShape') return `A fraction tells us how many equal parts are shaded. Count the shaded parts, then count all equal parts. That gives ${item.correctAnswer}.`;
  if (q.explanationType === 'shape') return `Look at the sides and corners carefully. The correct answer is ${item.correctAnswer}.`;
  if (q.explanationType === 'measurement') return `Compare the two bars from the same starting line. The longer bar reaches further, so the answer is ${item.correctAnswer}.`;
  if (q.explanationType === 'money') {
    if (q.visualData?.mode === 'change') return `Change = amount paid − price = ${q.visualData.paid}p − ${q.visualData.price}p = ${item.correctAnswer}p.`;
    return `Add the coin values together. The total is ${item.correctAnswer}p.`;
  }
  if (q.explanationType === 'pattern') return `Find the repeating rule, then use the rule to fill the missing place. The answer is ${item.correctAnswer}.`;
  if (q.explanationType === 'division') {
    const extra = item.misconceptionTag === 'wrote_dividend_instead_of_quotient' ? ` You may have written the whole amount instead of the number of groups.` : '';
    return `${q.a} ÷ ${q.table} means splitting ${q.a} into equal groups of ${q.table}. There are ${item.correctAnswer} groups.${extra}`;
  }
  if (q.explanationType === 'elapsedTime') return `From ${q.visualData.start} to ${q.visualData.end} is ${item.correctAnswer} minutes. Count on from the start time to the end time.`;
  if (q.explanationType === 'unitConversion') return q.visualData.mode === 'm_to_cm' ? `1 metre = 100 centimetres, so ${q.visualData.m} m = ${q.visualData.m * 100} cm.` : `1 metre = 100 centimetres, so ${q.visualData.m * 100} cm = ${q.visualData.m} m.`;
  if (q.explanationType === 'fractionOfAmount') return `${q.visualData.amount} split into ${q.visualData.denom} equal groups gives ${q.visualData.groupsPerPart} in each group. ${q.visualData.numerator} group${q.visualData.numerator === 1 ? '' : 's'} make ${item.correctAnswer}.`;
  if (q.explanationType === 'rounding') {
    const extra = item.misconceptionTag === 'did_not_round' ? ` You may have kept the original number instead of rounding it.` : '';
    const lower = Math.floor(q.a / 10) * 10;
    return `${q.a} sits between ${lower} and ${lower + 10}. It is closer to ${item.correctAnswer}, so we round to ${item.correctAnswer}.${extra}`;
  }
  if (q.explanationType === 'pictogram') {
    const [label, icon] = q.visualData.categories[q.a];
    return `Count the ${icon} symbols next to ${label}: there are ${item.correctAnswer}.`;
  }
  if (q.explanationType === 'missingNumber') {
    const form = q.visualData?.form;
    if (form === 'subRight') return `${q.a} - __ = ${q.b} means the missing number is the gap between ${q.b} and ${q.a}. ${q.a} - ${q.b} = ${item.correctAnswer}.`;
    return `Both sides of the = sign must match. ${q.a} and the missing number together make ${q.b}, so the missing number is ${q.b} - ${q.a} = ${item.correctAnswer}.`;
  }
  if (q.explanationType === 'negativeNumbers') {
    const extra = item.misconceptionTag === 'ignored_negative_sign' ? ` Don't forget the minus sign once you go below zero.` : '';
    return `Counting down from ${q.a} by ${q.b} takes you past 0. ${q.a} - ${q.b} = ${item.correctAnswer}.${extra}`;
  }
  if (q.explanationType === 'decimalCompare') {
    if (q.visualData?.mode === 'compare') return `Compare the whole number part first, then the digit after the decimal point. ${item.correctAnswer === 'A' ? q.a : q.b} is bigger.`;
    return `Line up the decimal points, then add: ${q.a} + ${q.b} = ${item.correctAnswer}.`;
  }
  if (q.explanationType === 'multiStep') {
    const d = q.visualData;
    const extra = item.misconceptionTag === 'stopped_after_first_step' ? ` Remember there's a second step after the multiplication.` : '';
    return `First: ${d.n} × ${d.groupSize} = ${d.step1}. Then ${d.op === 'add' ? `add ${d.extra}: ${d.step1} + ${d.extra}` : `subtract ${d.extra}: ${d.step1} - ${d.extra}`} = ${item.correctAnswer}.${extra}`;
  }
  if (q.explanationType === 'digitalClock') {
    if (q.visualData?.mode === 'to12') return `${q.visualData.time24} is 24-hour time. Hours 13-23 are afternoon: subtract 12 and use 'pm' (12:xx stays 12 pm). The answer is ${item.correctAnswer}.`;
    return `${q.visualData.time12} — for 'pm' hours (except 12), add 12 to the hour. For 'am' hours, keep the hour the same (12 am becomes 00). The answer is ${item.correctAnswer}.`;
  }
  return `The correct answer is ${item.correctAnswer}.`;
}
function renderVisual(item) {
  const q = item.question;
  if (q.visualType === 'numberLine') {
    const steps = Math.abs(q.correctAnswer - q.a);
    const dir = q.correctAnswer > q.a ? 'on' : 'back';
    const lineMax = Math.min(60, Math.max(q.a, q.correctAnswer, 10));
    return `<div class="visual-line"><strong>Show me</strong><div class="number-line">${Array.from({ length: lineMax + 1 }, (_, n) => `<span class="tick ${n === q.a || n === q.correctAnswer ? 'active' : ''}"><span>${n}</span><span class="mark"></span></span>`).join('')}</div><p class="small">Start at ${q.a}, then count ${dir} ${steps} step${steps === 1 ? '' : 's'} to ${q.correctAnswer}.</p></div>`;
  }
  if (q.visualType === 'tenFrame') {
    const total = q.skillId === 'number_bonds_to_20' ? 20 : 10;
    return `<div class="visual-line"><strong>Show me</strong><p>${q.a} counters are already there. Fill ${total - q.a} empty spaces to make ${total}.</p><div class="progress-dots">${Array.from({ length: total }, (_, i) => `<span class="dot ${i < q.a ? 'done' : ''}"></span>`).join('')}</div></div>`;
  }
  if (q.visualType === 'clock') return `<div class="visual-line"><strong>Show me</strong><div>${clockSvg(q.correctAnswer, q.minutePrecision ? 240 : 160)}</div></div>`;
  if (q.visualType === 'barModel') return `<div class="visual-line"><strong>Bar model</strong>${barModelSvg(q.visualData)}</div>`;
  if (q.visualType === 'fractionShape') return `<div class="visual-line"><strong>Fraction shape</strong>${fractionSvg(q.visualData)}</div>`;
  if (q.visualType === 'shape') return `<div class="visual-line"><strong>Shape</strong>${shapeSvg(q.visualData?.shape || q.correctAnswer)}</div>`;
  if (q.visualType === 'measurement') return `<div class="visual-line"><strong>Compare lengths</strong>${measurementSvg(q.visualData)}</div>`;
  if (q.visualType === 'money') {
    if (q.visualData?.mode === 'change') return `<div class="visual-line"><strong>Money</strong><p>Price: ${q.visualData.price}p. Paid: ${q.visualData.paid >= 100 ? '£' + q.visualData.paid / 100 : q.visualData.paid + 'p'}.</p></div>`;
    return `<div class="visual-line"><strong>UK coins</strong><div class="coin-row">${(q.visualData?.coins || []).map(coin => `<span class="coin">${coin >= 100 ? '£' + coin / 100 : coin + 'p'}</span>`).join('')}</div></div>`;
  }
  if (q.visualType === 'placeValue') return `<div class="visual-line"><strong>Tens and ones</strong>${placeValueSvg(q.visualData?.number || q.correctAnswer)}</div>`;
  if (q.visualType === 'pattern') return `<div class="visual-line"><strong>Pattern</strong>${patternHtml(q.visualData)}</div>`;
  if (q.visualType === 'timesTable') return `<div class="visual-line"><strong>Groups</strong>${timesTableHtml(q.visualData)}</div>`;
  if (q.visualType === 'elapsedTime') return `<div class="visual-line"><strong>Elapsed time</strong><div class="coin-row"><span>Start<br>${clockSvg(q.visualData.start, 110)}</span><span>End<br>${clockSvg(q.visualData.end, 110)}</span></div></div>`;
  if (q.visualType === 'unitConversion') return `<div class="visual-line"><strong>Remember</strong><p>1 metre = 100 centimetres.</p></div>`;
  if (q.visualType === 'fractionOfAmount') return `<div class="visual-line"><strong>Equal groups</strong>${fractionOfAmountHtml(q.visualData)}</div>`;
  if (q.visualType === 'rounding') return `<div class="visual-line"><strong>Number line</strong>${roundingHtml(q.a)}</div>`;
  if (q.visualType === 'pictogram') return `<div class="visual-line"><strong>Pictogram</strong>${pictogramHtml(q.visualData)}</div>`;
  if (q.visualType === 'missingNumber') return `<div class="visual-line"><strong>Balance both sides</strong><p>${escapeText(q.prompt)}</p></div>`;
  if (q.visualType === 'negativeNumbers') return `<div class="visual-line"><strong>Number line</strong>${negativeNumberLineHtml(q.a, q.correctAnswer)}</div>`;
  if (q.visualType === 'decimalCompare') return `<div class="visual-line"><strong>Decimals</strong>${decimalCompareHtml(q.visualData)}</div>`;
  if (q.visualType === 'multiStep') return `<div class="visual-line"><strong>Two steps</strong>${multiStepHtml(q.visualData)}</div>`;
  if (q.visualType === 'digitalClock') return `<div class="visual-line"><strong>Remember</strong><p>Afternoon hours (1pm-11pm) = add 12 for 24-hour time. Morning hours stay the same, except 12am = 00:00.</p></div>`;
  return '';
}
function timesTableHtml(data = {}) {
  const a = data.a || 1;
  const table = data.table || 1;
  return `<div class="pattern-row">${Array.from({ length: a }, () => `<span class="pattern-item" style="display:flex;gap:4px;flex-wrap:wrap;min-width:auto">${Array.from({ length: table }, () => '🔵').join('')}</span>`).join('')}</div>`;
}
function barModelSvg(data = {}) {
  const total = Math.max(1, data.total || (data.known || 0) + (data.unknown || 0));
  const knownWidth = Math.max(18, Math.round((data.known || 1) / total * 320));
  const unknownWidth = Math.max(18, 320 - knownWidth);
  return `<svg class="bar-svg" viewBox="0 0 380 104" role="img" aria-label="Bar model"><rect x="30" y="24" width="${knownWidth}" height="42" rx="8"/><rect x="${30 + knownWidth}" y="24" width="${unknownWidth}" height="42" rx="8" class="unknown"/><text x="${30 + knownWidth / 2}" y="52">${data.known ?? ''}</text><text x="${30 + knownWidth + unknownWidth / 2}" y="52">?</text>${data.revealTotal ? `<text x="190" y="92">Total ${total}</text>` : ''}</svg>`;
}
function fractionSvg(data = {}) {
  const denom = data.denom || 2;
  const shaded = data.shaded || 1;
  if (data.style === 'circle') return fractionCircleSvg(denom, shaded);
  if (data.style === 'dots') return fractionDotsHtml(denom, shaded);
  return `<div class="fraction-shape" style="--parts: ${denom}">${Array.from({ length: denom }, (_, i) => `<span class="fraction-part ${i < shaded ? 'shaded' : ''}"></span>`).join('')}</div>`;
}
function fractionCircleSvg(denom, shaded) {
  const cx = 60, cy = 60, r = 54;
  const toRad = deg => (deg - 90) * Math.PI / 180;
  const step = 360 / denom;
  const wedges = Array.from({ length: denom }, (_, i) => {
    const start = i * step, end = (i + 1) * step;
    const x1 = cx + r * Math.cos(toRad(start)), y1 = cy + r * Math.sin(toRad(start));
    const x2 = cx + r * Math.cos(toRad(end)), y2 = cy + r * Math.sin(toRad(end));
    const largeArc = end - start > 180 ? 1 : 0;
    const path = denom === 1 ? `M${cx},${cy - r} A${r},${r} 0 1 1 ${cx - 0.01},${cy - r} Z` : `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${largeArc} 1 ${x2},${y2} Z`;
    return `<path d="${path}" class="fraction-wedge ${i < shaded ? 'shaded' : ''}"/>`;
  }).join('');
  return `<svg class="shape-svg" viewBox="0 0 120 120" role="img" aria-label="Fraction circle">${wedges}</svg>`;
}
function fractionDotsHtml(denom, shaded) {
  return `<div class="coin-row">${Array.from({ length: denom }, (_, i) => `<span class="fraction-dot ${i < shaded ? 'shaded' : ''}"></span>`).join('')}</div>`;
}
function shapeSvg(name) {
  const points = { triangle: '60,12 108,104 12,104', square: '20,20 100,20 100,100 20,100', rectangle: '12,32 108,32 108,88 12,88', pentagon: '60,10 108,46 90,108 30,108 12,46', hexagon: '34,14 86,14 112,60 86,106 34,106 8,60' };
  if (name === 'circle') return `<svg class="shape-svg" viewBox="0 0 120 120" role="img" aria-label="Circle"><circle cx="60" cy="60" r="45"/></svg>`;
  return `<svg class="shape-svg" viewBox="0 0 120 120" role="img" aria-label="${escapeText(name || 'triangle')}"><polygon points="${points[name] || points.triangle}"/></svg>`;
}
function measurementSvg(data = {}) {
  const a = (data.a || 6) * 14;
  const b = (data.b || 8) * 14;
  return `<svg class="measure-svg" viewBox="0 0 260 110" role="img" aria-label="Bar A is ${data.a || 6} units long, bar B is ${data.b || 8} units long"><text x="8" y="32">A</text><rect x="36" y="14" width="${a}" height="28" rx="7"/><text x="8" y="82">B</text><rect x="36" y="64" width="${b}" height="28" rx="7" class="unknown"/>${Array.from({ length: 12 }, (_, i) => `<line x1="${36 + i * 18}" y1="96" x2="${36 + i * 18}" y2="104"/>`).join('')}</svg>`;
}
function placeValueSvg(number) {
  const n = Number(number) || 0;
  const hundreds = Math.floor(n / 100);
  const tens = Math.floor((n % 100) / 10);
  const ones = n % 10;
  return `<div class="place-value">${hundreds ? `<div><strong>${hundreds} hundreds</strong><br>${Array.from({ length: hundreds }, () => '<span class="hundred-flat"></span>').join('')}</div>` : ''}<div><strong>${tens} tens</strong><br>${Array.from({ length: tens }, () => '<span class="ten-rod"></span>').join('')}</div><div><strong>${ones} ones</strong><br>${Array.from({ length: ones }, () => '<span class="one-cube"></span>').join('')}</div></div>`;
}
function patternHtml(data = {}) {
  const sequence = data.sequence || [];
  return `<div class="pattern-row">${sequence.map((item, i) => `<span class="pattern-item">${i === data.missingIndex ? '?' : escapeText(item)}</span>`).join('')}</div>`;
}
function fractionOfAmountHtml(data = {}) {
  const { denom = 1, groupsPerPart = 1, numerator = 1 } = data;
  return `<div class="pattern-row">${Array.from({ length: denom }, (_, i) => `<span class="pattern-item" style="display:flex;gap:4px;flex-wrap:wrap;min-width:auto;${i < numerator ? 'background:#ffe6a8;border-radius:8px;' : ''}">${Array.from({ length: groupsPerPart }, () => '🔵').join('')}</span>`).join('')}</div>`;
}
function roundingHtml(n) {
  const lower = Math.floor(n / 10) * 10;
  const upper = lower + 10;
  return `<p>${lower} ... ${n} ... ${upper}</p><p class="small">${n} is closer to ${Math.abs(n - lower) <= Math.abs(n - upper) ? lower : upper}.</p>`;
}
function pictogramHtml(data = {}) {
  const { categories = [], counts = [] } = data;
  return `<div class="grid" style="gap:6px">${categories.map(([label, icon], i) => `<div><strong>${escapeText(label)}</strong>: ${icon.repeat(counts[i] || 0)}</div>`).join('')}</div>`;
}
function negativeNumberLineHtml(start, correctAnswer) {
  return `<p>Count down from ${start}, through 0, to ${correctAnswer}.</p><p class="small">Below zero, numbers carry a minus sign: -1, -2, -3...</p>`;
}
function decimalCompareHtml(data = {}) {
  if (data.mode === 'compare') return `<p style="font-size:1.4rem; font-weight:800">A: ${data.a}   B: ${data.b}</p>`;
  return `<p class="small">Line up the decimal points before adding.</p>`;
}
function multiStepHtml(data = {}) {
  return `<p>Step 1: ${data.n} × ${data.groupSize} = ${data.step1}</p><p>Step 2: ${data.step1} ${data.op === 'add' ? '+' : '-'} ${data.extra} = ?</p>`;
}
// Builds a fresh question for the same skill, one notch easier than the
// one just got wrong, so the retry is a genuine stepping stone rather than
// the exact same question again.
function similarQuestion(q) {
  const skillDef = SKILL_DEFS.find(s => s.id === q.skillId);
  if (!skillDef) return q;
  const tier = q.tier || 1;
  const [min, max] = skillDef.rangeForTier(tier);
  const a = Math.max(min, Math.min(max, (q.a ?? min) - 1));
  return buildQuestion(skillDef, a, tier);
}
function celebration() {
  const profile = currentProfile();
  const latest = state.lessonSummaries[state.lessonSummaries.length - 1];
  const next = latest?.accuracy >= 0.9 ? 'Next time: a harder set of questions.' : latest?.accuracy >= 0.8 ? 'Next time: more practice at this level.' : 'Next time: a repair lesson with extra visual help, focused on what tripped you up.';
  const newBadges = lessonSession?.newBadges || [];
  shell(html`
    <div class="question-main">
      <h1>Great learning!</h1>
      <p>${escapeText(profile.name)}, you finished lesson ${latest?.lessonNumber || ''}.</p>
      <div class="rewards-row">
        ${lessonSession?.pointsEarned ? `<span class="reward-chip">⭐ +${lessonSession.pointsEarned} points</span>` : ''}
        ${lessonSession?.streakCount ? `<span class="reward-chip">🔥 ${lessonSession.streakCount}-day streak</span>` : ''}
      </div>
      ${newBadges.length ? `<div class="next-box badge-unlock"><h3>New badge${newBadges.length === 1 ? '' : 's'} unlocked!</h3><div class="rewards-row">${newBadges.map(id => { const b = BADGE_DEFS.find(d => d.id === id); return `<span class="reward-chip">${b.icon} ${escapeText(b.label)}</span>`; }).join('')}</div></div>` : ''}
      <div class="next-box"><h3>${next}</h3><p>The parent dashboard has been updated. Lessons are saved on this device and will sync when online.</p></div>
      <button class="primary cta-large" data-route="home">Finish</button>
    </div>
  `);
}
function parentGate() {
  shell(html`
    <div class="top-row"><button class="ghost" data-route="home">Back</button><div class="nav">${statusPill()}${authBadge()}</div></div>
    <h1>Parent Area</h1>
    <p>Enter the parent PIN. For this prototype, the default PIN is 1234.</p>
    <div class="grid" style="max-width:420px">
      <input class="field" type="password" inputmode="numeric" id="pin" aria-label="Parent PIN">
      <button class="primary" data-unlock>Unlock</button>
      <p class="small" id="pin-error"></p>
      ${state.adminMode ? '<button class="ghost" data-exit-admin>Exit admin test mode</button>' : '<button class="link-button" data-route="adminLogin" style="width:fit-content">Admin test mode</button>'}
    </div>
  `);
  document.querySelector('[data-unlock]').addEventListener('click', () => {
    if (document.querySelector('#pin').value === state.parentPin) setRoute('parentDashboard');
    else document.querySelector('#pin-error').textContent = 'That PIN did not match.';
  });
  document.querySelector('[data-exit-admin]')?.addEventListener('click', exitAdminMode);
}
// A way to click through the app (start lessons, answer questions, check
// screens) without it counting against a real child's progress or syncing
// anywhere -- swaps in a separate, local-only sandbox profile/attempts/
// lessonSummaries for as long as admin mode is on, then restores the real
// ones untouched on exit. This is a fixed demo login (not real auth) since
// its only purpose is letting the app's owner poke at it safely.
function adminLogin() {
  shell(html`
    <div class="top-row"><button class="ghost" data-route="parentGate">Back</button></div>
    <h1>Admin test mode</h1>
    <p>Try the app without affecting any child's real progress. A separate test profile is used instead, and nothing in this mode syncs to the cloud.</p>
    <div class="grid" style="max-width:380px">
      <label class="small">Username<input class="field" id="admin-username" autocomplete="off"></label>
      <label class="small">Password<input class="field" type="password" id="admin-password"></label>
      <p class="small" id="admin-error"></p>
      <button class="primary cta-large" data-admin-login>Enter test mode</button>
    </div>
  `);
  document.querySelector('[data-admin-login]').addEventListener('click', () => {
    const username = document.querySelector('#admin-username').value.trim();
    const password = document.querySelector('#admin-password').value;
    if (username === 'admin' && password === '1234') enterAdminMode();
    else document.querySelector('#admin-error').textContent = 'Incorrect username or password.';
  });
}
function enterAdminMode() {
  state._stash = {
    profiles: state.profiles,
    attempts: state.attempts,
    lessonSummaries: state.lessonSummaries,
    currentProfileId: state.currentProfileId
  };
  if (!state.sandboxProfile) {
    state.sandboxProfile = { id: 'admin-sandbox', name: 'Admin Test', avatar: '🧪', stage: 'Test', microLevel: 1, mastery: {}, skillTiers: {} };
  }
  state.sandboxAttempts = state.sandboxAttempts || [];
  state.sandboxLessonSummaries = state.sandboxLessonSummaries || [];
  state.profiles = [state.sandboxProfile];
  state.attempts = state.sandboxAttempts;
  state.lessonSummaries = state.sandboxLessonSummaries;
  state.currentProfileId = state.sandboxProfile.id;
  state.adminMode = true;
  saveState();
  setRoute('home');
}
function exitAdminMode() {
  // state.profiles/attempts/lessonSummaries currently *are* the sandbox
  // arrays by reference, so re-pointing the sandbox* fields at them first
  // keeps any progress made during this session before swapping back to
  // the stashed real data.
  state.sandboxProfile = state.profiles[0];
  state.sandboxAttempts = state.attempts;
  state.sandboxLessonSummaries = state.lessonSummaries;
  if (state._stash) {
    state.profiles = state._stash.profiles;
    state.attempts = state._stash.attempts;
    state.lessonSummaries = state._stash.lessonSummaries;
    state.currentProfileId = state._stash.currentProfileId;
    state._stash = null;
  }
  state.adminMode = false;
  saveState();
  setRoute('home');
}
// Cloud writes must stay off in admin mode even when cloudUser is signed
// in -- sandbox play-throughs are explicitly meant to never touch a real
// account's Firestore data.
function cloudWritesEnabled() { return !!cloudUser && !state.adminMode; }
function parentDashboard() {
  const summaries = [...state.lessonSummaries].reverse();
  const mistakes = [...state.attempts].filter(a => !a.isCorrect || a.usedHint).slice(-12).reverse();
  const profile = currentProfile();
  const nudges = profile ? computeParentNudges(profile) : [];
  shell(html`
    <div class="top-row"><div><h1>Parent Dashboard</h1><p>Progress, recent mistakes, mastery and offline sync status.</p></div><div class="nav"><button class="ghost" data-route="home">Child mode</button><button class="secondary" data-refresh>Refresh content</button>${authBadge()}</div></div>
    ${nudges.length ? `<div class="dashboard-card nudge-card">
      <h2>Heads up</h2>
      <div class="grid" style="gap:8px">
        ${nudges.map(n => `<div class="nudge-row nudge-${n.type}">${n.type === 'good' ? '✓' : '⚠'} ${escapeText(n.text)}</div>`).join('')}
      </div>
    </div>` : ''}
    <div class="grid dashboard">
      <div class="dashboard-card">
        <h2>Topics</h2>
        <p class="small">What ${profile ? escapeText(profile.name) : 'your child'} is currently being tested at, topic by topic.</p>
        <div class="grid stat-grid">
          ${profile ? TOPIC_DEFS.map(t => {
            const level = topicLevel(profile, t.id);
            const skillTierLine = t.skillIds.map(id => `${escapeText(SKILL_DEFS.find(s => s.id === id)?.label || id)}: ${profile.skillTiers?.[id] || 1}`).join(', ');
            return `<div class="stat-card">
              <strong>Level ${level}</strong>
              <span>${escapeText(t.label)}</span>
              <p class="small" style="margin:6px 0 0">${skillTierLine}</p>
            </div>`;
          }).join('') : ''}
        </div>
      </div>
      <div class="dashboard-card">
        <h2>Progress over time</h2>
        ${summaries.length ? `
          <p class="small">Overall accuracy, lesson by lesson.</p>
          <canvas id="overall-chart" height="160"></canvas>
          <p class="small" style="margin-top:14px">Accuracy by topic, lesson by lesson.</p>
          <canvas id="topic-chart" height="180"></canvas>
        ` : '<p class="small">No lessons yet — charts will appear here once a few are completed.</p>'}
      </div>
      <div class="dashboard-card">
        <h2>Your learner</h2>
        ${cloudUser ? `<p class="small">Signed in as ${escapeText(cloudUser.email)}. This account is linked to one learner, synced automatically across devices.</p>` : ''}
        <div class="grid stat-grid">
          ${state.profiles.map(p => `
            <div class="stat-card">
              <strong>${p.avatar} ${escapeText(p.name)}</strong><span>${escapeText(p.stage)}</span>
              <p class="small" style="margin:6px 0">Computed level: <strong>${p.microLevel || 1} of ${MAX_TIER}</strong> · Overall progress: <strong>${overallProgressScore(p.id)} of ${PARENT_PROGRESS_MAX}</strong></p>
              <p class="small">${Object.keys(p.mastery || {}).length ? Object.keys(p.mastery).map(id => `${escapeText(skillLabelForMicroId(id))}: ${skillScore(p.id, id).label}`).join(', ') : 'No lessons yet'}</p>
              ${Object.keys(p.skillTiers || {}).length ? `<p class="small">${Object.entries(p.skillTiers).map(([id, t]) => `${escapeText(SKILL_DEFS.find(s => s.id === id)?.label || id)}: tier ${t}`).join(', ')}</p>` : ''}
              <div class="level-override">
                <label class="small" for="level-input-${p.id}">Set difficulty level: <strong id="level-display-${p.id}">${p.microLevel || 1}</strong> of ${MAX_TIER}</label>
                <input type="range" min="1" max="${MAX_TIER}" value="${p.microLevel || 1}" class="level-slider" id="level-input-${p.id}" aria-label="Set difficulty level, 1 to ${MAX_TIER}">
              </div>
            </div>`).join('')}
        </div>
        <h3 style="margin-top:22px">Edit profile</h3>
        <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); align-items:end">
          <label class="small">Name<input class="field" id="edit-child-name" value="${escapeText(state.profiles[0]?.name || '')}" maxlength="24"></label>
          <label class="small">Avatar<input class="field" id="edit-child-avatar" value="${escapeText(state.profiles[0]?.avatar || '🐧')}" maxlength="2"></label>
          <label class="small">Stage<input class="field" id="edit-child-stage" value="${escapeText(state.profiles[0]?.stage || '')}" maxlength="40"></label>
          <button class="primary" data-save-profile>Save</button>
        </div>
        <p class="small" id="edit-profile-error"></p>
      </div>
      <div class="dashboard-card">
        <h2>Streak, points and badges</h2>
        <p class="small">🔥 ${profile?.streak?.count || 0}-day streak · ⭐ ${profile?.totalPoints || 0} points</p>
        <div class="grid stat-grid">
          ${BADGE_DEFS.map(b => {
            const earned = (profile?.badgesEarned || []).includes(b.id);
            return `<div class="stat-card ${earned ? '' : 'badge-locked'}"><strong>${b.icon}</strong><span>${escapeText(b.label)}${earned ? '' : ' (locked)'}</span></div>`;
          }).join('')}
        </div>
      </div>
      <div class="dashboard-card">
        <h2>Offline and sync</h2>
        <p>${statusPill()} <span class="badge">Content v${state.contentVersion}</span></p>
        <p class="small">${cloudUser ? 'Cross-device sync is on for this account — every attempt and lesson saves automatically as it happens.' : 'Cross-device sync is not set up, so progress only lives on this device.'}</p>
      </div>
      <div class="dashboard-card">
        <h2>Lesson history</h2>
        ${summaries.length ? `<p class="small">Click any row for a full breakdown of that session.</p><table class="table"><thead><tr><th>Lesson</th><th>Date</th><th>Child</th><th>Score</th><th>Wrong</th></tr></thead><tbody>${summaries.map(s => `<tr class="row-clickable" data-session="${s.id}" tabindex="0" role="button" aria-label="View details for lesson ${s.lessonNumber || ''}, scored ${s.correct} out of ${s.total}"><td>${s.lessonNumber || '—'}</td><td>${new Date(s.completedAt).toLocaleDateString('en-GB')}</td><td>${escapeText(s.childName)}</td><td>${s.correct}/${s.total}</td><td>${s.reviewCount} items</td></tr>`).join('')}</tbody></table>` : '<p>No completed lessons yet.</p>'}
      </div>
      <div class="dashboard-card">
        <h2>Recent mistakes and hints</h2>
        ${mistakes.length ? `<table class="table"><thead><tr><th>Question</th><th>Answer</th><th>Likely issue</th></tr></thead><tbody>${mistakes.map(a => `<tr><td>${escapeText(a.prompt)}</td><td>${escapeText(a.childAnswer)} (correct ${escapeText(a.correctAnswer)})</td><td>${escapeText(labelMistake(a.misconceptionTag, a.usedHint))}</td></tr>`).join('')}</tbody></table>` : '<p>No mistakes or hints recorded yet.</p>'}
      </div>
    </div>
  `);
  document.querySelector('[data-refresh]').addEventListener('click', () => { state.contentVersion += 1; saveState(); render(); });
  document.querySelectorAll('[data-session]').forEach(row => {
    const open = () => setRoute('sessionDetail', { sessionId: row.dataset.session });
    row.addEventListener('click', open);
    row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
  document.querySelectorAll('.level-slider').forEach(slider => {
    const id = slider.id.replace('level-input-', '');
    const display = document.querySelector(`#level-display-${id}`);
    // Update the live number while dragging without re-rendering (a
    // re-render mid-drag would recreate the slider and lose the user's
    // grip on it), then commit the actual change only once they let go.
    slider.addEventListener('input', () => { display.textContent = slider.value; });
    slider.addEventListener('change', () => {
      const target = state.profiles.find(p => p.id === id);
      if (!target) return;
      const newLevel = Math.max(1, Math.min(MAX_TIER, Number(slider.value) || 1));
      target.microLevel = newLevel;
      // Lift any per-skill tiers that are lagging behind so the override
      // takes effect everywhere immediately, not just for skills the child
      // hasn't started yet -- otherwise an already-tracked easy skill would
      // stay stuck at its old (lower) tier despite the override.
      target.skillTiers = { ...(target.skillTiers || {}) };
      Object.keys(target.skillTiers).forEach(skillId => {
        target.skillTiers[skillId] = Math.max(target.skillTiers[skillId], newLevel);
      });
      target.updatedAt = Date.now();
      saveState();
      if (cloudWritesEnabled()) saveChildCloud(cloudUser.uid, target).catch(() => {});
      render();
    });
  });
  document.querySelector('[data-save-profile]').addEventListener('click', () => {
    const profile = state.profiles[0];
    const errorEl = document.querySelector('#edit-profile-error');
    const name = document.querySelector('#edit-child-name').value.trim();
    if (!name) { errorEl.textContent = 'Please enter a name.'; return; }
    profile.name = name;
    profile.avatar = document.querySelector('#edit-child-avatar').value.trim() || profile.avatar;
    profile.stage = document.querySelector('#edit-child-stage').value.trim() || profile.stage;
    profile.updatedAt = Date.now();
    saveState();
    if (cloudWritesEnabled()) saveChildCloud(cloudUser.uid, profile).catch(() => {});
    render();
  });
  renderProgressCharts();
}
// Chart.js instances must be destroyed before a dashboard re-render (e.g.
// after moving the level slider) replaces the <canvas> elements wholesale
// via innerHTML -- otherwise each re-render leaks a chart bound to an
// orphaned canvas.
let chartInstances = {};
// A separate, much longer-range 0-100 progress score for the parent
// dashboard only -- distinct from the internal 1-12 difficulty tier
// (which governs actual question content and stays capped at 12). Roughly
// 1000 well-answered lessons reaches 100, but each lesson's contribution is
// weighted by its accuracy rather than counted flatly, so grinding through
// lessons without actually improving doesn't move the number much.
const LESSONS_FOR_FULL_PROGRESS = 1000;
const PARENT_PROGRESS_MAX = 100;
function overallProgressScore(childId) {
  const credits = state.lessonSummaries
    .filter(l => l.childId === childId)
    .reduce((sum, l) => sum + Math.max(0, Math.min(1, l.accuracy ?? 0)), 0);
  return Math.min(PARENT_PROGRESS_MAX, Math.round((credits / LESSONS_FOR_FULL_PROGRESS) * PARENT_PROGRESS_MAX));
}
function chronologicalSummaries() {
  return [...state.lessonSummaries].sort((a, b) => (a.lessonNumber || 0) - (b.lessonNumber || 0));
}
function topicAccuracySeries() {
  const lessons = chronologicalSummaries();
  const byLessonTopic = {};
  state.attempts.forEach(a => {
    const topicId = topicForSkill(a.skillId);
    if (!topicId) return;
    byLessonTopic[a.lessonId] ||= {};
    byLessonTopic[a.lessonId][topicId] ||= { correct: 0, total: 0 };
    byLessonTopic[a.lessonId][topicId].total += 1;
    if (a.isCorrect) byLessonTopic[a.lessonId][topicId].correct += 1;
  });
  return {
    labels: lessons.map(s => `L${s.lessonNumber}`),
    datasets: TOPIC_DEFS.map(t => ({
      label: t.label,
      spanGaps: true,
      data: lessons.map(s => {
        const cell = byLessonTopic[s.id]?.[t.id];
        return cell ? Math.round((cell.correct / cell.total) * 100) : null;
      })
    }))
  };
}
// Only counts skills the child could plausibly have attempted already
// (same reasoning as topicLevel's onlyEligible option), and skips topics
// with zero eligible skills entirely -- a topic that's simply not unlocked
// yet isn't "weak", it just hasn't started.
function eligibleTopicLevels(profile) {
  const eligibleIds = new Set(eligibleSkills(profile).map(s => s.id));
  return TOPIC_DEFS.map(t => {
    const ids = t.skillIds.filter(id => eligibleIds.has(id));
    if (!ids.length) return null;
    const level = Math.round(ids.reduce((sum, id) => sum + (profile.skillTiers?.[id] || 1), 0) / ids.length);
    return { id: t.id, label: t.label, level };
  }).filter(Boolean);
}
// A short, prioritised "what should I look at" list for a parent who has
// 10 seconds, not 10 minutes -- everything here is derived live from
// existing attempts/tiers, so it can't say something that isn't actually
// true right now. Mixes warnings with genuine good news so it doesn't read
// as constant criticism.
function computeParentNudges(profile) {
  const nudges = [];
  if (!state.lessonSummaries.length) return nudges;

  const lastActive = profile.streak?.lastActiveDate;
  if (lastActive) {
    const daysSince = Math.round((Date.now() - new Date(lastActive).getTime()) / 86400000);
    if (daysSince >= 3) nudges.push({ type: 'warn', text: `No lessons in ${daysSince} days — the streak has reset.` });
  }

  const series = topicAccuracySeries();
  series.datasets.forEach(d => {
    const points = d.data.filter(v => v !== null);
    if (points.length < 2) return;
    const [prev, latest] = points.slice(-2);
    if (latest <= prev - 15) nudges.push({ type: 'warn', text: `${d.label} accuracy dropped from ${prev}% to ${latest}% in the most recent lesson.` });
    else if (points.length >= 3 && latest >= prev + 15) nudges.push({ type: 'good', text: `${d.label} accuracy is climbing — up to ${latest}% in the most recent lesson.` });
  });

  const levels = eligibleTopicLevels(profile);
  if (levels.length > 1) {
    const avg = levels.reduce((sum, l) => sum + l.level, 0) / levels.length;
    const weakest = [...levels].sort((a, b) => a.level - b.level)[0];
    if (weakest.level <= avg - 2 && weakest.level < 5) nudges.push({ type: 'warn', text: `${weakest.label} (level ${weakest.level}) is behind their other topics (average level ${avg.toFixed(1)}) — a Skills Area session would help.` });
  }

  const recentMistakes = state.attempts.filter(a => a.childId === profile.id && a.misconceptionTag).slice(-20);
  Object.entries(groupBy(recentMistakes, 'misconceptionTag')).forEach(([tag, list]) => {
    if (list.length >= 3) nudges.push({ type: 'warn', text: `${labelMistake(tag)} (seen ${list.length} times recently).` });
  });

  return nudges.slice(0, 4);
}
function sessionDetail() {
  const summary = state.lessonSummaries.find(s => s.id === route.sessionId);
  if (!summary) { setRoute('parentDashboard'); return; }
  const attempts = state.attempts.filter(a => a.lessonId === summary.id);
  const totalMs = new Date(summary.completedAt) - new Date(summary.startedAt);
  const avgMsPerQuestion = attempts.length ? Math.round(attempts.reduce((sum, a) => sum + (a.elapsedMs || 0), 0) / attempts.length) : null;
  const hintsUsed = attempts.filter(a => a.usedHint).length;
  const bySkill = groupBy(attempts, 'skillId');
  const formatMs = ms => ms == null ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  const modeLabel = summary.mode === 'speed' ? 'Speed Test' : summary.topicFilter ? 'Skills Area / Learning Zone' : 'Learning Progression';
  shell(html`
    <div class="top-row"><button class="ghost" data-route="parentDashboard">Back</button><div class="nav">${authBadge()}</div></div>
    <h1>Lesson ${summary.lessonNumber || '—'}</h1>
    <p class="small">${escapeText(summary.childName)} · ${new Date(summary.completedAt).toLocaleString('en-GB')} · ${escapeText(modeLabel)}</p>
    <div class="grid stat-grid">
      <div class="stat-card"><strong>${summary.correct}/${summary.total}</strong><span>Correct</span></div>
      <div class="stat-card"><strong>${Math.round(summary.accuracy * 100)}%</strong><span>Accuracy</span></div>
      <div class="stat-card"><strong>${totalMs > 0 ? formatMs(totalMs) : '—'}</strong><span>Time spent</span></div>
      <div class="stat-card"><strong>${formatMs(avgMsPerQuestion)}</strong><span>Avg time / question</span></div>
      <div class="stat-card"><strong>${hintsUsed}</strong><span>Hints used</span></div>
      <div class="stat-card"><strong>${summary.reviewCount}</strong><span>Wrong answers</span></div>
    </div>
    <div class="dashboard-card">
      <h2>By skill</h2>
      <table class="table"><thead><tr><th>Skill</th><th>Correct</th><th>Avg time</th></tr></thead><tbody>
        ${Object.entries(bySkill).map(([skillId, list]) => {
          const correctCount = list.filter(a => a.isCorrect).length;
          const avg = Math.round(list.reduce((sum, a) => sum + (a.elapsedMs || 0), 0) / list.length);
          return `<tr><td>${escapeText(SKILL_DEFS.find(s => s.id === skillId)?.label || skillId)}</td><td>${correctCount}/${list.length}</td><td>${formatMs(avg)}</td></tr>`;
        }).join('')}
      </tbody></table>
    </div>
    <div class="dashboard-card">
      <h2>Question by question</h2>
      <table class="table"><thead><tr><th>Question</th><th>Answer</th><th>Time</th></tr></thead><tbody>
        ${attempts.map(a => `<tr><td>${escapeText(a.prompt)}</td><td>${a.isCorrect ? '✓' : `✗ (${escapeText(a.childAnswer)}, correct ${escapeText(a.correctAnswer)})`}</td><td>${formatMs(a.elapsedMs)}</td></tr>`).join('')}
      </tbody></table>
    </div>
  `);
}
function renderProgressCharts() {
  if (typeof Chart === 'undefined' || !state.lessonSummaries.length) return;
  Object.values(chartInstances).forEach(c => c?.destroy());
  chartInstances = {};
  const lessons = chronologicalSummaries();
  const overallCanvas = document.querySelector('#overall-chart');
  if (overallCanvas) {
    chartInstances.overall = new Chart(overallCanvas, {
      type: 'line',
      data: {
        labels: lessons.map(s => `L${s.lessonNumber}`),
        datasets: [{ label: 'Accuracy %', data: lessons.map(s => Math.round((s.accuracy || 0) * 100)), borderColor: '#6f805f', backgroundColor: 'rgba(111,128,95,0.15)', fill: true, tension: 0.25 }]
      },
      options: { scales: { y: { min: 0, max: 100 } }, plugins: { legend: { display: false } } }
    });
  }
  const topicCanvas = document.querySelector('#topic-chart');
  if (topicCanvas) {
    const palette = ['#6f805f', '#b5403a', '#1d3a57', '#a0752c', '#5b3f91', '#2f7a63', '#c75a87', '#3c6e8f', '#8a7a3c'];
    const series = topicAccuracySeries();
    chartInstances.topic = new Chart(topicCanvas, {
      type: 'line',
      data: { labels: series.labels, datasets: series.datasets.map((d, i) => ({ ...d, borderColor: palette[i % palette.length], tension: 0.25 })) },
      options: { scales: { y: { min: 0, max: 100 } } }
    });
  }
}
function labelMistake(tag, usedHint) {
  if (tag === 'did_not_add') return 'May not have added on';
  if (tag === 'counted_backwards_instead_of_forwards') return 'May have counted backwards';
  if (tag === 'counted_on_too_far') return 'May have counted on too far';
  if (tag === 'counted_on_too_few') return 'May have counted on too few steps';
  if (tag === 'did_not_subtract') return 'May not have counted back';
  if (tag === 'counted_forwards_instead_of_back') return 'May have counted forwards instead of back';
  if (tag === 'number_bond_confusion') return 'May be thinking about making 10';
  if (tag === 'added_instead_of_missing') return 'May have added instead of finding the missing part';
  if (tag === 'confused_oclock_and_half_past') return 'May confuse o’clock and half past';
  if (tag === 'confused_half_past_and_oclock') return 'May confuse half past and o’clock';
  if (tag === 'clock_minute_hand') return 'May need minute-hand practice';
  if (tag === 'coin_total_low') return 'May have missed a coin';
  if (tag === 'tens_ones_swapped') return 'May have swapped tens and ones';
  if (tag === 'added_instead_of_multiplied') return 'May have added instead of multiplying';
  if (tag === 'wrote_dividend_instead_of_quotient') return 'May have written the whole amount instead of dividing';
  if (tag === 'did_not_round') return 'May not have rounded';
  if (tag === 'ignored_negative_sign') return 'May have ignored the negative sign';
  if (tag === 'stopped_after_first_step') return 'May have stopped after the first step';
  if (usedHint) return 'Used hint';
  return 'Needs review';
}
function hintFor(q) {
  if (q.explanationType === 'addOne') return `Start at ${q.a}, then count one more step.`;
  if (q.explanationType === 'addTwo') return `Start at ${q.a}, then count on two steps.`;
  if (q.explanationType === 'subtractOne') return `Start at ${q.a}, then count back one step.`;
  if (q.explanationType === 'bond10') return `Think: how many more does ${q.a} need to reach 10?`;
  if (q.explanationType === 'bond20') return `Think: how many more does ${q.a} need to reach 20?`;
  if (q.explanationType === 'oclock') return `For o'clock, the long hand points to 12.`;
  if (q.explanationType === 'halfPast') return `For half past, the long hand points to 6.`;
  if (q.explanationType === 'quarterHour') return `Quarter past uses the 3. Quarter to uses the 9.`;
  if (q.explanationType === 'timesTable') return `Think of it as ${q.a} groups of ${q.table}.`;
  if (q.explanationType === 'fiveMinuteClock') return `Count the minute hand round in fives: 5, 10, 15, 20...`;
  if (q.explanationType === 'oneMinuteClock') return `Find the nearest five-minute mark, then count the small ticks one by one.`;
  if (q.explanationType === 'placeValue') return `Count tens first, then add the ones.`;
  if (q.explanationType === 'barModel') return `Use the bar to see the parts and the whole.`;
  if (q.explanationType === 'fractionShape') return `Count shaded parts over total equal parts.`;
  if (q.explanationType === 'shape') return `Look at the number of sides and corners.`;
  if (q.explanationType === 'measurement') return `Start both bars at the left and see which reaches further.`;
  if (q.explanationType === 'money') return q.visualData?.mode === 'change' ? `Subtract the price from the amount paid.` : `Add each coin label together.`;
  if (q.explanationType === 'pattern') return `Look for what repeats.`;
  if (q.explanationType === 'division') return `Think: how many groups of ${q.table} fit into ${q.a}?`;
  if (q.explanationType === 'elapsedTime') return `Count on from the start time to the end time in minutes.`;
  if (q.explanationType === 'unitConversion') return `Remember: 1 metre = 100 centimetres.`;
  if (q.explanationType === 'fractionOfAmount') return `Split the amount into equal groups first, then count the groups you need.`;
  if (q.explanationType === 'rounding') return `Find the two nearest tens, then see which one ${q.a} is closer to.`;
  if (q.explanationType === 'pictogram') return `Count the picture symbols one by one for that category.`;
  if (q.explanationType === 'missingNumber') return `Both sides of the = sign must balance. Work out what's missing.`;
  if (q.explanationType === 'negativeNumbers') return `Count down through zero — after 0 comes -1, -2, -3...`;
  if (q.explanationType === 'decimalCompare') return q.visualData?.mode === 'compare' ? `Compare the whole number part first, then the digit after the decimal point.` : `Line up the decimal points before adding.`;
  if (q.explanationType === 'multiStep') return `Break it into two steps: first multiply, then ${q.visualData?.op === 'add' ? 'add' : 'subtract'}.`;
  if (q.explanationType === 'digitalClock') return `Afternoon hours (1pm-11pm) = add 12. Morning hours stay the same, except 12am = 00:00.`;
  return 'Have a careful look and try your best.';
}
function clockSvg(value, size = 132) {
  const [hRaw, mRaw] = String(value).split(':').map(Number);
  const hour = ((hRaw % 12) + (mRaw || 0) / 60) * 30;
  const minute = (mRaw || 0) * 6;
  const minuteTicks = Array.from({ length: 60 }, (_, i) => {
    const a = i * Math.PI / 30;
    const outer = 54;
    const inner = i % 5 === 0 ? 48 : 51;
    return `<line x1="${60 + Math.sin(a) * inner}" y1="${60 - Math.cos(a) * inner}" x2="${60 + Math.sin(a) * outer}" y2="${60 - Math.cos(a) * outer}" stroke="#536246" stroke-width="${i % 5 === 0 ? 1.6 : 0.7}"/>`;
  }).join('');
  return `<svg width="${size}" height="${size}" style="max-width:${size}px; width:100%; height:auto; display:block; margin:0 auto" viewBox="0 0 120 120" role="img" aria-label="Clock ${value}">
    <circle cx="60" cy="60" r="54" fill="#fffaf2" stroke="#536246" stroke-width="4"/>
    ${minuteTicks}
    ${[...Array(12)].map((_, i) => { const a = (i + 1) * Math.PI / 6; const x = 60 + Math.sin(a) * 40; const y = 60 - Math.cos(a) * 40; return `<text x="${x}" y="${y + 4}" text-anchor="middle" font-size="9" fill="#536246">${i + 1}</text>`; }).join('')}
    <line x1="60" y1="60" x2="${60 + Math.sin(hour * Math.PI / 180) * 24}" y2="${60 - Math.cos(hour * Math.PI / 180) * 24}" stroke="#243029" stroke-width="6" stroke-linecap="round"/>
    <line x1="60" y1="60" x2="${60 + Math.sin(minute * Math.PI / 180) * 42}" y2="${60 - Math.cos(minute * Math.PI / 180) * 42}" stroke="#6f805f" stroke-width="4" stroke-linecap="round"/>
    <circle cx="60" cy="60" r="4" fill="#243029"/>
  </svg>`;
}

