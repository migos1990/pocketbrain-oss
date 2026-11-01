// SPDX-License-Identifier: AGPL-3.0-only
// Builder re-audit of the audit v9 stack (tree e7d20690, 2026-10-31): a value made private after it was written, said in words or in a page-wide answer, on the 30-day sign-in (G582) and to a reader token (G589).
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler } from "../src/dashboard/server";
import { contextPack, readNote } from "../src/core";
import { withTokenRole } from "../src/tokenrole";

const H = "127.0.0.1:8787", ID = "projects/product-discovery-course";
async function rig() {
  const { root } = await makeDemoBrain();
  let t = Date.parse(DEMO_NOW);
  const d = dashboardHandler(root, { port: 8787, loginKey: "k".repeat(32), now: () => new Date(t) });
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const req = async (m: string, p: string, f?: Record<string, string>) => (await d.handle(new Request(`http://${H}${p}`, { method: m, body: f ? new URLSearchParams(f) : undefined, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/ask`, ...(f ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }))).text();
  const csrf = (await req("GET", "/home")).match(/name="csrf" value="([^"]+)"/)![1]!;
  return { root, req, csrf, stale: () => { t += 31 * 60_000; }, f: join(root, `${ID}.md`) };
}
const priv = (f: string, attr: string, value: string) => writeFileSync(f, readFileSync(f, "utf8").replace(`  ${attr}:\n    value: ${value}\n`, `  ${attr}:\n    value: ${value}\n    sensitivity: private\n`));

test("F1: a lookup turn on a page with no prose, fact made private after: GET /ask on the 30-day sign-in", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const r = await rig();
    writeFileSync(r.f, readFileSync(r.f, "utf8").replace(/\n---\n[\s\S]*$/, "\n---\n"));
    r.stale();
    expect(await r.req("POST", "/say", { csrf: r.csrf, q: "What about Product Discovery course?", from: "ask" })).toContain("week 6 of 13"); // personal: fine
    priv(r.f, "status", "week 6 of 13");
    expect(await r.req("GET", "/ask")).not.toContain("week 6 of 13");
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("F2: a private date said as '8 Dec' in the hub's own prose: /p and Ask on the 30-day sign-in", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const r = await rig();
    priv(r.f, "due", "2026-12-08");
    expect(await r.req("GET", `/p/${ID}`)).toContain("8 Dec"); // fresh sign-in: shown
    r.stale();
    expect(await r.req("GET", `/p/${ID}`)).not.toContain("8 Dec");
    await r.req("POST", "/say", { csrf: r.csrf, q: "What about Product Discovery course?", from: "ask" });
    expect(await r.req("GET", "/ask")).not.toContain("8 Dec");
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("F3 (pre-existing, agent side): the same date reaches a reader token capped at personal", async () => {
  const { root } = await makeDemoBrain();
  priv(join(root, `${ID}.md`), "due", "2026-12-08");
  const r = (fn: () => unknown) => JSON.stringify(withTokenRole("claude", "reader", fn));
  expect(r(() => contextPack(root, "claude", "Product Discovery course"))).not.toContain("8 Dec");
  expect(r(() => readNote(root, "claude", ID))).not.toContain("8 Dec");
}, 60_000);

// The UI baseline after G589 (2026-10-31): "You were last in touch with Grace on 24 Sep" turned
// into "[withheld]" for gemini, which reads Grace's last_contact (2026-09-24) on the same page,
// because some other note's hidden fact held the same date. A date the agent is shown anyway is
// not carved, in digits or in words.
test("a date the agent is shown anyway stays readable in words, even when a hidden fact holds it too (G589)", async () => {
  const { root } = await makeDemoBrain();
  const out = JSON.stringify(readNote(root, "gemini", "people/grace-liu"));
  expect(out).toContain("2026-09-24");
  expect(out).toContain("24 Sep");
  expect(out).not.toContain("on [withheld]");
}, 60_000);

// Builder's final slice audit of the stack (tree 5ad93648), F4 and F5: the page's hidden date was
// withheld in words even where the page shows the same day as a granted fact, so a visible date's
// sentence turned "[withheld]" only when the hidden date was that day (an oracle), and the hidden
// date's ISO digits in the page's own text passed.
const KICK = `  kickoff:\n    value: 2026-12-08\n    as_of: 2026-09-27\n    sources:\n      - gmail:000000000000d02c\n    verification: self-reported\n    by: capture\n    recorded: 2026-09-27\n`;
async function kickoffPage(due: string, extra = "") {
  const { root } = await makeDemoBrain();
  const f = join(root, `${ID}.md`);
  writeFileSync(f, readFileSync(f, "utf8")
    .replace("  due:\n    value: 2026-12-08\n", `  due:\n    value: ${due}\n    sensitivity: private\n`)
    .replace("facts:\n", `facts:\n${KICK}`)
    .replace("(Written by the hub", `Kickoff for Product Discovery course: 8 Dec.${extra}\n\n(Written by the hub`));
  return (withTokenRole("claude", "reader", () => readNote(root, "claude", ID)) as { body: string }).body;
}
test("F4: a visible date's sentence reads the same whether the page's hidden date is that day or another", async () => {
  const same = (await kickoffPage("2026-12-08")).match(/Kickoff for[^\n]*/)![0];
  const other = (await kickoffPage("2026-12-09")).match(/Kickoff for[^\n]*/)![0];
  expect(same).toBe("Kickoff for Product Discovery course: 8 Dec.");
  expect(other).toBe(same);
}, 120_000);
// F5 is answered by G594: dates a person typed into the page pass in every spelling (ceiling rows in
// test/ceilings.test.ts), as the digits always did; only the writer's own sentence about the hidden
// fact is withheld, by its label, so nothing the agent writes can bring it back.
test("F5: the writer's sentence about the hidden date is withheld; a hand-typed one is a ceiling row", async () => {
  const body = await kickoffPage("2026-12-09", " Hand note: due 2026-12-09, 9 December, le 9 décembre, December 9, Dec 9.");
  expect(body).not.toContain("Due for Product Discovery course");
  expect(body.match(/Hand note:[^\n]*/)![0]).toBe("Hand note: due 2026-12-09, 9 December, le 9 décembre, December 9, Dec 9.");
}, 120_000);
