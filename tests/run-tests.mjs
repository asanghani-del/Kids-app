import fs from 'node:fs';
const files = ['index.html', 'src/app.js', 'src/styles.css', 'sw.js', 'data/seed-content.json', 'data/misconception-rules.json'];
for (const file of files) {
  if (!fs.existsSync(new URL(`../${file}`, import.meta.url))) throw new Error(`Missing ${file}`);
}
const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
for (const needle of ['function diagnose', 'function explain', 'function generateLesson', 'serviceWorker', 'Parent Dashboard']) {
  if (!app.includes(needle)) throw new Error(`Expected app.js to contain ${needle}`);
}
JSON.parse(fs.readFileSync(new URL('../data/seed-content.json', import.meta.url), 'utf8'));
JSON.parse(fs.readFileSync(new URL('../data/misconception-rules.json', import.meta.url), 'utf8'));
console.log('All smoke tests passed.');
