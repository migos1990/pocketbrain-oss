# UI quality checks

The owner dashboard and the browser door (`/b`) are checked page by page in a real Chromium
(Playwright) on a copy of the demo brain (`examples/demo-brain`, about 500 made-up facts with a
week replayed on top, `scripts/demo-brain.ts`), never the real one and never the 7-note sample:
a screen designed against an empty brain looks dead. `test/ui-quality.test.ts` runs with
every `bun test` and fails on any of these:

- **Accessibility (WCAG 2.2 AA, the rules a test can decide):** `lang`, a title, one `<main>`, one
  `<h1>`, no skipped heading level, no duplicate ids, a label on every form field, a name on every
  link and button, `alt` on every image, and text contrast of 4.5:1 (3:1 for large text) against
  the background behind it. The checks live in `test/ui-audit.ts`, with no extra packages.
- **Keyboard:** Tab through each page; every stop is visible and shows a focus ring.
- **Light and dark:** every page in both colour schemes. The door follows the system's dark mode.
- **A lived-in day, busy and error states:** the demo brain's Thursday morning (three conflicts and
  a private value waiting, three assistants that read today with what they asked, one whose own
  memory still holds an old value with Fix everywhere, a week of diary lines), then the operator's
  states on top (a change to approve, a held message, an assistant set to read-only), and an error
  banner. The rig pins the hub's clock (`PB_NOW`) to the demo's morning, 8 Oct 2026 at 10:00 in
  Montréal, so the home's date, its diary and its reads all fall on that day.
- **Phone width:** the overview and the door's start page don't scroll sideways at 390 px, and neither does Settings with its folded sections open and long words with no break in them (a path, an address) in what is still open: a dashboard page breaks such a word rather than widen the page. What each page does for a phone is in [dashboard-phone.md](dashboard-phone.md).

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

## Verify: taps, timings and a look

The checks above read what each page says. `bun scripts/verify.ts` uses the app: it boots the demo
brain's dashboard, opens it 390 px wide in dark mode with a touch screen, and walks the feature map
below one tap at a time. Each flow starts from its own copy of the demo brain's morning.

| Flow | What the owner does | Steps |
|---|---|---|
| `home` | Open the app on what waits for you | 2 |
| `settle` | Settle a question, then take it back | 4 |
| `tell` | Tell your memory something, then undo it | 3 |
| `page` | Open a page from a line on the home | 3 |
| `memory` | Find a person in your memory | 3 |
| `ask` | Ask about someone | 2 |
| `see-as` | See your memory as one assistant does | 2 |
| `let` | Let an assistant have one thing it doesn't get | 2 |

For each step it records how long the tap took to show its result and a full-page screenshot, and
it fails (exit 1) on a step that doesn't reach its screen, a tap over 1500 ms (`--budget <ms>`;
opening a page by its address is a load, not a tap, and has no budget), a page wider than the
phone, an error in the page's console, or a request the hub answered with 400 or more.

```
bun scripts/verify.ts --list                 # the feature map with each step
bun scripts/verify.ts --out <folder>         # every flow, screenshots in <folder>
bun scripts/verify.ts --only settle,tell     # some flows
bun scripts/verify.ts --for origin/main      # only when the change touches the ui lane (scripts/lane.ts)
```

`VERIFY OK` means the taps worked, not that the screens look right: the skill `/verify`
(`.claude/skills/verify/SKILL.md`) has the thread read every screenshot before the pull request,
and an edit under `src/dashboard/` reminds the session of it (`.claude/hooks/after-edit.ts`). It
is not part of `bun test` or CI, apart from one flow that `test/verify.test.ts` runs to keep the
walk itself working. A new thing the owner can do gets a flow in `FLOWS` and a row here.

## The demo brain

`examples/demo-brain` is Robin Lefebvre's made-up life on 30 September 2026: 60 people across work,
teaching, family and friends, 12 places, 14 projects, 10 decisions and two private money pages,
each page with the owner's own notes, cited and linked. It is written from the tables in
`scripts/demo-data.ts` by `bun scripts/demo-brain.ts`; edit the tables, not the files
(`test/demo-brain.test.ts` fails when they differ). `replayWeek` then plays Fri 2 to Thu 8 Oct
through the hub's own paths: mail pulled from a Gmail fixture and filed (a fake model reads each
sentence), the owner's box, assistants' notes and reads, a memory answer that is out of date, the
Gardener's night pass and the page writer. `makeDemoBrain()` in `test/fixture.ts` replays it once
per test run and copies it for each test. To look at it on a dashboard:

```
bun scripts/demo-brain.ts --out /tmp/demo
PB_NOW=2026-10-08T14:00:00Z PB_BRAIN=/tmp/demo bun src/cli.ts dashboard
```

Nobody in it is real: every address is `example.org`, and there are no phone numbers.
