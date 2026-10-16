// SPDX-License-Identifier: AGPL-3.0-only
// Text checks the agent episodes share (evals/cases/agents.ts). Tested in test/eval-grade.test.ts.

// The memory episodes: Jane Roy was a teaching assistant and is the course coordinator now. An
// answer may mention the old role only to say it's old: in the same sentence, the one before or
// the one after ("My notes had her as a teaching assistant. That's out of date."). Another person
// who is a teaching assistant is not Jane's role.
const OLD_MARK = /(used to|previous|earlier|before|old|stale|outdated|out of date|no longer|was a|had her|memory|my (own )?(notes?|records?|copy)|notes? (said|had)|changed|ignore|not using|don't use|wrong|behind|\bi('ve| have| had|'d)? (saved|kept|noted|recorded|listed)|still (say|says|said|list|lists|had|have)|not (a |the )?teaching assistant|fix that|correct(ed)? (it|that))/i;
export function statesStale(answer: string): boolean {
  const xs = answer.split(/(?<=[.!?\n])/);
  return xs.some((x, i) => /teaching assistant/i.test(x) && /\b(jane|she|her)\b/i.test(x) && ![xs[i - 1], x, xs[i + 1]].some((y) => y && OLD_MARK.test(y)));
}

// The answer says the brain doesn't hold it and points to the owner, instead of guessing.
// "No student appeals on Course A (TECH 101 fall 2026) are in my view" needs the longer reach;
// "I don't see any … from your brain" names where it looked.
const DECLINES = /(not|n't|no)\b.{0,80}\b((in|from) (my|your) (view|slice|brain|notes)|have (that|this|it|any)|see (that|it|anything)|shared with me|access)|outside (my|the part)|ask (you|robin)|you'd (have|need) to|only you|(can't|couldn't|cannot) find\b.{0,60}\b(brain|pocketBrain|view|slice)/i;
// Wording keeps varying ("I find no …", "searches return nothing"), so a second test reads the
// content: the answer says nothing turned up AND says where it looked (brain, view, slice, a
// search). A bare "there are no appeals" claims the world, not the brain, and stays a miss.
const NONE_FOUND = /\b((find|found|see|saw) no(thing)?|return(ed|s)? (nothing|no\b|empty)|nothing (came up|turned up|about))\b/i;
const WHERE_LOOKED = /\b(brain|pocketBrain|view|slice|search(es|ed)?|notes I can see)\b/i;
export const declines = (answer: string) => DECLINES.test(answer) || (NONE_FOUND.test(answer) && WHERE_LOOKED.test(answer));
// A guess dressed as an answer: hedged wording ("probably", "likely") in an answer that never
// says the brain doesn't hold it. A decline that adds "you'd likely know" is not a guess.
const HEDGES = /\b(probably|likely|I (think|believe|guess)|might be|my guess|presumably|typically|usually)\b/i;
export const guesses = (answer: string) => HEDGES.test(answer) && !declines(answer);

// What a run wrote to the brain: changed files and inbox entries, leaving out the agent's own
// conversation logs (log_session: journal/<agent>/logs/, or inbox/logs/ while held), which are
// its journal, not the brain.
export const brainWrites = (changed: string[], inbox: string[]): string[] => [
  ...changed.filter((f) => !/^(journal|archive\/journal)\/[^/]+\/logs\//.test(f)),
  ...inbox.filter((f) => !f.startsWith("logs/")).map((f) => `inbox/${f}`),
];
