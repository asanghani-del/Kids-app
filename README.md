# Kids Maths Tutor Prototype

This is an offline-first, iPad-friendly browser prototype built from the attached Kids App handoff documentation.

## What is included

- Separate child profiles and bespoke local mastery records.
- Today's maths lesson with 10 generated questions.
- Addition, one more, number bonds to 10 and a small o'clock question.
- Keypad and multiple-choice inputs.
- Automatic marking for structured answers.
- Silent timing, hint tracking and attempt storage.
- End-of-lesson review with child answer, correct answer, explanations, voice button and simple visual support.
- Cautious misconception tags, such as "may have counted backwards".
- Adaptive next-step logic based on lesson accuracy.
- Parent PIN gate, default PIN `1234`.
- Parent dashboard showing progress, mastery, recent mistakes, lesson history and sync queue.
- Offline PWA service worker and localStorage persistence.

## Run locally

```bash
npm start
```

Then open `http://localhost:5173`.

No package installation is required because the prototype uses plain HTML, CSS and JavaScript.

## Test

```bash
npm test
```

## Notes

This prototype is intentionally local-first. The dashboard's "Sync now" button clears the local sync queue to demonstrate the planned sync flow. In a production build, replace that action with Firebase Authentication and Cloud Firestore writes using the schema and rules from the handoff bundle.
