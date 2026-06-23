const storeKey = 'kidsMathsTutor.v1';
const app = document.querySelector('#app');
const AVATAR_OPTIONS = ['🦊', '🐻', '🐼', '🦁', '🐸', '🐵', '🐰', '🐶', '🐱', '🦄'];
const YEAR_GROUP_OPTIONS = ['Reception into Year 1', 'Year 1 into Year 2', 'Year 2 into Year 3', 'Year 3 into Year 4', 'Year 4 into Year 5', 'Year 5 into Year 6'];
const defaultProfiles = [
  { id: 'child-a', name: 'Ava', avatar: '🦊', stage: 'Reception into Year 1', skillLevels: { add: 1, bonds: 1, clock: 1 }, mastery: { add_1_within_10: 0.35, bonds_to_10_missing_addend: 0.2 } },
  { id: 'child-b', name: 'Leo', avatar: '🐻', stage: 'Year 1 into Year 2', skillLevels: { add: 2, bonds: 2, clock: 1 }, mastery: { add_1_within_10: 0.55, bonds_to_10_missing_addend: 0.28 } }
];
// Skill groups level up independently (1-4) based on accuracy AND speed on
// that group, so a child who is fast+accurate at addition but still shaky
// on bonds gets harder addition while bonds stays at a supportive level.
const SKILL_GROUP_FOR_MICROSKILL = {
  add_1_within_10: 'add', add_2_3_within_10: 'add', add_within_20: 'add',
  bonds_to_10_missing_addend: 'bonds', bonds_to_20_missing_addend: 'bonds',
  identify_oclock_analogue: 'clock'
};
const FAST_MS_BY_GROUP = { add: 3500, bonds: 5500, clock: 6000 };
function skillLevelsOf(profile) { return profile.skillLevels || (profile.skillLevels = { add: 1, bonds: 1, clock: 1 }); }
// Each year group has its own ladder of sub-levels (R-1..R-5, 1-1..1-5, and
// so on), so the single number shown under a child's name tells a parent
// exactly how far through their current year group they've progressed.
const LEVELS_PER_STAGE = 5;
const STAGE_CODES = ['R', '1', '2', '3', '4', '5'];
function stageCode(stage) {
  const idx = YEAR_GROUP_OPTIONS.indexOf(stage);
  return STAGE_CODES[idx] ?? 'R';
}
// The per-skill difficulty levels (1-4, used to pick question content) are
// averaged and rescaled onto the 1-5 sub-level ladder so progress across
// addition, bonds and clocks collapses into one parent-facing number.
function overallLevel(profile) {
  const levels = skillLevelsOf(profile);
  const avg = (levels.add + levels.bonds + levels.clock) / 3;
  return Math.max(1, Math.min(LEVELS_PER_STAGE, Math.round((avg / 4) * LEVELS_PER_STAGE)));
}
function levelLabel(profile) { return `${stageCode(profile.stage)}-${overallLevel(profile)}`; }
const state = loadState();
let route = { screen: 'profiles' };
let lessonSession = null;
let seed = null;
let misconceptionRules = null;
let editingProfileId = null;

init();

async function init() {
  [seed, misconceptionRules] = await Promise.all([
    fetch('/data/seed-content.json').then(r => r.json()).catch(() => ({ questionTemplates: [] })),
    fetch('/data/misconception-rules.json').then(r => r.json()).catch(() => ({ rules: [] }))
  ]);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  window.addEventListener('online', render);
  window.addEventListener('offline', render);
  render();
}

