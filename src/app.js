import {
  isCloudConfigured, onAuthChange, signInParent, signUpParent, signOutParent,
  subscribeChildren, subscribeAttempts, subscribeLessonSummaries,
  saveChildCloud, deleteChildCloud, saveAttemptCloud, saveLessonSummaryCloud
} from './cloud-sync.js';

const storeKey = 'kidsMathsTutor.v1';
const app = document.querySelector('#app');
const defaultProfiles = [
  { id: 'child-a', name: 'Ava', avatar: '🦊', stage: 'Reception into Year 1', microLevel: 1, mastery: { add_1_within_10: 0.35, bonds_to_10_missing_addend: 0.2 } },
  { id: 'child-b', name: 'Leo', avatar: '🐻', stage: 'Year 1 into Year 2', microLevel: 2, mastery: { add_1_within_10: 0.55, bonds_to_10_missing_addend: 0.28 } }
];
const state = loadState();
let route = { screen: 'profiles' };
let lessonSession = null;
let seed = null;
let misconceptionRules = null;
// Cloud sync state: cloudUser is the signed-in Firebase user (or null if
// not using cloud sync at all, or not yet signed in on this device).
let cloudUser = null;
let cloudUnsubscribers = [];
let authError = '';

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
    if (route.screen !== 'signIn') setRoute('signIn');
    return;
  }
  let sawChildrenYet = false;
  Promise.all([
    subscribeChildren(user.uid, children => {
      if (!sawChildrenYet) {
        sawChildrenYet = true;
        // First snapshot after sign-in: if this account has no cloud
        // children yet, push whatever is currently local (defaults or
        // anything created offline) up as the starting point.
        if (children.length === 0 && state.profiles.length) {
          state.profiles.forEach(p => saveChildCloud(user.uid, p));
          return;
        }
      }
      state.profiles = children;
      if (!state.profiles.find(p => p.id === state.currentProfileId)) {
        state.currentProfileId = state.profiles[0]?.id || null;
      }
      saveState();
      render();
    }),
    subscribeAttempts(user.uid, attempts => { state.attempts = attempts; saveState(); render(); }),
    subscribeLessonSummaries(user.uid, summaries => { state.lessonSummaries = summaries; saveState(); render(); })
  ]).then(unsubs => { cloudUnsubscribers = unsubs; });
  if (route.screen === 'signIn') setRoute('profiles');
}

function loadState() {
  const saved = localStorage.getItem(storeKey);
  const defaults = {
    profiles: defaultProfiles,
    attempts: [],
    lessonSummaries: [],
    syncQueue: [],
    // NOTE: this PIN is a speed-bump to stop a young child wandering into
    // the parent area, NOT a security control. It is stored in plain text
    // in localStorage and is readable/editable by anyone with device access
    // or devtools. Do not reuse this pattern for anything that needs real
    // authentication (e.g. account access, payments, data export to a server).
    parentPin: '1234',
    contentVersion: 1,
    currentProfileId: null
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
function setRoute(screen, data = {}) { route = { screen, ...data }; render(); }
function currentProfile() { return state.profiles.find(p => p.id === state.currentProfileId) || state.profiles[0]; }
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
  return `<span class="badge">${escapeText(cloudUser.email)} <button class="ghost" data-signout>Sign out</button></span>`;
}
function bindGlobalButtons() {
  document.querySelectorAll('[data-route]').forEach(btn => btn.addEventListener('click', () => setRoute(btn.dataset.route)));
  document.querySelectorAll('[data-speak]').forEach(btn => btn.addEventListener('click', () => speak(btn.dataset.speak)));
  document.querySelectorAll('[data-signout]').forEach(btn => btn.addEventListener('click', () => { signOutParent().catch(() => {}); }));
}
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-GB';
  utterance.rate = 0.86;
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}

function render() {
  if (!seed) return;
  const screens = { signIn, profiles, home, lessonIntro, lesson, results, review, celebration, parentGate, parentDashboard };
  screens[route.screen]?.();
}

