---
name: verify
description: Tap through the owner's app on the demo brain at phone width in dark mode, time each tap and look at every screenshot; run before a pull request that changes what the owner sees
disable-model-invocation: true
---

Run on a checkout of the branch. It uses the demo brain (made-up data) and never a real brain. Show each command and its result line.

1. `bun scripts/verify.ts --for origin/main --out <a scratch folder>`. It says "not run" when nothing in the ui lane changed; otherwise it walks every flow of the feature map (`bun scripts/verify.ts --list`), one tap at a time, about a minute.
2. It must end `VERIFY OK`. A `✗` line is a finding: a step that didn't reach its screen, a tap over the budget (1500 ms), a page wider than the phone, an error in the page's console, or a request the hub refused. Fix it with a failing test first; never raise the budget or drop a step to get OK.
3. Look at every screenshot it names with the Read tool, one by one. `VERIFY OK` only means the taps worked; the picture is yours to judge. A finding is anything a careful owner would call odd: text cut off or overlapping, a sentence that reads wrong, a number that doesn't match the list under it, a settled thing still on the screen, a control under the box or the tab bar, low contrast.
4. If the change adds something the owner can do, add its flow to `FLOWS` in `scripts/verify.ts` (what the owner does, what must then show) in the same branch, and its row in docs/ui-quality.md.
5. Say in the pull request: the `VERIFY OK` line, and what you saw in the screenshots of the screens you changed.

This does not replace `test/ui-regression.test.ts` (what each page says) or `test/ui-quality.test.ts` (accessibility and states); it adds the taps and the eyes.
