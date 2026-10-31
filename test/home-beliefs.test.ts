// SPDX-License-Identifier: AGPL-3.0-only
// The belief radar on the home (src/dashboard/home-beliefs.ts, outside review 2026-10-29, G491):
// per assistant, what its own memory says that the brain says is wrong now, each with one tap
// that corrects it everywhere. Owner-only; a private value names only its page.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain, saveNote } from "../src/brain";
import { loadRules } from "../src/rules";
import * as ms from "../src/memsync";
import { assistantsWrong, assistantViews } from "../src/dashboard/home-beliefs";
import { dashboardHandler, flashOf } from "../src/dashboard/server";

const OLD = { as_of: "2026-06-01", sources: ["gmail:f000000000000009"], verification: "verified-by-source" as const, by: "planner", recorded: "2026-06-01" };
const JANE = "people/jane-roy#role";
const BANK = "money/main-bank#bank";

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; });

function brain(): string {
  const root = makeBrain();
  const notes = loadBrain(root);
  const jane = notes.find((n) => n.fm.id === "people/jane-roy")!;
  jane.fm.history = { role: [{ value: "Teaching assistant", ...OLD }] };
  saveNote(root, jane);
  const bank = notes.find((n) => n.fm.id === "money/main-bank")!;
  bank.fm.history = { bank: [{ value: "Old Harbour Bank", ...OLD, by: "steward" }] };
  saveNote(root, bank);
  return root;
}
function answer(root: string, agent: string, key: string, text: string) {
  const [q] = ms.quiz(root, agent, 1, [key]);
  ms.memoryReply(root, agent, { answers: [{ id: q.id, answer: text }] });
}
const wrong = (root: string) => assistantsWrong(root, loadRules(root), loadBrain(root));

test("G491: an assistant whose memory holds an old value is listed with what it said and what the brain says", () => {
  const root = brain();
  answer(root, "helper", JANE, "She's a Teaching assistant");
  answer(root, "planner", JANE, "Course coordinator");
  const w = wrong(root);
  expect(w.map((a) => a.agent)).toEqual(["helper"]); // planner is right, steward was never asked
  expect(w[0].lines).toEqual([{ key: JANE, page: "people/jane-roy", what: "Jane Roy: role", said: "She's a Teaching assistant", now: "Course coordinator", fixing: false }]);
});

test("G491: a private fact names only its page: neither what the assistant said nor the brain's value", () => {
  const root = brain();
  answer(root, "steward", BANK, "Old Harbour Bank");
  const [s] = wrong(root);
  expect(s.agent).toBe("steward");
  const l = s.lines.find((x) => x.key === BANK)!;
  expect(l.what).toBe("Main bank: bank");
  expect(l.said).toBeUndefined();
  expect(l.now).toBeUndefined();
  expect(JSON.stringify(s)).not.toContain("Harbour");
  expect(JSON.stringify(s)).not.toContain("Maple");
});

test("G491: once the owner taps Fix everywhere the line says it is on its way, and nothing else is listed", () => {
  const root = brain();
  answer(root, "helper", JANE, "She's a Teaching assistant");
  const c = ms.state(root).corrections.find((x) => x.agent === "helper" && x.key === JANE);
  if (c) ms.approve(root, c.id);
  const w = wrong(root);
  // A correction on its way with nothing else wrong: the assistant drops off the list.
  expect(w.find((a) => a.agent === "helper")).toBeUndefined();
});

test("G491: Fix everywhere on the home asks every assistant again and the flash names no value", async () => {
  const root = brain();
  answer(root, "helper", JANE, "She's a Teaching assistant");
  const H = "127.0.0.1:8793";
  const d = dashboardHandler(root, { port: 8793, loginKey: "k".repeat(32) });
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const req = async (method: string, path: string, fields?: Record<string, string>) => {
    const body = fields ? new URLSearchParams(fields) : undefined;
    const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/home`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
    return { status: r.status, text: await r.text(), loc: r.headers.get("location") ?? "" };
  };
  const csrf = (await req("GET", "/home")).text.match(/name="csrf" value="([^"]+)"/)![1]!;
  const r = await req("POST", "/action/fix-everywhere", { csrf, key: JANE });
  expect(r.status).toBe(303);
  const flash = flashOf(r.loc).ok ?? "";
  expect(flash).toBe("Jane Roy: role. Your assistants get the right answer at their next check.");
  expect(flash).not.toContain("Course coordinator");
  // The wrong answer is on its way to being fixed for helper, and steward (never asked) is asked now.
  expect(wrong(root).find((a) => a.agent === "helper")).toBeUndefined();
  expect(ms.state(root).quizzes.some((q) => q.agent === "steward" && q.key === JANE && q.state === "open")).toBe(true);
  const bad = await req("POST", "/action/fix-everywhere", { csrf, key: "people/nobody#role" });
  expect(flashOf(bad.loc).err).toBe("That isn't wrong anywhere any more.");
});

test("G491: See as on the home: how many pages each assistant gets, as counts, with its See as link", () => {
  const root = brain();
  const notes = loadBrain(root);
  const v = assistantViews(root, loadRules(root), notes);
  expect(v.map((x) => x.agent)).toEqual(["helper", "planner", "steward"]);
  const steward = v.find((x) => x.agent === "steward")!, helper = v.find((x) => x.agent === "helper")!;
  expect(steward.sees).toBe(notes.length);
  expect(helper.sees).toBeLessThan(steward.sees);
  expect(helper.href).toBe("/map?as=helper");
  expect(JSON.stringify(v)).not.toContain("Jane");
});

test("G491: Who knows has one row per assistant: what it read today, what it gets, what it has wrong, and Fix everywhere", async () => {
  const root = brain();
  answer(root, "helper", JANE, "She's a Teaching assistant");
  answer(root, "steward", BANK, "Old Harbour Bank");
  const H = "127.0.0.1:8794";
  const d = dashboardHandler(root, { port: 8794, loginKey: "k".repeat(32) });
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const html = await (await d.handle(new Request(`http://${H}/who`, { headers: { host: H, cookie } }))).text();
  expect(html).toContain("<h2>Your assistants</h2>");
  expect(html).toMatch(/<b>helper<\/b>(<span class="badge">trial<\/span>)?<small>Hasn&#39;t read your brain today<\/small>/);
  expect(html).toContain('href="/map?as=helper"');
  expect(html).toMatch(/Sees (\d+ pages|all your pages)/);
  expect(html).toContain("helper remembers “She&#39;s a Teaching assistant” · your brain says Course coordinator");
  expect(html).toContain('action="/action/fix-everywhere"');
  expect(html).toContain(`name="key" value="${JANE}"`);
  // A private fact: the row names the page only.
  expect(html).toContain("steward has this wrong");
  expect(html).not.toContain("Harbour");
});
