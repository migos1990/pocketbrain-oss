// SPDX-License-Identifier: AGPL-3.0-only
// Every timed wait in test/, by file, with what it is for (G983). A test that pauses a fixed time
// and hopes the machine got there passes on a fast runner and fails on a slow one, and a failing
// run then gets rerun instead of fixed. test/fixed-waits.test.ts counts the waits in each file and
// fails when a file has more or fewer than this list says, so a new wait is a line here with its
// reason, and a removed one takes its line away.
//   poll       a short pause inside a loop that checks for the thing, with an end; fine
//   clock      waits for an edge of a clock the code under test reads (git's second, the minute); fine, slow
//   simulated  the wait is what is being tested (a slow model, a timeout race); fine
//   text       the word in a string or a comment, no wait
//   settle     a fixed pause that hopes something has started or finished. The class to remove:
//              wait on a signal instead (a file, a line of output, a promise). Its total may only go down.
export type WaitKind = "poll" | "clock" | "simulated" | "text" | "settle";
export interface Wait { n: number; kind: WaitKind; why: string }

export const WAITS: Record<string, Wait[]> = {
  "test/add.test.ts": [{ n: 1, kind: "clock", why: "5 ms so the approval window opens at a later millisecond than the sign-in that came before it" }],
  "test/aftercheck.test.ts": [{ n: 1, kind: "settle", why: "50 ms for the background after-check to drain; should await the drain" }],
  "test/brain-copy-race.test.ts": [{ n: 2, kind: "settle", why: "200 ms for the child that takes and drops git locks to get going; should wait for its first lock file" }],
  "test/cli-token-audit4.test.ts": [{ n: 1, kind: "poll", why: "5 ms steps until all twelve children say they are ready, then one go file releases them" }],
  "test/contracts/oauth.contract.test.ts": [{ n: 1, kind: "clock", why: "5 ms so the approval window opens at a later millisecond than the client that was waiting" }],
  "test/dashboard-poll.test.ts": [{ n: 1, kind: "clock", why: "the cap is per wall-clock minute: past second 50 it waits for the next minute so 20 loads can't straddle two" }],
  "test/fga.test.ts": [{ n: 1, kind: "clock", why: "5 ms so a copy with max_age_s 0 is older than now" }],
  "test/gardener.test.ts": [{ n: 1, kind: "clock", why: "git dates are to the second" }],
  "test/handoff.test.ts": [{ n: 1, kind: "simulated", why: "a model that takes 1.5 s, to show the write is not held behind it" }],
  "test/job-budget.test.ts": [{ n: 1, kind: "text", why: "the word inside a string the job counter reads" }],
  "test/probe.test.ts": [{ n: 1, kind: "simulated", why: "80 ms past a job's 30 ms timeout, to see it recorded as timed out while it still runs" }],
  "test/pull-timeout.test.ts": [{ n: 4, kind: "simulated", why: "a race against a timer: the call under test must answer before it, or is shown still waiting" }],
  "test/request-ids.test.ts": [{ n: 1, kind: "poll", why: "50 ms steps, at most 100, until the queue file has both lines" }],
  "test/restart-recovery.test.ts": [{ n: 3, kind: "settle", why: "300 and 100 ms for a pull or a capture to reach its hung model call; should wait for the interim record" }],
  "test/semantic.test.ts": [
    { n: 3, kind: "settle", why: "5 ms for a query to reach the gated embedder; should wait until the embedder has seen it" },
    { n: 1, kind: "simulated", why: "20 ms so a caller that waits 1 ms has given up" },
  ],
  "test/start.test.ts": [{ n: 1, kind: "poll", why: "100 ms steps, at most 50, until the hub's /health answers" }],
  "test/whats-new.test.ts": [{ n: 3, kind: "clock", why: "git dates are to the second" }],
};

// One count per file: each Bun.sleep( or setTimeout( written in it, the busy loop `while (Date.now() <`,
// and each call of a one-line helper the file defines around one of them (`const pause = (ms) => ...`).
export function countWaits(text: string): number {
  const lines = text.split("\n");
  const DIRECT = /\bBun\.sleep\(|\bsetTimeout\(|while \(Date\.now\(\) </g;
  const helpers: { name: string; line: number }[] = [];
  lines.forEach((l, i) => { const m = l.match(/^\s*(?:export )?const (\w+) = (?:async )?(?:<[^>]*>)?\([^)]*\)(?:: [^=]+)? => .*(?:\bBun\.sleep\(|\bsetTimeout\()/); if (m) helpers.push({ name: m[1], line: i }); });
  let n = 0;
  lines.forEach((l, i) => {
    if (helpers.some((h) => h.line === i)) return;
    n += (l.match(DIRECT) ?? []).length;
    for (const h of helpers) n += (l.match(new RegExp(`(?<![.\\w])${h.name}\\(`, "g")) ?? []).length;
  });
  return n;
}
