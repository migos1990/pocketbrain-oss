// SPDX-License-Identifier: AGPL-3.0-only
// The teaching question (G711) on the owner's home (G715): "You seem to teach PROD 20410 at North
// College. Right?" is one card with the owner's three taps, it counts once in the home's number and
// the north star's asks, and a tap answers it there (answerTeach). A school or course page made
// private since the question was filed is never named on the card (invariant 16).
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { git } from "../src/git";
import { loadBrain } from "../src/brain";
import { ownerAsks } from "../src/waiting";
import { waitingCount } from "../src/dashboard/home";
import { APP_COPY } from "../src/dashboard/html-app";
import { HOME_COPY } from "../src/dashboard/html-home";
import { dashboardHandler } from "../src/dashboard/server";
import { raiseTeachAsks, teachAsks } from "../src/teaching";

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; });

const fact = (value: string, mail: string) => `{ value: "${value}", as_of: 2026-10-05, sources: ["gmail:${mail}"], verification: verified-by-source, by: planner, recorded: 2026-10-05 }`;
const head = (id: string, type: string, title: string, sensitivity = "personal") => `---\nid: ${id}\ntype: ${type}\ntitle: "${title}"\narea: work\nsensitivity: ${sensitivity}\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n`;
const M1 = "f0000000000000d1", M2 = "f0000000000000d2";
const Q = "You seem to teach PROD 20410 at North College. Right?";

function brain() {
  const root = makeBrain();
  const policy = join(root, "rules", "policy.yaml");
  writeFileSync(policy, readFileSync(policy, "utf8").replace("owner: { name: Robin }", "owner: { name: Robin Vale }"));
  git(root, ["add", "rules/policy.yaml"]); git(root, ["commit", "-q", "-m", "owner: full name"], "owner");
  mkdirSync(join(root, "orgs"), { recursive: true });
  writeFileSync(join(root, "orgs", "north-college.md"), `${head("orgs/north-college", "org", "North College")}---\n`);
  writeFileSync(join(root, "orgs", "harbour-soft.md"), `${head("orgs/harbour-soft", "org", "Harbour Soft")}---\n`);
  writeFileSync(join(root, "people", "robin-vale.md"), `${head("people/robin-vale", "person", "Robin Vale")}facts:\n  org: ${fact("[[orgs/harbour-soft]]", "f0000000000000d0")}\n---\n`);
  writeFileSync(join(root, "projects", "prod-20410-intra.md"), `${head("projects/prod-20410-intra", "project", "PROD 20410: intra exam due by Oct 9")}facts:\n  next_step: ${fact("grade the intra by 2026-10-09", M1)}\n---\n`);
  writeFileSync(join(root, "projects", "prod-20410-session.md"), `${head("projects/prod-20410-session", "project", "PROD 20410: Oct 6 session moved")}facts:\n  next_step: ${fact("teach on Sunday 2026-10-11", M2)}\n---\n`);
  ["Ana Diaz", "Ben Roy", "Cara Lee"].forEach((name, i) => {
    const id = `people/${name.toLowerCase().replace(" ", "-")}`;
    writeFileSync(join(root, `${id}.md`), `${head(id, "person", name)}facts:\n  org: ${fact("[[orgs/north-college]]", i % 2 ? M2 : M1)}\n---\n`);
  });
  git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", "planner: the course mails"], "planner");
  expect(raiseTeachAsks(root).map((f) => f.code)).toEqual(["PROD 20410"]);
  return root;
}

const H = "127.0.0.1:8797";
async function signedIn(root: string) {
  const d = dashboardHandler(root, { port: 8797, loginKey: "k".repeat(32) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
  return async (method: string, path: string, fields?: Record<string, string>) => {
    const body = fields ? new URLSearchParams(fields) : undefined;
    const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/home`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
    return { status: r.status, text: await r.text(), loc: r.headers.get("location") ?? "" };
  };
}
const csrfOf = (html: string) => html.match(/name="csrf" value="([^"]+)"/)![1]!;
const askOf = (html: string) => html.match(/name="ask" value="([0-9a-f]{16})"/)![1]!;

test("G715 the teaching question is one card on the home with the owner's three taps, counted once", async () => {
  const root = brain();
  const asks = ownerAsks(root);
  expect(asks.by.teach).toBe(1);
  expect(asks.settings).toBe(0);
  expect(waitingCount(root)).toBe(asks.total);
  const home = (await (await signedIn(root))("GET", "/home")).text;
  expect(home.split(`<span class="what">${Q}</span>`).length - 1).toBe(1);
  expect(home).toContain(`${APP_COPY.answerHead} <b>1</b>`);
  for (const b of ["Yes, I teach it", "I&#39;m taking it", "No"]) expect(home).toContain(`>${b}</button>`);
  expect(home).not.toContain(APP_COPY.settingsHead);
});

test("G715 Yes, I teach it answers from the home: the course is filed and nothing waits", async () => {
  const root = brain();
  const req = await signedIn(root);
  const page = (await req("GET", "/home")).text, csrf = csrfOf(page), ask = askOf(page);
  const r = await req("POST", "/action/teach-answer", { csrf, ask, answer: "teaches" });
  expect(r.loc).toStartWith("/home?ok=");
  expect(teachAsks(root)[0]!.status).toBe("teaches");
  const me = loadBrain(root).find((n) => n.fm.id === "people/robin-vale")!;
  expect(JSON.stringify(me.fm.facts!.teaches)).toContain("projects/prod-20410");
  expect(ownerAsks(root).by.teach).toBeUndefined();
  const after = (await req("GET", r.loc)).text;
  expect(after).toContain("You teach PROD 20410 at North College.");
  expect(after).not.toContain(Q);
  // Asked once, answered once.
  expect((await req("POST", "/action/teach-answer", { csrf, ask, answer: "no" })).loc).toContain("err=");
});

test("G715 No answers it and files nothing; a made-up answer is refused", async () => {
  const root = brain();
  const req = await signedIn(root);
  const page = (await req("GET", "/home")).text, csrf = csrfOf(page), ask = askOf(page);
  expect((await req("POST", "/action/teach-answer", { csrf, ask, answer: "maybe" })).loc).toContain("err=");
  expect((await req("POST", "/action/teach-answer", { csrf, ask: "0".repeat(16), answer: "no" })).loc).toContain("err=");
  expect(teachAsks(root)[0]!.status).toBe("waiting");
  const r = await req("POST", "/action/teach-answer", { csrf, ask, answer: "no" });
  expect(r.loc).toStartWith("/home?ok=");
  expect(teachAsks(root)[0]!.status).toBe("no");
  expect(loadBrain(root).some((n) => n.fm.id === "projects/prod-20410")).toBe(false);
  expect(ownerAsks(root).total).toBe(0);
});

test("G715 a school page made private since never shows its name on the card, which still asks", async () => {
  const root = brain();
  const p = join(root, "orgs", "north-college.md");
  writeFileSync(p, readFileSync(p, "utf8").replace("sensitivity: personal", "sensitivity: private"));
  git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", "owner: private"], "owner");
  const home = (await (await signedIn(root))("GET", "/home")).text;
  expect(home).not.toContain("North College");
  expect(home).not.toContain("PROD 20410");
  expect(home).toContain(HOME_COPY.teachUnnamed);
  expect(home).toContain(">Yes, I teach it</button>");
  expect(ownerAsks(root).by.teach).toBe(1);
});
