// Dev-only tool: drives the app in headless Chromium at a phone viewport
// and screenshots key screens, so layout/text-sizing/screen-fit issues can
// be iterated on without manually opening a browser each time.
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.PREVIEW_BASE || 'http://localhost:5174';
const OUT = new URL('./screenshots/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // iPhone 12-ish
page.on('console', msg => { if (msg.type() === 'error') console.log('CONSOLE ERROR:', msg.text()); });
page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

async function shot(name) {
  await page.screenshot({ path: `${OUT}${name}.png` });
  console.log('saved', name);
}

await page.goto(BASE);
await page.waitForSelector('h1', { timeout: 10000 });
await shot('02-home');

await page.click('text=Start Lesson');
await page.waitForSelector('text=How do you want to practise?');
await shot('03-mode-select');

await page.click('[data-dismiss-intro]').catch(() => {});
await page.waitForTimeout(200);
await shot('03b-mode-select-dismissed');
await page.click('button:has-text("Learning Progression")');
await page.waitForSelector('.keypad, .choice-grid, [data-choice]', { timeout: 5000 }).catch(() => {});
await shot('04-lesson-question');

await page.goto(BASE + '#');
await page.evaluate(() => { window.location.hash = ''; });
await page.goto(BASE);
await page.waitForSelector('h1');
const learningZoneBtn = await page.$('button:has-text("Start Lesson")');
if (learningZoneBtn) await learningZoneBtn.click();
await page.waitForSelector('text=Learning Zone').catch(() => {});
await page.click('button:has-text("Learning Zone")').catch(() => {});
await page.waitForTimeout(300);
await shot('05-learning-zone');

await page.click('button:has-text("Times Tables")').catch(() => {});
await page.waitForTimeout(300);
await shot('06-times-tables-hub');

await page.click('[data-factor="7"]').catch(() => {});
await page.waitForTimeout(300);
await shot('07-times-tables-selected');

// Drive a full Skills Area session (10 short questions) to reach results/celebration.
await page.click('[data-practice-factor]');
await page.waitForSelector('.question-wrap', { timeout: 5000 });
for (let i = 0; i < 12; i++) {
  const choice = await page.$('[data-choice]');
  if (choice) { await choice.click(); }
  else {
    const keypadOne = await page.$('[data-key="1"]');
    if (keypadOne) await keypadOne.click();
    const ok = await page.$('[data-ok]');
    if (ok) await ok.click();
  }
  await page.waitForTimeout(150);
  const onResults = await page.$('text=Lesson complete');
  if (onResults) break;
}
await page.waitForTimeout(300);
await shot('08-results-or-celebration');

await page.goto(BASE);
await page.waitForSelector('h1');
await page.click('text=Parent Area');
await page.fill('#pin', '1234');
await page.click('[data-unlock]');
await page.waitForSelector('text=Parent Dashboard', { timeout: 5000 }).catch(() => {});
await shot('09-parent-dashboard');

const sessionRow = await page.$('[data-session]');
if (sessionRow) {
  await sessionRow.click();
  await page.waitForTimeout(300);
  await shot('10-session-detail');
}

await browser.close();
console.log('done');
