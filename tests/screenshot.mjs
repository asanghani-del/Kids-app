// Dev-only tool: drives the app in headless Chromium at an iPad-sized
// viewport (this app's primary device target) and screenshots key screens,
// so layout/text-sizing/screen-fit issues can be iterated on without
// manually opening a browser each time.
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.PREVIEW_BASE || 'http://localhost:5174';
const OUT = new URL('./screenshots/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 810, height: 1080 } }); // iPad portrait
page.on('console', msg => { if (msg.type() === 'error') console.log('CONSOLE ERROR:', msg.text()); });
page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

async function shot(name) {
  await page.screenshot({ path: `${OUT}${name}.png` });
  console.log('saved', name);
}

await page.goto(BASE);
await page.waitForSelector('h1', { timeout: 10000 });
await shot('01-home-mode-select');

await page.click('[data-dismiss-intro]').catch(() => {});
await page.waitForTimeout(200);
await shot('02-home-dismissed');

await page.click('button:has-text("Learning Progression")');
await page.waitForSelector('.stepping-path');
await shot('03-stepping-stones');

await page.click('[data-start-progression]');
await page.waitForSelector('.question-wrap');
await shot('04-lesson-question');

await page.goto(BASE);
await page.click('button:has-text("Learning Zone")');
await page.waitForTimeout(200);
await shot('05-learning-zone');

await page.click('button:has-text("Times Tables")');
await page.waitForTimeout(200);
await shot('06-times-tables-hub');

await page.click('[data-toggle-grid]');
await page.waitForTimeout(200);
await shot('07-times-tables-12x12-grid');

await page.click('[data-toggle-quiz]');
await page.waitForTimeout(200);
await shot('07b-times-tables-quiz-mode');
await page.click('.grid-hidden[data-answer]');
await page.waitForTimeout(200);
await shot('07c-times-tables-quiz-revealed');

await page.click('[data-factor="9"]');
await page.waitForTimeout(200);
await shot('08-times-tables-selected');

await page.goto(BASE);
await page.click('button:has-text("Skills Area")');
await page.waitForTimeout(200);
await shot('09-skills-area');

await page.goto(BASE);
await page.click('button:has-text("Speed Test")');
await page.waitForTimeout(200);
await shot('10-speed-test-setup');

// Parent area + admin login
await page.goto(BASE);
await page.click('text=Parent Area');
await page.waitForSelector('#pin');
await shot('11-parent-gate');
await page.click('text=Admin test mode');
await page.waitForSelector('#admin-username');
await shot('12-admin-login');
await page.fill('#admin-username', 'admin');
await page.fill('#admin-password', '1234');
await page.click('[data-admin-login]');
await page.waitForSelector('text=Admin test mode', { timeout: 5000 }).catch(() => {});
await page.click('[data-dismiss-intro]').catch(() => {});
await page.waitForTimeout(200);
await shot('13-home-admin-mode');

await page.click('[data-exit-admin]');
await page.waitForTimeout(200);
await page.click('text=Parent Area');
await page.fill('#pin', '1234');
await page.click('[data-unlock]');
await page.waitForSelector('text=Parent Dashboard', { timeout: 5000 }).catch(() => {});
await shot('14-parent-dashboard');

await browser.close();
console.log('done');