function loadState() {
  const saved = localStorage.getItem(storeKey);
  if (saved) return JSON.parse(saved);
  return {
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
}
function saveState() { localStorage.setItem(storeKey, JSON.stringify(state)); }
function html(strings, ...values) { return strings.map((s, i) => s + (values[i] ?? '')).join(''); }
function setRoute(screen, data = {}) {
  if (screen !== 'parentDashboard') editingProfileId = null;
  route = { screen, ...data };
  render();
}
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
function bindGlobalButtons() {
  document.querySelectorAll('[data-route]').forEach(btn => btn.addEventListener('click', () => setRoute(btn.dataset.route)));
  document.querySelectorAll('[data-speak]').forEach(btn => btn.addEventListener('click', () => speak(btn.dataset.speak)));
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
  const screens = { profiles, home, lessonIntro, lesson, complete, reviewIntro, review, celebration, parentGate, parentDashboard };
  screens[route.screen]?.();
}

function profiles() {
  shell(html`
    <div class="top-row"><div>${statusPill()}</div><button class="ghost" data-route="parentGate">Parent Area</button></div>
    <h1>Who is learning?</h1>
    <p>Choose a profile. Each child has their own learning path and today's lesson.</p>
    <div class="grid profiles">
      ${state.profiles.map(p => `
        <button class="profile-card" data-profile="${p.id}">
          <div class="avatar">${p.avatar}</div>
          <h2>${escapeText(p.name)}</h2>
          <p>${escapeText(p.stage)}</p>
          <span class="badge level-badge">Level ${levelLabel(p)}</span>
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
  const recent = state.lessonSummaries.filter(l => l.childId === profile.id).slice(-4);
  shell(html`
    <div class="top-row"><button class="ghost" data-route="profiles">Change profile</button><div class="nav"><button class="ghost" data-route="parentGate">Parent Area</button>${statusPill()}</div></div>
    <h1>Hello, ${escapeText(profile.name)}</h1>
    <p><span class="badge level-badge">Level ${levelLabel(profile)}</span> &middot; ${escapeText(profile.stage)}</p>
    <p>Today's Maths is ready. We will practise one more, counting on and number bonds.</p>
    <button class="primary cta-large" data-start-lesson>Start Today's Lesson</button>
    <h3>Progress</h3>
    <div class="progress-dots" aria-label="Recent lesson progress">
      ${[0,1,2,3,4,5].map(i => `<span class="dot ${i < recent.length ? 'done' : ''}"></span>`).join('')}
    </div>
    <div class="grid stat-grid" style="margin-top:28px">
      <div class="stat-card"><strong>${Math.round((profile.mastery.add_1_within_10 || 0) * 100)}%</strong><span>Add one more</span></div>
      <div class="stat-card"><strong>${Math.round((profile.mastery.bonds_to_10_missing_addend || 0) * 100)}%</strong><span>Number bonds</span></div>
      <div class="stat-card"><strong>${state.syncQueue.length}</strong><span>Items to sync</span></div>
    </div>
  `);
  document.querySelector('[data-start-lesson]').addEventListener('click', () => setRoute('lessonIntro'));
}

function lessonIntro() {
  shell(html`
    <div class="top-row"><button class="ghost" data-route="home">Back</button><button class="secondary" data-speak="Today we will practise adding one more, counting on and number bonds.">Hear</button></div>
    <h1>Today's Lesson</h1>
    <p>We will practise:</p>
    <ul class="lesson-list">
      <li>Adding one more</li>
      <li>Counting on</li>
      <li>Number bonds to 10</li>
      <li>A tiny clock warm-up</li>
    </ul>
    <button class="primary cta-large" data-begin>Begin</button>
  `);
  document.querySelector('[data-begin]').addEventListener('click', startLesson);
}

function startLesson() {
  lessonSession = {
    id: `lesson-${Date.now()}`,
    childId: currentProfile().id,
    startedAt: new Date().toISOString(),
    index: 0,
    answers: [],
    keypad: '',
    selectedChoice: null,
    hintOpen: false,
    questionStartedAt: performance.now(),
    questions: generateLesson(currentProfile())
  };
  setRoute('lesson');
}

// Number pools widen and the addend/target grows with level, so a child who
// has levelled up sees genuinely harder sums, not just the same +1 facts
// reshuffled. Recently-asked prompts (this child's last ~20 attempts) are
// filtered out where possible so the same fact doesn't recur lesson after
// lesson.
const ADD_LEVELS = {
  1: { addends: [1], range: [1, 5] },
  2: { addends: [1], range: [1, 9] },
  3: { addends: [2, 3], range: [1, 8] },
  4: { addends: [2, 3, 4, 5], range: [10, 15] }
};
const BOND_LEVELS = {
  1: { target: 10, range: [1, 3, 8, 9] },
  2: { target: 10, range: [1, 3, 7, 9] },
  3: { target: 10, range: [2, 4, 5, 6] },
  4: { target: 20, range: [11, 13, 15, 17, 19] }
};
function recentPrompts(profile) {
  return new Set(state.attempts.filter(a => a.childId === profile.id).slice(-20).map(a => a.prompt));
}
function withoutRecentRepeats(candidates, buildPrompt, recent) {
  const fresh = candidates.filter(c => !recent.has(buildPrompt(c)));
  return fresh.length ? fresh : candidates;
}
function generateLesson(profile) {
  const levels = skillLevelsOf(profile);
  const recent = recentPrompts(profile);
  const items = [];
  const addCfg = ADD_LEVELS[Math.min(4, Math.max(1, levels.add || 1))];
  const addPairs = shuffle(addCfg.addends.flatMap(addend => {
    const [lo, hi] = addCfg.range;
    return Array.from({ length: hi - lo + 1 }, (_, i) => ({ a: lo + i, addend }));
  }));
  const freshAddPairs = withoutRecentRepeats(addPairs, p => `${p.a} + ${p.addend} = ?`, recent).slice(0, 6);
  freshAddPairs.forEach((p, idx) => {
    const correctAnswer = p.a + p.addend;
    items.push({
      id: `q-add-${idx}-${p.a}-${p.addend}`,
      type: idx % 3 === 1 ? 'choice' : 'keypad',
      skillId: 'add_one_more',
      microSkillId: addCfg.addends.length > 1 ? 'add_2_3_within_10' : (addCfg.range[1] > 9 ? 'add_within_20' : 'add_1_within_10'),
      prompt: `${p.a} + ${p.addend} = ?`,
      a: p.a,
      addend: p.addend,
      correctAnswer,
      choices: distractorChoices(correctAnswer, [p.a, correctAnswer, Math.min(correctAnswer + 1, correctAnswer + p.addend), correctAnswer - 1], 0, Math.max(20, correctAnswer + 2)),
      explanationType: 'addOne',
      visualType: 'numberLine'
    });
  });
  const bondCfg = BOND_LEVELS[Math.min(4, Math.max(1, levels.bonds || 1))];
  const freshBondValues = withoutRecentRepeats(bondCfg.range, a => `${a} + __ = ${bondCfg.target}`, recent);
  shuffle(freshBondValues).slice(0, 3).forEach((a, idx) => {
    const correctAnswer = bondCfg.target - a;
    items.push({
      id: `q-bond-${idx}-${a}-${bondCfg.target}`,
      type: idx === 1 ? 'choice' : 'keypad',
      skillId: 'number_bonds_to_10',
      microSkillId: bondCfg.target === 20 ? 'bonds_to_20_missing_addend' : 'bonds_to_10_missing_addend',
      prompt: `${a} + __ = ${bondCfg.target}`,
      a,
      target: bondCfg.target,
      correctAnswer,
      choices: distractorChoices(correctAnswer, [correctAnswer, a, bondCfg.target, Math.abs(bondCfg.target - (a + 1))], 0, bondCfg.target),
      explanationType: 'bond10',
      visualType: 'tenFrame'
    });
  });
  const clockLevel = levels.clock || 1;
  const hourPool = clockLevel === 1 ? [3, 6, 9, 12] : Array.from({ length: 12 }, (_, i) => i + 1);
  const freshHours = withoutRecentRepeats(hourPool, h => `Which clock shows ${h} o'clock?`, recent);
  const hour = shuffle(freshHours)[0];
  items.push({
    id: `q-time-${hour}-${Date.now()}`,
    type: 'choice',
    skillId: 'read_oclock',
    microSkillId: 'identify_oclock_analogue',
    prompt: `Which clock shows ${hour} o'clock?`,
    correctAnswer: `${hour}:00`,
    choices: shuffle([`${hour}:00`, `${(hour % 12) + 1}:00`, `${hour}:30`]),
    explanationType: 'oclock',
    visualType: 'clock'
  });
  return shuffle(items).slice(0, 10);
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
  const q = lessonSession.questions[lessonSession.index];
  if (!q) return finishLesson();
  const speakText = `${q.prompt.replace('__', 'blank')}`;
  shell(html`
    <div class="question-wrap">
      <div class="top-row">
        <div class="progress-dots">${lessonSession.questions.map((_, i) => `<span class="dot ${i < lessonSession.index ? 'done' : ''}"></span>`).join('')}</div>
        <button class="secondary" data-speak="${escapeText(speakText)}">Hear</button>
      </div>
      <div class="question-main">
        <div class="prompt">${escapeText(q.prompt)}</div>
        ${renderQuestionInput(q)}
        ${lessonSession.hintOpen ? `<div class="hint-box">${hintFor(q)}</div>` : ''}
      </div>
      <div class="question-actions">
        <button class="secondary" data-hint>Hint</button>
        <button class="ghost" data-route="home">Stop</button>
        <button class="primary ok-button" data-ok>OK</button>
      </div>
    </div>
  `);
  bindQuestion(q);
}

function renderQuestionInput(q) {
  if (q.type === 'choice') {
    return `<div class="choices">${q.choices.map(choice => `<button class="choice${String(choice) === String(lessonSession.selectedChoice) ? ' selected' : ''}" data-choice="${choice}">${formatChoice(q, choice)}</button>`).join('')}</div>`;
  }
  return html`
    <div class="answer-box" aria-label="Answer box">${lessonSession.keypad || '&nbsp;'}</div>
    <div class="keypad">
      ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="key" data-key="${n}">${n}</button>`).join('')}
      <button class="key" data-key="0">0</button><button class="key wide" data-delete>delete</button>
    </div>
  `;
}
function formatChoice(q, choice) {
  // Showing the digital time under the clock face would hand the child the
  // answer to "which clock shows X o'clock" without them reading the dial,
  // so the aria-label carries the time for assistive tech only.
  if (q.visualType === 'clock') return `<span aria-label="${choice}">${clockSvg(choice)}</span>`;
  return escapeText(choice);
}
function bindQuestion(q) {
  document.querySelector('[data-hint]').addEventListener('click', () => { lessonSession.hintOpen = true; render(); });
  document.querySelectorAll('[data-key]').forEach(btn => btn.addEventListener('click', () => { lessonSession.keypad = (lessonSession.keypad + btn.dataset.key).slice(0, 2); render(); }));
  document.querySelector('[data-delete]')?.addEventListener('click', () => { lessonSession.keypad = lessonSession.keypad.slice(0, -1); render(); });
  document.querySelector('[data-ok]')?.addEventListener('click', () => submitAnswer(q, q.type === 'choice' ? lessonSession.selectedChoice : lessonSession.keypad));
  document.querySelectorAll('[data-choice]').forEach(btn => btn.addEventListener('click', () => { lessonSession.selectedChoice = btn.dataset.choice; render(); }));
}
function submitAnswer(q, rawAnswer) {
  if (rawAnswer === '' || rawAnswer === null || rawAnswer === undefined) return;
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
  saveState();
  lessonSession.index += 1;
  lessonSession.keypad = '';
  lessonSession.selectedChoice = null;
  lessonSession.hintOpen = false;
  lessonSession.questionStartedAt = performance.now();
  render();
}
function diagnose(q, answer) {
  const a = q.a;
  const correctAnswer = q.correctAnswer;
  if (q.skillId === 'add_one_more') {
    const childAnswer = Number(answer);
    const addend = q.addend || 1;
    if (childAnswer === a) return { tag: 'did_not_add' };
    if (childAnswer === a - 1) return { tag: 'counted_backwards_instead_of_forwards' };
    if (childAnswer === a + addend + 1) return { tag: 'counted_on_too_far' };
    if (childAnswer === (q.target || 10) && correctAnswer !== (q.target || 10)) return { tag: 'number_bond_confusion' };
  }
  if (q.skillId === 'number_bonds_to_10' && Number(answer) === a + (q.target || 10)) return { tag: 'added_instead_of_missing' };
  if (q.skillId === 'read_oclock' && String(answer).endsWith(':30')) return { tag: 'confused_oclock_and_half_past' };
  return null;
}

function finishLesson() {
  const profile = currentProfile();
  const answers = lessonSession.answers;
  const correct = answers.filter(a => a.isCorrect).length;
  const summary = {
    id: lessonSession.id,
    childId: profile.id,
    childName: profile.name,
    startedAt: lessonSession.startedAt,
    completedAt: new Date().toISOString(),
    total: answers.length,
    correct,
    accuracy: answers.length ? correct / answers.length : 0,
    reviewCount: selectReviewItems(answers).length
  };
  updateMastery(profile, answers, summary.accuracy);
  state.lessonSummaries.push(summary);
  state.syncQueue.push({ type: 'lessonSummary', payload: summary });
  saveState();
  setRoute('complete', { lessonId: lessonSession.id });
}
function updateMastery(profile, answers, accuracy) {
  const levels = skillLevelsOf(profile);
  const bySkill = groupBy(answers, 'microSkillId');
  // Group by skill family (add/bonds/clock) too, since a level-up decision
  // needs to look across all microskills feeding that family, not just one.
  const byGroup = {};
  Object.entries(bySkill).forEach(([skill, skillAnswers]) => {
    const skillAccuracy = skillAnswers.filter(a => a.isCorrect).length / skillAnswers.length;
    const current = profile.mastery[skill] || 0;
    const delta = skillAccuracy >= 0.9 ? 0.12 : skillAccuracy >= 0.8 ? 0.06 : skillAccuracy >= 0.6 ? 0.01 : -0.04;
    profile.mastery[skill] = Math.max(0, Math.min(1, current + delta));
    const group = SKILL_GROUP_FOR_MICROSKILL[skill];
    if (group) (byGroup[group] ||= []).push(...skillAnswers);
  });
  Object.entries(byGroup).forEach(([group, groupAnswers]) => {
    const groupAccuracy = groupAnswers.filter(a => a.isCorrect).length / groupAnswers.length;
    const correctAnswers = groupAnswers.filter(a => a.isCorrect);
    const avgElapsed = correctAnswers.length ? correctAnswers.reduce((sum, a) => sum + a.elapsedMs, 0) / correctAnswers.length : Infinity;
    const fast = avgElapsed < FAST_MS_BY_GROUP[group];
    const current = levels[group] || 1;
    // A child who is both accurate AND quick has clearly mastered this level
    // with ease, so jump two levels rather than one - that's the "got it
    // right and fast, give them something harder" behaviour that was missing.
    let next = current;
    if (groupAccuracy >= 0.9 && fast) next = current + 2;
    else if (groupAccuracy >= 0.8) next = current + 1;
    else if (groupAccuracy < 0.5) next = current - 1;
    levels[group] = Math.max(1, Math.min(4, next));
  });
}
function groupBy(items, key) { return items.reduce((acc, item) => ((acc[item[key]] ||= []).push(item), acc), {}); }

function complete() {
  shell(html`
    <div class="question-main">
      <h1>Well done!</h1>
      <p>You finished today's lesson. You practised adding one more and number bonds.</p>
      <button class="primary cta-large" data-route="reviewIntro">Let's review</button>
    </div>
  `);
}
function selectReviewItems(answers) {
  return [...answers]
    .sort((a, b) => Number(a.isCorrect) - Number(b.isCorrect) || Number(b.usedHint) - Number(a.usedHint) || b.elapsedMs - a.elapsedMs)
    .filter((a, idx) => !a.isCorrect || a.usedHint || a.elapsedMs > 12000 || idx < 2)
    .slice(0, 5);
}
function reviewIntro() {
  const items = selectReviewItems(lessonSession?.answers || []);
  shell(html`
    <div class="question-main">
      <h1>Let's look at what we learned.</h1>
      <p>We will review ${items.length || 1} question${items.length === 1 ? '' : 's'} together.</p>
      <button class="primary cta-large" data-start-review>Start Review</button>
    </div>
  `);
  document.querySelector('[data-start-review]').addEventListener('click', () => setRoute('review', { reviewIndex: 0 }));
}
function review() {
  const items = selectReviewItems(lessonSession?.answers || []);
  const item = items[route.reviewIndex || 0];
  if (!item) return setRoute('celebration');
  const explanation = explain(item);
  shell(html`
    <div class="top-row"><h3>Review ${(route.reviewIndex || 0) + 1} of ${items.length}</h3><button class="secondary" data-speak="${escapeText(explanation)}">Hear</button></div>
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
        <button class="secondary" data-try>Try one like this</button>
        <button class="primary" data-next-review>${(route.reviewIndex || 0) + 1 >= items.length ? 'Finish review' : 'Next'}</button>
      </div>
    </div>
  `);
  document.querySelector('[data-next-review]').addEventListener('click', () => setRoute('review', { reviewIndex: (route.reviewIndex || 0) + 1 }));
  document.querySelector('[data-try]').addEventListener('click', () => {
    const q = similarQuestion(item.question);
    lessonSession.questions.splice(lessonSession.index, 0, q);
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
    const addend = q.addend || 1;
    return `${q.a} + ${addend} means ${addend} more than ${q.a}. Count on: ${q.a}, ${Array.from({ length: addend }, (_, i) => q.a + i + 1).join(', ')}. The answer is ${q.a + addend}.${extra}`;
  }
  if (q.explanationType === 'bond10') {
    const target = q.target || 10;
    return `A number bond to ${target} is a pair that makes ${target}. Start with ${q.a}, then count up to ${target}. ${q.a} needs ${target - q.a} more, so the answer is ${target - q.a}.`;
  }
  if (q.explanationType === 'oclock') return `For an o'clock time, the long minute hand points to 12. The short hour hand points to the hour. ${q.correctAnswer} means ${q.correctAnswer.split(':')[0]} o'clock.`;
  return `The correct answer is ${item.correctAnswer}.`;
}
function renderVisual(item) {
  const q = item.question;
  if (q.visualType === 'numberLine') {
    const lineLength = Math.max(11, q.correctAnswer + 1);
    return `<div class="visual-line"><strong>Show me</strong><div class="number-line">${Array.from({ length: lineLength }, (_, n) => `<span class="tick ${n === q.a || n === q.correctAnswer ? 'active' : ''}"><span>${n}</span><span class="mark"></span></span>`).join('')}</div><p class="small">Start at ${q.a}, then jump ${q.addend || 1} step${(q.addend || 1) === 1 ? '' : 's'} to ${q.correctAnswer}.</p></div>`;
  }
  if (q.visualType === 'tenFrame') {
    const target = q.target || 10;
    return `<div class="visual-line"><strong>Show me</strong><p>${q.a} counters are already there. Fill ${target - q.a} empty spaces to make ${target}.</p><div class="progress-dots">${Array.from({ length: target }, (_, i) => `<span class="dot ${i < q.a ? 'done' : ''}"></span>`).join('')}</div></div>`;
  }
  if (q.visualType === 'clock') return `<div class="visual-line"><strong>Show me</strong><div>${clockSvg(q.correctAnswer, 150)}</div></div>`;
  return '';
}
function similarQuestion(q) {
  if (q.explanationType === 'bond10') {
    const target = q.target || 10;
    const a = Math.max(1, Math.min(target - 1, q.a > target / 2 ? q.a - 1 : q.a + 1));
    return { ...q, id: `try-${Date.now()}`, prompt: `${a} + __ = ${target}`, a, target, correctAnswer: target - a, choices: distractorChoices(target - a, [target - a, a, target], 0, target), type: 'choice' };
  }
  const addend = q.addend || 1;
  const a = Math.max(1, Math.min(9, q.a - 1));
  return { ...q, id: `try-${Date.now()}`, prompt: `${a} + ${addend} = ?`, a, addend, correctAnswer: a + addend, choices: distractorChoices(a + addend, [a, a + addend, Math.min(20, a + addend + 1)], 0, 20), type: 'choice' };
}
function celebration() {
  const profile = currentProfile();
  const latest = state.lessonSummaries[state.lessonSummaries.length - 1];
  const next = latest?.accuracy >= 0.9 ? 'Next time: a slightly harder set of one more questions.' : latest?.accuracy >= 0.8 ? 'Next time: more practice at this level.' : 'Next time: a repair lesson with extra visual help.';
  shell(html`
    <div class="question-main">
      <h1>Great learning!</h1>
      <p>${escapeText(profile.name)}, you practised one more, counting on and number bonds.</p>
      <div class="next-box"><h3>${next}</h3><p>The parent dashboard has been updated. Lessons are saved on this device and will sync when online.</p></div>
      <button class="primary cta-large" data-route="home">Finish</button>
    </div>
  `);
}
function parentGate() {
  shell(html`
    <div class="top-row"><button class="ghost" data-route="profiles">Back</button>${statusPill()}</div>
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
function profileFormFields(prefix, values) {
  return html`
    <div class="add-child-form">
      <div class="form-field">
        <label class="small" for="${prefix}-name">Name</label>
        <input class="text-input" id="${prefix}-name" placeholder="Name" maxlength="24" value="${escapeText(values.name || '')}">
      </div>
      <div class="form-field">
        <label class="small">Avatar</label>
        <div class="avatar-picker" id="${prefix}-avatar-picker">
          ${AVATAR_OPTIONS.map(a => `<button type="button" class="avatar-option${a === values.avatar ? ' selected' : ''}" data-avatar="${a}">${a}</button>`).join('')}
        </div>
      </div>
      <div class="form-field">
        <label class="small" for="${prefix}-stage">Year group</label>
        <select class="text-input" id="${prefix}-stage">
          ${YEAR_GROUP_OPTIONS.map(s => `<option value="${s}" ${s === values.stage ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
    </div>
  `;
}
function editProfileCard(p) {
  return `
    <div class="stat-card">
      <strong class="small">Edit profile</strong>
      ${profileFormFields(`edit-${p.id}`, p)}
      <div class="nav" style="margin-top:10px">
        <button class="ghost" data-cancel-edit>Cancel</button>
        <button class="primary" data-save-profile="${p.id}">Save</button>
      </div>
    </div>`;
}
function parentDashboard() {
  const summaries = [...state.lessonSummaries].reverse();
  const mistakes = [...state.attempts].filter(a => !a.isCorrect || a.usedHint).slice(-12).reverse();
  shell(html`
    <div class="top-row"><div><h1>Parent Dashboard</h1><p>Progress, recent mistakes, mastery and offline sync status.</p></div><div class="nav"><button class="ghost" data-route="profiles">Child mode</button><button class="secondary" data-refresh>Refresh content</button><button class="primary" data-sync>Sync now</button></div></div>
    <div class="grid dashboard">
      <div class="dashboard-card">
        <h2>Children</h2>
        <div class="grid stat-grid">
          ${state.profiles.map(p => p.id === editingProfileId ? editProfileCard(p) : `
            <div class="stat-card">
              <strong>${p.avatar} ${escapeText(p.name)}</strong><span>${escapeText(p.stage)}</span>
              <p><span class="badge level-badge">Level ${levelLabel(p)}</span></p>
              <p class="small">Add one: ${Math.round((p.mastery.add_1_within_10 || 0) * 100)}%, Bonds: ${Math.round((p.mastery.bonds_to_10_missing_addend || 0) * 100)}%</p>
              <div class="nav">
                <button class="secondary" data-edit-profile="${p.id}">Edit</button>
                <button class="danger" data-remove-profile="${p.id}" ${state.profiles.length <= 1 ? 'disabled' : ''}>Remove</button>
              </div>
            </div>`).join('')}
        </div>
        <h3 style="margin-top:22px">Add a child</h3>
        ${profileFormFields('new-child', { avatar: AVATAR_OPTIONS[0], stage: YEAR_GROUP_OPTIONS[0] })}
        <button class="primary" data-add-profile style="margin-top:14px">Add child</button>
        <p class="small" id="add-child-error"></p>
      </div>
      <div class="dashboard-card">
        <h2>Offline and sync</h2>
        <p>${statusPill()} <span class="badge">Content v${state.contentVersion}</span></p>
        <p>${state.syncQueue.length} item${state.syncQueue.length === 1 ? '' : 's'} waiting to sync.</p>
      </div>
      <div class="dashboard-card">
        <h2>Lesson history</h2>
        ${summaries.length ? `<table class="table"><thead><tr><th>Date</th><th>Child</th><th>Accuracy</th><th>Review</th></tr></thead><tbody>${summaries.map(s => `<tr><td>${new Date(s.completedAt).toLocaleDateString('en-GB')}</td><td>${escapeText(s.childName)}</td><td>${Math.round(s.accuracy * 100)}%</td><td>${s.reviewCount} items</td></tr>`).join('')}</tbody></table>` : '<p>No completed lessons yet.</p>'}
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
    render();
  }));
  document.querySelectorAll('.avatar-option').forEach(btn => btn.addEventListener('click', () => {
    btn.closest('.avatar-picker').querySelectorAll('.avatar-option').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
  }));
  document.querySelector('[data-add-profile]').addEventListener('click', () => {
    const name = document.querySelector('#new-child-name').value.trim();
    const avatar = document.querySelector('#new-child-avatar-picker .avatar-option.selected')?.dataset.avatar || AVATAR_OPTIONS[0];
    const stage = document.querySelector('#new-child-stage').value;
    const errorEl = document.querySelector('#add-child-error');
    if (!name) { errorEl.textContent = 'Please enter a name.'; return; }
    state.profiles.push({
      id: `child-${Date.now()}`,
      name,
      avatar,
      stage,
      skillLevels: { add: 1, bonds: 1, clock: 1 },
      mastery: {}
    });
    saveState();
    render();
  });
  document.querySelectorAll('[data-edit-profile]').forEach(btn => btn.addEventListener('click', () => {
    editingProfileId = btn.dataset.editProfile;
    render();
  }));
  document.querySelectorAll('[data-cancel-edit]').forEach(btn => btn.addEventListener('click', () => {
    editingProfileId = null;
    render();
  }));
  document.querySelectorAll('[data-save-profile]').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.dataset.saveProfile;
    const profile = state.profiles.find(p => p.id === id);
    const prefix = `edit-${id}`;
    const name = document.querySelector(`#${prefix}-name`).value.trim();
    if (!name) return;
    profile.name = name;
    profile.avatar = document.querySelector(`#${prefix}-avatar-picker .avatar-option.selected`)?.dataset.avatar || profile.avatar;
    profile.stage = document.querySelector(`#${prefix}-stage`).value;
    editingProfileId = null;
    saveState();
    render();
  }));
}
function labelMistake(tag, usedHint) {
  if (tag === 'did_not_add') return 'May not have added one';
  if (tag === 'counted_backwards_instead_of_forwards') return 'May have counted backwards';
  if (tag === 'counted_on_too_far') return 'May have counted too far';
  if (tag === 'number_bond_confusion') return 'May be thinking about making 10';
  if (tag === 'confused_oclock_and_half_past') return 'May confuse o’clock and half past';
  if (usedHint) return 'Used hint';
  return 'Needs review';
}
function hintFor(q) {
  if (q.explanationType === 'addOne') return `Start at ${q.a}, then count on ${q.addend || 1} step${(q.addend || 1) === 1 ? '' : 's'}.`;
  if (q.explanationType === 'bond10') return `Think: how many more does ${q.a} need to reach ${q.target || 10}?`;
  if (q.explanationType === 'oclock') return `For o'clock, the long hand points to 12.`;
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
