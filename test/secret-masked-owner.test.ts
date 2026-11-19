// SPDX-License-Identifier: AGPL-3.0-only
// G991: a value saved before the write check knew its shape (a gift, promo or licence code inside a
// sentence, G961) is served to no assistant (G962), but the owner's own screens still printed the
// code whole: on the question's sides, on the home line and on the page. The owner's screens now
// say the sentence with the code's characters replaced by a mark. Display only: nothing stored
// changes, and what is asked is as before.
import { test, expect } from "bun:test";
import { writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { loadBrain, saveNote } from "../src/brain";
import { loadRules } from "../src/rules";
import { ownerConflicts } from "../src/core";
import { homeView, plain, maskSecrets } from "../src/dashboard/home";
import { settlePage } from "../src/dashboard/html-settle";
import { ownerPage } from "../src/dashboard/html-page";
import { loadState } from "../src/dashboard/data";

// Built at run time: no code-shaped string sits in the repo.
const PASS = ["QZ7M", "KK2T", "8RPWD", "7HN3", "4B9V"].join("-");
const OLD = `Hand the guest pass ${PASS} to a visitor at the desk`;
const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "owner", GIT_AUTHOR_EMAIL: "o@x", GIT_COMMITTER_NAME: "owner", GIT_COMMITTER_EMAIL: "o@x" } });

function brain() {
  const root = makeBrain();
  // Filed, questioned and weighed with a plain word in the code's place, then put on disk by hand:
  // an old brain holds such a value from before the check, and today's write path would not take it.
  const HOLD = "ticket-stub", old = OLD.replace(PASS, HOLD);
  writeFileSync(join(root, "projects", "hall-d.md"), `---\nid: projects/hall-d\ntype: project\ntitle: Hall D\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  room: { value: "${old}", as_of: 2026-10-06, sources: ["gmail:f000000000000051"], verification: verified-by-source, by: planner }\n---\n\nHall D's room note: ${old}.\n`);
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: hall d");
  const r = write(root, { agent: "planner", id: "projects/hall-d", attribute: "room", value: "D-118", as_of: "2026-10-08", sources: ["gcal:e7@e7"], verification: "self-reported" } as never, { acceptedBy: "auto-decide", contest: true });
  expect(r.outcome).toBe("disputed");
  const p = loadBrain(root).find((n) => n.fm.type === "dispute")!;
  p.fm.suggestion = { by: "gardener", at: new Date().toISOString(), choice: 1, sources: ["gmail:f000000000000051"], why: `the mail gives the pass ${HOLD} itself` };
  saveNote(root, p);
  for (const dir of ["projects", "disputes"]) for (const f of readdirSync(join(root, dir))) {
    const file = join(root, dir, f), text = readFileSync(file, "utf8");
    if (text.includes(HOLD)) writeFileSync(file, text.split(HOLD).join(PASS));
  }
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "an old brain's files");
  return root;
}

test("G991: a code inside a value reads as a mark, the words around it stay", () => {
  expect(plain(OLD)).toBe("Hand the guest pass •••• to a visitor at the desk");
  expect(maskSecrets("Room D-118 on 2026-10-08, order 4471")).toBe("Room D-118 on 2026-10-08, order 4471");
});

test("G991: the question's sides, the Gardener's line and the home line never print the code, fresh sign-in or not", () => {
  const root = brain();
  const rules = loadRules(root), c = ownerConflicts(root)[0]!;
  for (const fresh of [false, true]) {
    const html = settlePage(c, "x", rules, undefined, { fresh });
    expect(html).not.toContain(PASS);
    expect(html).toContain("D-118");
  }
  expect(settlePage(c, "x", rules, undefined, { fresh: true })).toContain("Hand the guest pass •••• to a visitor at the desk");
  expect(JSON.stringify(homeView(root, rules, loadBrain(root), new Date()))).not.toContain(PASS);
});

test("G991: the page's facts and prose never print the code, and the note on disk is untouched", () => {
  const root = brain();
  const s = loadState(root), n = s.notes.find((x) => x.fm.id === "projects/hall-d")!;
  for (const fresh of [false, true]) expect(ownerPage(s, "t", n, [], { fresh })).not.toContain(PASS);
  expect(ownerPage(s, "t", n, [], { fresh: true })).toContain("••••");
  expect(String((loadBrain(root).find((x) => x.fm.id === "projects/hall-d")!.fm.facts!.room as { value: unknown }).value)).toBe(OLD);
});
