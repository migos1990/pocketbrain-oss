# UI quality checks

The owner dashboard and the browser door (`/b`) are checked page by page in a real Chromium
(Playwright) on a seeded throwaway brain, never the real one. `test/ui-quality.test.ts` runs with
every `bun test` and fails on any of these:

- **Accessibility (WCAG 2.2 AA, the rules a test can decide):** `lang`, a title, one `<main>`, one
  `<h1>`, no skipped heading level, no duplicate ids, a label on every form field, a name on every
  link and button, `alt` on every image, and text contrast of 4.5:1 (3:1 for large text) against
  the background behind it. The checks live in `test/ui-audit.ts`, with no extra packages.
- **Keyboard:** Tab through each page; every stop is visible and shows a focus ring.
- **Light and dark:** every page in both colour schemes. The door follows the system's dark mode.
- **Empty, busy and error states:** each list empty, then with items in it (a change to approve,
  a held message, an assistant set to read-only, reads in the log), and an error banner.
- **Phone width:** the overview and the door's start page don't scroll sideways at 390 px.

Pages are listed in `test/ui-rig.ts`: add a page there when you add one to the dashboard or the door.

## Screenshot baselines

```
PB_UI_SHOTS=1 bun test test/ui-quality.test.ts                       # compare with the baselines
PB_UI_SHOTS=1 UPDATE_SCREENSHOTS=1 bun test test/ui-quality.test.ts  # rewrite them after a deliberate change
```

Baselines are JPEGs in `test/screenshots/<platform>/<page>-<light|dark>.jpg`, one set per
operating system, because fonts render differently on each. A page fails when more than 0.2% of
its pixels move (or its size changes); the new image is written next to the baseline as
`.actual.jpg` (ignored by git) so you can look at both. Times that come from git commits are
masked; everything else runs on a fixed clock. A missing baseline is written on the first run,
except under `CI`, where it fails and asks for the baseline to be committed.

Comparison runs inside Chromium: both images are drawn on a canvas and the pixels counted there.