function signIn() {
  shell(html`
    <h1>Sign in</h1>
    <p>Sign in once on this device to sync lessons and progress across your devices. Use the same email and password on each device/browser.</p>
    <div class="grid" style="max-width:420px">
      <label class="small">Email<input class="answer-box" type="email" id="signin-email" autocomplete="email"></label>
      <label class="small">Password<input class="answer-box" type="password" id="signin-password" autocomplete="current-password"></label>
      <p class="small" id="signin-error">${escapeText(authError)}</p>
      <button class="primary cta-large" data-signin>Sign in</button>
      <button class="ghost" data-signup>First time? Create account</button>
    </div>
  `);
  document.querySelector('[data-signin]').addEventListener('click', () => submitAuth(signInParent));
  document.querySelector('[data-signup]').addEventListener('click', () => submitAuth(signUpParent));
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

function profiles() {
  shell(html`
    <div class="top-row"><div>${statusPill()} ${authBadge()}</div><button class="ghost" data-route="parentGate">Parent Area</button></div>
    <h1>Who is learning?</h1>
    <p>Choose a profile. Each child has their own learning path and today's lesson.</p>
    <div class="grid profiles">
      ${state.profiles.map(p => `
        <button class="profile-card" data-profile="${p.id}">
          <div class="avatar">${p.avatar}</div>
          <h2>${escapeText(p.name)}</h2>
          <p>${escapeText(p.stage)}</p>
        </button>`).join('')}
    </div>
  `);
  document.querySelectorAll('[data-profile]').forEach(btn => btn.addEventListener('click', () => {
    state.currentProfileId = btn.dataset.profile;
    saveState();
    setRoute('home');
  }));
}

function home() {
  const profile = currentProfile();
  const completedCount = state.lessonSummaries.filter(l => l.childId === profile.id).length;
  const nextLessonNumber = completedCount + 1;
  const skills = eligibleSkills(profile);
  const masteryEntries = Object.entries(profile.mastery || {});
  const level = profile.microLevel || 1;
  const tierEntries = Object.entries(profile.skillTiers || {});
  shell(html`
    <div class="top-row"><button class="ghost" data-route="profiles">Change profile</button><div class="nav"><button class="ghost" data-route="parentGate">Parent Area</button>${statusPill()}${authBadge()}</div></div>
    <h1>Hello, ${escapeText(profile.name)}</h1>
    <div class="level-banner"><strong>Level ${level} of ${MAX_TIER}</strong><span class="small">Computed from real lesson results — not a label anyone typed in.</span></div>
    <p>Lesson ${nextLessonNumber} is ready. We will practise ${skills.map(s => s.label.toLowerCase()).join(', ')}.</p>
    <button class="primary cta-large" data-start-lesson>Start Lesson ${nextLessonNumber}</button>
    <h3>Progress</h3>
    <p class="small">${completedCount} lesson${completedCount === 1 ? '' : 's'} completed so far.</p>
    ${tierEntries.length ? `<div class="tier-chip-row">${tierEntries.map(([id, t]) => `<span class="tier-chip">${escapeText(SKILL_DEFS.find(s => s.id === id)?.label || id)}: tier ${t}</span>`).join('')}</div>` : ''}
    <div class="grid stat-grid" style="margin-top:12px">
      ${masteryEntries.length ? masteryEntries.map(([id, v]) => `<div class="stat-card"><strong>${skillScore(profile.id, id).label}</strong><span>${escapeText(skillLabelForMicroId(id))}</span></div>`).join('') : '<div class="stat-card"><strong>—</strong><span>No lessons yet</span></div>'}
      <div class="stat-card"><strong>${state.syncQueue.length}</strong><span>Items to sync</span></div>
    </div>
  `);
  document.querySelector('[data-start-lesson]').addEventListener('click', () => setRoute('lessonIntro'));
}

function lessonIntro() {
  const profile = currentProfile();
  const lessonNumber = state.lessonSummaries.filter(l => l.childId === profile.id).length + 1;
  const skills = eligibleSkills(profile);
  shell(html`
    <div class="top-row"><button class="ghost" data-route="home">Back</button><button class="secondary" data-speak="Today we will practise ${skills.map(s => s.label.toLowerCase()).join(', ')}.">Hear</button></div>
    <h1>Lesson ${lessonNumber}</h1>
    <p>We will practise:</p>
    <ul class="lesson-list">
      ${skills.map(s => `<li>${escapeText(s.label)}</li>`).join('')}
    </ul>
    <button class="primary cta-large" data-begin>Begin</button>
  `);
  document.querySelector('[data-begin]').addEventListener('click', startLesson);
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
    build: (a, tier) => {
      const table = tier <= 4 ? [2, 5, 10][randomInt(0, 2)] : tier <= 8 ? [2, 3, 4, 5, 10][randomInt(0, 4)] : [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12][randomInt(0, 10)];
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
    build: count => {
      const usable = COINS.slice(0, count <= 4 ? 5 : 8);
      const coins = Array.from({ length: count }, () => usable[randomInt(0, usable.length - 1)]);
      const total = coins.reduce((sum, coin) => sum + coin, 0);
      return { prompt: 'How much money is this?', a: total, correctAnswer: total, choiceType: 'numericChoice', visualData: { coins } };
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
function clampTier(t) { return Math.max(1, Math.min(MAX_TIER, t || 1)); }
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
function compareChoices(correct) { return topUpChoices([correct, correct === 'A' ? 'B' : 'A', 'same'], () => ['A', 'B', 'same'][randomInt(0, 2)]); }
function patternChoices(correct) { return topUpChoices([correct, 'circle', 'square', 'triangle', 'red', 'blue', '2', '4', '6', '10', '15'], () => String(randomInt(1, 20))); }
function topUpChoices(candidates, makeCandidate) {
  const set = candidates.map(String).filter(unique);
  let guard = 0;
  while (set.length < 3 && guard < 30) {
    const candidate = String(makeCandidate());
    if (!set.includes(candidate)) set.push(candidate);
    guard += 1;
  }
  return shuffle(set.slice(0, 3));
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
    default: return null;
  }
}
function choicesForBuiltQuestion(built, skillDef, min, max) {
  if (built.choiceType === 'clock') return clockChoices(built.correctAnswer, !!built.exactMinute);
  if (built.choiceType === 'fraction') return fractionChoices(built.correctAnswer);
  if (built.choiceType === 'shape') return shapeChoices(built.correctAnswer);
  if (built.choiceType === 'compare') return compareChoices(built.correctAnswer);
  if (built.choiceType === 'pattern') return patternChoices(built.correctAnswer);
  const smartSeeds = misconceptionSeeds(skillDef.id, built);
  if (built.choiceType === 'numericChoice') {
    const seeds = (smartSeeds || [Number(built.correctAnswer), Number(built.correctAnswer) + 1, Number(built.correctAnswer) - 1, Number(built.correctAnswer) + 2]).filter(v => v >= 0);
    return distractorChoices(Number(built.correctAnswer), seeds, 0, Math.max(250, Number(built.correctAnswer) + 30));
  }
  const seeds = (smartSeeds || [built.correctAnswer, built.a ?? min, Number(built.correctAnswer) + 1, Number(built.correctAnswer) - 1]).filter(v => v >= 0);
  return distractorChoices(built.correctAnswer, seeds, Math.min(0, min - 5), max + 8);
}
function buildQuestion(skillDef, a, tier) {
  const built = skillDef.build(a, tier);
  const [min, max] = skillDef.rangeForTier(tier);
  const choices = choicesForBuiltQuestion(built, skillDef, min, max);
  const alwaysChoice = ['clock', 'fraction', 'shape', 'compare', 'pattern', 'numericChoice'].includes(built.choiceType);
  return {
    id: `q-${skillDef.id}-${Date.now()}-${Math.round(Math.random() * 1000)}`,
    type: alwaysChoice ? 'choice' : (Math.random() < 0.55 ? 'keypad' : 'choice'),
    skillId: skillDef.id,
    microSkillId: skillDef.microSkillId,
    tier,
    prompt: built.prompt,
    a: built.a ?? a,
    b: built.b,
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
  const skills = eligibleSkills(profile);
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
  return buildQuestion(skillDef, a, tier);
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
// Always returns exactly 3 distinct choices including the correct answer.
// Naive dedupe-then-slice could collapse to 1-2 options (e.g. a=9 gives
// [9,10,10,10] -> [9,10]), so we top up with nearby in-range numbers
// whenever the candidate pool has too few distinct values.
function distractorChoices(correctAnswer, candidates, min, max) {
  const set = [...candidates].filter(unique);
  let offset = 1;
  while (set.length < 3 && offset <= max - min) {
    [correctAnswer - offset, correctAnswer + offset].forEach(v => {
      if (set.length < 3 && v >= min && v <= max && !set.includes(v)) set.push(v);
    });
    offset += 1;
  }
  return shuffle(set.slice(0, 3));
}

function lesson() {
  if (!lessonSession) return setRoute('home');
  if (!lessonSession.questions[lessonSession.index]) {
    if (lessonSession.index >= lessonSession.totalQuestions) return finishLesson();
    lessonSession.questions[lessonSession.index] = generateNextQuestion(lessonSession, currentProfile());
  }
  const q = lessonSession.questions[lessonSession.index];
  const speakText = `${q.prompt.replace('__', 'blank')}`;
  shell(html`
    <div class="question-wrap">
      <div class="top-row">
        <div class="progress-dots">${lessonSession.questions.map((_, i) => `<span class="dot ${i < lessonSession.index ? 'done' : ''}"></span>`).join('')}</div>
        <button class="secondary" data-speak="${escapeText(speakText)}">Hear</button>
        ${authBadge()}
      </div>
      <div class="question-main">
        <div class="prompt">${escapeText(q.prompt)}</div>
        ${renderQuestionVisual(q)}
        ${renderQuestionInput(q)}
        ${lessonSession.hintOpen ? `<div class="hint-box">${hintFor(q)}</div>` : ''}
      </div>
      <div class="question-actions">
        <button class="secondary" data-hint>Hint</button>
        <button class="ghost" data-route="home">Stop</button>
      </div>
    </div>
  `);
  bindQuestion(q);
}

function renderQuestionVisual(q) {
  if (!['barModel', 'fractionShape', 'shape', 'measurement', 'money', 'placeValue', 'pattern', 'timesTable'].includes(q.visualType)) return '';
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
  document.querySelectorAll('[data-key]').forEach(btn => btn.addEventListener('click', () => { lessonSession.keypad = (lessonSession.keypad + btn.dataset.key).slice(0, 2); render(); }));
  document.querySelector('[data-delete]')?.addEventListener('click', () => { lessonSession.keypad = lessonSession.keypad.slice(0, -1); render(); });
  document.querySelector('[data-ok]')?.addEventListener('click', () => submitAnswer(q, lessonSession.keypad));
  document.querySelectorAll('[data-choice]').forEach(btn => btn.addEventListener('click', () => submitAnswer(q, btn.dataset.choice)));
}
function submitAnswer(q, rawAnswer) {
  if (rawAnswer === '') return;
  const elapsedMs = Math.round(performance.now() - lessonSession.questionStartedAt);
  const normalised = q.type === 'keypad' ? Number(rawAnswer) : rawAnswer;
  const isCorrect = String(normalised) === String(q.correctAnswer);
  const misconception = diagnose(q, normalised);
  const attempt = {
    id: `attempt-${Date.now()}-${q.id}`,
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
  lessonSession.answers.push(attempt);
  state.attempts.push(attempt);
  state.syncQueue.push({ type: 'attempt', payload: attempt });
  updateAdaptive(lessonSession, q, isCorrect);
  saveState();
  if (cloudUser) saveAttemptCloud(cloudUser.uid, attempt).catch(() => {});
  lessonSession.index += 1;
  lessonSession.keypad = '';
  lessonSession.hintOpen = false;
  lessonSession.questionStartedAt = performance.now();
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
  if (q.visualType === 'money' && numAnswer < Number(correctAnswer)) return { tag: 'coin_total_low' };
  if (q.visualType === 'placeValue' && !Number.isNaN(numAnswer) && Math.abs(numAnswer - Number(correctAnswer)) % 9 === 0) return { tag: 'tens_ones_swapped' };
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
    reviewCount: answers.filter(a => !a.isCorrect).length
  };
  updateMastery(profile, answers, summary.accuracy);
  // Carry difficulty progress forward, and flag whichever skills broke down
  // this session so next lesson retests them early rather than starting
  // from scratch every time.
  profile.skillTiers = { ...(profile.skillTiers || {}), ...lessonSession.tierBySkill };
  profile.reviewSkillIds = [...new Set(answers.filter(a => !a.isCorrect).map(a => a.skillId))];
  state.lessonSummaries.push(summary);
  state.syncQueue.push({ type: 'lessonSummary', payload: summary });
  saveState();
  if (cloudUser) {
    saveLessonSummaryCloud(cloudUser.uid, summary).catch(() => {});
    saveChildCloud(cloudUser.uid, profile).catch(() => {});
  }
  setRoute('results');
}
function updateMastery(profile, answers, accuracy) {
  const bySkill = groupBy(answers, 'microSkillId');
  Object.entries(bySkill).forEach(([skill, skillAnswers]) => {
    const skillAccuracy = skillAnswers.filter(a => a.isCorrect).length / skillAnswers.length;
    const current = profile.mastery[skill] || 0;
    const delta = skillAccuracy >= 0.9 ? 0.12 : skillAccuracy >= 0.8 ? 0.06 : skillAccuracy >= 0.6 ? 0.01 : -0.04;
    profile.mastery[skill] = Math.max(0, Math.min(1, current + delta));
  });
  if (accuracy >= 0.9) profile.microLevel = Math.min(MAX_TIER, (profile.microLevel || 1) + 1);
  if (accuracy < 0.6) profile.microLevel = Math.max(1, (profile.microLevel || 1) - 1);
}
function groupBy(items, key) { return items.reduce((acc, item) => ((acc[item[key]] ||= []).push(item), acc), {}); }

function results() {
  const answers = lessonSession?.answers || [];
  const correctCount = answers.filter(a => a.isCorrect).length;
  const allCorrect = answers.length > 0 && correctCount === answers.length;
  const bySkill = groupBy(answers, 'skillId');
  const breakdown = Object.entries(bySkill).map(([skillId, list]) => {
    const skillCorrect = list.filter(a => a.isCorrect).length;
    return { skillId, label: SKILL_DEFS.find(s => s.id === skillId)?.label || skillId, total: list.length, correct: skillCorrect, wrong: list.length - skillCorrect };
  });
  shell(html`
    <div class="top-row"><div></div>${authBadge()}</div>
    <div class="question-main" style="text-align:left; align-items:stretch">
      <h1 style="text-align:center">${allCorrect ? 'Amazing — all correct!' : 'Lesson complete!'}</h1>
      <p style="text-align:center">${correctCount} out of ${answers.length} correct overall.</p>
      <div class="grid stat-grid" style="margin-bottom:8px">
        ${breakdown.map(b => `
          <div class="stat-card">
            <strong>${b.correct}/${b.total}</strong>
            <span>${escapeText(b.label)}</span>
            <p class="small" style="margin:6px 0 0">${b.wrong ? `${b.wrong} wrong` : 'All correct'}</p>
          </div>`).join('')}
      </div>
      <p style="text-align:center">Tap a box to open the explanation. Green means correct, red means it needs review.</p>
      <div class="review-tile-grid" aria-label="Question review grid">
        ${answers.map((a, i) => `
          <button class="review-tile ${a.isCorrect ? 'correct' : 'wrong'}" data-review="${i}" aria-label="Question ${i + 1}, ${a.isCorrect ? 'correct' : 'wrong'}">
            <span class="review-tile-number">${i + 1}</span>
            <span class="review-tile-icon">${a.isCorrect ? '✓' : '✗'}</span>
          </button>`).join('')}
      </div>
      <button class="primary cta-large" data-route="celebration">Finish</button>
    </div>
  `);
  document.querySelectorAll('[data-review]').forEach(btn => btn.addEventListener('click', () => setRoute('review', { reviewIndex: Number(btn.dataset.review) })));
}
function review() {
  const items = lessonSession?.answers || [];
  const idx = route.reviewIndex || 0;
  const item = items[idx];
  if (!item) return setRoute('results');
  const explanation = explain(item);
  shell(html`
    <div class="top-row"><h3>Question ${idx + 1} of ${items.length}</h3><div class="nav"><button class="secondary" data-speak="${escapeText(explanation)}">Hear</button>${authBadge()}</div></div>
    <div class="question-main">
      <div class="review-box">
        <h2>Question: ${escapeText(item.prompt)}</h2>
        <div class="review-grid">
          <div class="review-cell"><span class="small">Your answer</span><h2>${escapeText(item.childAnswer)}</h2></div>
          <div class="review-cell"><span class="small">Correct answer</span><h2>${escapeText(item.correctAnswer)}</h2></div>
          <div class="review-cell"><span class="small">Result</span><h2>${item.isCorrect ? 'Correct' : 'Keep practising'}</h2></div>
        </div>
        <h3>Why?</h3>
        <p>${escapeText(explanation)}</p>
        ${renderVisual(item)}
      </div>
      <div class="question-actions">
        <button class="ghost" data-route="results">Back to summary</button>
        <button class="secondary" data-try>Try one like this</button>
      </div>
    </div>
  `);
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
  if (q.explanationType === 'money') return `Add the coin values together. The total is ${item.correctAnswer}p.`;
  if (q.explanationType === 'pattern') return `Find the repeating rule, then use the rule to fill the missing place. The answer is ${item.correctAnswer}.`;
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
  if (q.visualType === 'money') return `<div class="visual-line"><strong>UK coins</strong><div class="coin-row">${(q.visualData?.coins || []).map(coin => `<span class="coin">${coin >= 100 ? '£' + coin / 100 : coin + 'p'}</span>`).join('')}</div></div>`;
  if (q.visualType === 'placeValue') return `<div class="visual-line"><strong>Tens and ones</strong>${placeValueSvg(q.visualData?.number || q.correctAnswer)}</div>`;
  if (q.visualType === 'pattern') return `<div class="visual-line"><strong>Pattern</strong>${patternHtml(q.visualData)}</div>`;
  if (q.visualType === 'timesTable') return `<div class="visual-line"><strong>Groups</strong>${timesTableHtml(q.visualData)}</div>`;
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
  if (name === 'circle') return `<svg class="shape-svg" viewBox="0 0 120 120"><circle cx="60" cy="60" r="45"/></svg>`;
  return `<svg class="shape-svg" viewBox="0 0 120 120"><polygon points="${points[name] || points.triangle}"/></svg>`;
}
function measurementSvg(data = {}) {
  const a = (data.a || 6) * 14;
  const b = (data.b || 8) * 14;
  return `<svg class="measure-svg" viewBox="0 0 260 110"><text x="8" y="32">A</text><rect x="36" y="14" width="${a}" height="28" rx="7"/><text x="8" y="82">B</text><rect x="36" y="64" width="${b}" height="28" rx="7" class="unknown"/>${Array.from({ length: 12 }, (_, i) => `<line x1="${36 + i * 18}" y1="96" x2="${36 + i * 18}" y2="104"/>`).join('')}</svg>`;
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
  shell(html`
    <div class="question-main">
      <h1>Great learning!</h1>
      <p>${escapeText(profile.name)}, you finished lesson ${latest?.lessonNumber || ''}.</p>
      <div class="next-box"><h3>${next}</h3><p>The parent dashboard has been updated. Lessons are saved on this device and will sync when online.</p></div>
      <button class="primary cta-large" data-route="home">Finish</button>
    </div>
  `);
}
function parentGate() {
  shell(html`
    <div class="top-row"><button class="ghost" data-route="profiles">Back</button><div class="nav">${statusPill()}${authBadge()}</div></div>
    <h1>Parent Area</h1>
    <p>Enter the parent PIN. For this prototype, the default PIN is 1234.</p>
    <div class="grid" style="max-width:420px">
      <input class="answer-box" type="password" inputmode="numeric" id="pin" aria-label="Parent PIN">
      <button class="primary" data-unlock>Unlock</button>
      <p class="small" id="pin-error"></p>
    </div>
  `);
  document.querySelector('[data-unlock]').addEventListener('click', () => {
    if (document.querySelector('#pin').value === state.parentPin) setRoute('parentDashboard');
    else document.querySelector('#pin-error').textContent = 'That PIN did not match.';
  });
}
function parentDashboard() {
  const summaries = [...state.lessonSummaries].reverse();
  const mistakes = [...state.attempts].filter(a => !a.isCorrect || a.usedHint).slice(-12).reverse();
  shell(html`
    <div class="top-row"><div><h1>Parent Dashboard</h1><p>Progress, recent mistakes, mastery and offline sync status.</p></div><div class="nav"><button class="ghost" data-route="profiles">Child mode</button><button class="secondary" data-refresh>Refresh content</button><button class="primary" data-sync>Sync now</button>${authBadge()}</div></div>
    <div class="grid dashboard">
      <div class="dashboard-card">
        <h2>Children</h2>
        ${cloudUser ? `<p class="small">Signed in as ${escapeText(cloudUser.email)}. Children, lessons and attempts sync automatically across any device signed in to this account.</p>` : ''}
        <div class="grid stat-grid">
          ${state.profiles.map(p => `
            <div class="stat-card">
              <strong>${p.avatar} ${escapeText(p.name)}</strong><span>${escapeText(p.stage)}</span>
              <p class="small" style="margin:6px 0">Computed level: <strong>${p.microLevel || 1} of ${MAX_TIER}</strong></p>
              <p class="small">${Object.keys(p.mastery || {}).length ? Object.keys(p.mastery).map(id => `${escapeText(skillLabelForMicroId(id))}: ${skillScore(p.id, id).label}`).join(', ') : 'No lessons yet'}</p>
              ${Object.keys(p.skillTiers || {}).length ? `<p class="small">${Object.entries(p.skillTiers).map(([id, t]) => `${escapeText(SKILL_DEFS.find(s => s.id === id)?.label || id)}: tier ${t}`).join(', ')}</p>` : ''}
              <div class="level-override">
                <label class="small">Set difficulty level: <strong id="level-display-${p.id}">${p.microLevel || 1}</strong> of ${MAX_TIER}</label>
                <input type="range" min="1" max="${MAX_TIER}" value="${p.microLevel || 1}" class="level-slider" id="level-input-${p.id}">
              </div>
              <button class="danger" data-remove-profile="${p.id}" ${state.profiles.length <= 1 ? 'disabled' : ''}>Remove</button>
            </div>`).join('')}
        </div>
        <h3 style="margin-top:22px">Add a child</h3>
        <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); align-items:end">
          <label class="small">Name<input class="answer-box" id="new-child-name" placeholder="Name" maxlength="24"></label>
          <label class="small">Avatar<input class="answer-box" id="new-child-avatar" placeholder="🐧" maxlength="2" value="🐧"></label>
          <label class="small">Stage<input class="answer-box" id="new-child-stage" placeholder="Reception into Year 1" maxlength="40"></label>
          <button class="primary" data-add-profile>Add child</button>
        </div>
        <p class="small" id="add-child-error"></p>
      </div>
      <div class="dashboard-card">
        <h2>Offline and sync</h2>
        <p>${statusPill()} <span class="badge">Content v${state.contentVersion}</span></p>
        <p>${state.syncQueue.length} item${state.syncQueue.length === 1 ? '' : 's'} waiting to sync.</p>
        <p class="small">${cloudUser ? 'Cross-device sync is on for this account.' : 'Cross-device sync is not set up, so progress only lives on this device.'}</p>
      </div>
      <div class="dashboard-card">
        <h2>Lesson history</h2>
        ${summaries.length ? `<table class="table"><thead><tr><th>Lesson</th><th>Date</th><th>Child</th><th>Score</th><th>Wrong</th></tr></thead><tbody>${summaries.map(s => `<tr><td>${s.lessonNumber || '—'}</td><td>${new Date(s.completedAt).toLocaleDateString('en-GB')}</td><td>${escapeText(s.childName)}</td><td>${s.correct}/${s.total}</td><td>${s.reviewCount} items</td></tr>`).join('')}</tbody></table>` : '<p>No completed lessons yet.</p>'}
      </div>
      <div class="dashboard-card">
        <h2>Recent mistakes and hints</h2>
        ${mistakes.length ? `<table class="table"><thead><tr><th>Question</th><th>Answer</th><th>Likely issue</th></tr></thead><tbody>${mistakes.map(a => `<tr><td>${escapeText(a.prompt)}</td><td>${escapeText(a.childAnswer)} (correct ${escapeText(a.correctAnswer)})</td><td>${escapeText(labelMistake(a.misconceptionTag, a.usedHint))}</td></tr>`).join('')}</tbody></table>` : '<p>No mistakes or hints recorded yet.</p>'}
      </div>
    </div>
  `);
  document.querySelector('[data-sync]').addEventListener('click', () => { state.syncQueue = []; saveState(); render(); });
  document.querySelector('[data-refresh]').addEventListener('click', () => { state.contentVersion += 1; saveState(); render(); });
  document.querySelectorAll('[data-remove-profile]').forEach(btn => btn.addEventListener('click', () => {
    if (state.profiles.length <= 1) return;
    const id = btn.dataset.removeProfile;
    state.profiles = state.profiles.filter(p => p.id !== id);
    if (state.currentProfileId === id) state.currentProfileId = state.profiles[0]?.id || null;
    saveState();
    if (cloudUser) deleteChildCloud(cloudUser.uid, id).catch(() => {});
    render();
  }));
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
      saveState();
      if (cloudUser) saveChildCloud(cloudUser.uid, target).catch(() => {});
      render();
    });
  });
  document.querySelector('[data-add-profile]').addEventListener('click', () => {
    const name = document.querySelector('#new-child-name').value.trim();
    const avatar = document.querySelector('#new-child-avatar').value.trim() || '🐧';
    const stage = document.querySelector('#new-child-stage').value.trim() || 'Reception into Year 1';
    const errorEl = document.querySelector('#add-child-error');
    if (!name) { errorEl.textContent = 'Please enter a name.'; return; }
    const newProfile = {
      id: `child-${Date.now()}`,
      name,
      avatar,
      stage,
      microLevel: 1,
      mastery: {}
    };
    state.profiles.push(newProfile);
    saveState();
    if (cloudUser) saveChildCloud(cloudUser.uid, newProfile).catch(() => {});
    render();
  });
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
  if (q.explanationType === 'money') return `Add each coin label together.`;
  if (q.explanationType === 'pattern') return `Look for what repeats.`;
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

