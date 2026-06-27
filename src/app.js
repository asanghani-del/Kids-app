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
  shell(html`
    <div class="top-row"><button class="ghost" data-route="profiles">Change profile</button><div class="nav"><button class="ghost" data-route="parentGate">Parent Area</button>${statusPill()}${authBadge()}</div></div>
    <h1>Hello, ${escapeText(profile.name)}</h1>
    <p>Lesson ${nextLessonNumber} is ready. We will practise ${skills.map(s => s.label.toLowerCase()).join(', ')}.</p>
    <button class="primary cta-large" data-start-lesson>Start Lesson ${nextLessonNumber}</button>
    <h3>Progress</h3>
    <p class="small">${completedCount} lesson${completedCount === 1 ? '' : 's'} completed so far.</p>
    <div class="grid stat-grid" style="margin-top:12px">
      ${masteryEntries.length ? masteryEntries.map(([id, v]) => `<div class="stat-card"><strong>${Math.round((v || 0) * 100)}%</strong><span>${escapeText(skillLabelForMicroId(id))}</span></div>`).join('') : '<div class="stat-card"><strong>—</strong><span>No lessons yet</span></div>'}
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
    totalQuestions: 10,
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
const SKILL_DEFS = [
  {
    id: 'add_one_more', microSkillId: 'add_1_within_10', label: 'Adding one more',
    explanationType: 'addOne', visualType: 'numberLine',
    rangeForTier: tier => tier === 1 ? [1, 5] : tier === 2 ? [1, 9] : tier === 3 ? [10, 19] : [10, 30],
    build: a => ({ prompt: `${a} + 1 = ?`, a, correctAnswer: a + 1 })
  },
  {
    id: 'add_two_more', microSkillId: 'add_2_within_20', label: 'Adding two more',
    explanationType: 'addTwo', visualType: 'numberLine',
    rangeForTier: tier => tier === 1 ? [1, 7] : tier === 2 ? [1, 18] : tier === 3 ? [10, 28] : [10, 38],
    build: a => ({ prompt: `${a} + 2 = ?`, a, correctAnswer: a + 2 })
  },
  {
    id: 'subtract_one', microSkillId: 'subtract_1_within_20', label: 'Counting back one',
    explanationType: 'subtractOne', visualType: 'numberLine',
    rangeForTier: tier => tier === 1 ? [2, 10] : tier === 2 ? [2, 20] : [10, 30],
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
    id: 'read_oclock', microSkillId: 'identify_oclock_analogue', label: "Reading o'clock",
    explanationType: 'oclock', visualType: 'clock',
    rangeForTier: () => [1, 12],
    build: hour => ({ prompt: `Which clock shows ${hour} o'clock?`, a: hour, correctAnswer: `${hour}:00`, choiceType: 'clock' })
  },
  {
    id: 'read_half_past', microSkillId: 'identify_half_past_analogue', label: 'Reading half past',
    explanationType: 'halfPast', visualType: 'clock', minTier: 2,
    rangeForTier: () => [1, 12],
    build: hour => ({ prompt: `Which clock shows half past ${hour}?`, a: hour, correctAnswer: `${hour}:30`, choiceType: 'clock' })
  }
];
function eligibleSkills(profile) {
  const level = profile.microLevel || 1;
  return SKILL_DEFS.filter(s => !s.minTier || level >= s.minTier);
}
function skillLabelForMicroId(microId) {
  return SKILL_DEFS.find(s => s.microSkillId === microId)?.label || microId;
}
function clampTier(t) { return Math.max(1, Math.min(4, t || 1)); }
function randomInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }
function clockChoices(correct) {
  const [h] = correct.split(':').map(Number);
  const candidates = [correct, `${h}:00`, `${h}:30`, `${(h % 12) + 1}:00`, `${(h % 12) + 1}:30`].filter(unique);
  return shuffle(candidates.slice(0, 3));
}
function buildQuestion(skillDef, a, tier) {
  const built = skillDef.build(a, tier);
  const [min, max] = skillDef.rangeForTier(tier);
  const choices = built.choiceType === 'clock'
    ? clockChoices(built.correctAnswer)
    : distractorChoices(built.correctAnswer, [built.correctAnswer, built.a ?? a, built.correctAnswer + 1, built.correctAnswer - 1], Math.min(0, min - 5), max + 5);
  return {
    id: `q-${skillDef.id}-${Date.now()}-${Math.round(Math.random() * 1000)}`,
    type: built.choiceType === 'clock' ? 'choice' : (Math.random() < 0.55 ? 'keypad' : 'choice'),
    skillId: skillDef.id,
    microSkillId: skillDef.microSkillId,
    tier,
    prompt: built.prompt,
    a: built.a ?? a,
    correctAnswer: built.correctAnswer,
    choices,
    explanationType: skillDef.explanationType,
    visualType: skillDef.visualType
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
    skillDef = skills[(session.index + session.skillCursor) % skills.length];
  }
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

function renderQuestionInput(q) {
  if (q.type === 'choice') {
    return `<div class="choices">${q.choices.map(choice => `<button class="choice" data-choice="${choice}">${formatChoice(q, choice)}</button>`).join('')}</div>`;
  }
  return html`
    <div class="answer-box" aria-label="Answer box">${lessonSession.keypad || '&nbsp;'}</div>
    <div class="keypad">
      ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="key" data-key="${n}">${n}</button>`).join('')}
      <button class="key" data-key="0">0</button><button class="key wide" data-delete aria-label="Backspace, remove last digit">⌫ Backspace</button>
    </div>
    <button class="primary cta-large ok-button" data-ok>OK</button>
  `;
}
function formatChoice(q, choice) {
  if (q.visualType === 'clock') return `<span aria-label="${choice}">${clockSvg(choice)}</span><br><span class="small">${choice}</span>`;
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
  if (q.skillId === 'read_oclock' && String(answer).endsWith(':30')) return { tag: 'confused_oclock_and_half_past' };
  if (q.skillId === 'read_half_past' && String(answer).endsWith(':00')) return { tag: 'confused_half_past_and_oclock' };
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
  if (accuracy >= 0.9) profile.microLevel = Math.min(4, (profile.microLevel || 1) + 1);
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
      <p style="text-align:center">Tap any question below to see it explained — the crosses are the best ones to look at together.</p>
      <div class="grid results-list">
        ${answers.map((a, i) => `
          <button class="result-row ${a.isCorrect ? 'correct' : 'wrong'}" data-review="${i}">
            <span class="result-icon">${a.isCorrect ? '✓' : '✗'}</span>
            <span class="result-prompt">${escapeText(a.prompt)}<br><span class="small">Your answer: ${escapeText(a.childAnswer)}</span></span>
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
  return `The correct answer is ${item.correctAnswer}.`;
}
function renderVisual(item) {
  const q = item.question;
  if (q.visualType === 'numberLine') {
    const steps = Math.abs(q.correctAnswer - q.a);
    const dir = q.correctAnswer > q.a ? 'on' : 'back';
    const lineMax = Math.max(q.a, q.correctAnswer, 10);
    return `<div class="visual-line"><strong>Show me</strong><div class="number-line">${Array.from({ length: lineMax + 1 }, (_, n) => `<span class="tick ${n === q.a || n === q.correctAnswer ? 'active' : ''}"><span>${n}</span><span class="mark"></span></span>`).join('')}</div><p class="small">Start at ${q.a}, then count ${dir} ${steps} step${steps === 1 ? '' : 's'} to ${q.correctAnswer}.</p></div>`;
  }
  if (q.visualType === 'tenFrame') {
    const total = q.skillId === 'number_bonds_to_20' ? 20 : 10;
    return `<div class="visual-line"><strong>Show me</strong><p>${q.a} counters are already there. Fill ${total - q.a} empty spaces to make ${total}.</p><div class="progress-dots">${Array.from({ length: total }, (_, i) => `<span class="dot ${i < q.a ? 'done' : ''}"></span>`).join('')}</div></div>`;
  }
  if (q.visualType === 'clock') return `<div class="visual-line"><strong>Show me</strong><div>${clockSvg(q.correctAnswer, 150)}</div></div>`;
  return '';
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
              <p class="small">${Object.keys(p.mastery || {}).length ? Object.entries(p.mastery).map(([id, v]) => `${escapeText(skillLabelForMicroId(id))}: ${Math.round((v || 0) * 100)}%`).join(', ') : 'No lessons yet'}</p>
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
        ${summaries.length ? `<table class="table"><thead><tr><th>Lesson</th><th>Date</th><th>Child</th><th>Accuracy</th><th>Wrong</th></tr></thead><tbody>${summaries.map(s => `<tr><td>${s.lessonNumber || '—'}</td><td>${new Date(s.completedAt).toLocaleDateString('en-GB')}</td><td>${escapeText(s.childName)}</td><td>${Math.round(s.accuracy * 100)}%</td><td>${s.reviewCount} items</td></tr>`).join('')}</tbody></table>` : '<p>No completed lessons yet.</p>'}
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
  return 'Have a careful look and try your best.';
}
function clockSvg(value, size = 112) {
  const [hRaw, mRaw] = String(value).split(':').map(Number);
  const hour = ((hRaw % 12) + (mRaw || 0) / 60) * 30;
  const minute = (mRaw || 0) * 6;
  return `<svg width="${size}" height="${size}" viewBox="0 0 120 120" role="img" aria-label="Clock ${value}">
    <circle cx="60" cy="60" r="54" fill="#fffaf2" stroke="#536246" stroke-width="4"/>
    ${[...Array(12)].map((_, i) => { const a = (i + 1) * Math.PI / 6; const x = 60 + Math.sin(a) * 42; const y = 60 - Math.cos(a) * 42; return `<text x="${x}" y="${y + 4}" text-anchor="middle" font-size="10" fill="#536246">${i + 1}</text>`; }).join('')}
    <line x1="60" y1="60" x2="${60 + Math.sin(hour * Math.PI / 180) * 25}" y2="${60 - Math.cos(hour * Math.PI / 180) * 25}" stroke="#243029" stroke-width="6" stroke-linecap="round"/>
    <line x1="60" y1="60" x2="${60 + Math.sin(minute * Math.PI / 180) * 38}" y2="${60 - Math.cos(minute * Math.PI / 180) * 38}" stroke="#6f805f" stroke-width="4" stroke-linecap="round"/>
    <circle cx="60" cy="60" r="4" fill="#243029"/>
  </svg>`;
}
