// SPDX-License-Identifier: AGPL-3.0-only
// Just this one (owner app step 2, the owner's choice of 2026-10-30: "One read, delivered next
// check-in"): on a dashed mark's sheet the owner lets that assistant read the page once. The tap is
// the approval; the page reaches the assistant at the top of its next context_pack, once, and its
// slice never changes. Rule 13: only the owner widens a read, one read at a time, never a secret page.
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler } from "../src/dashboard/server";
import { loadRules } from "../src/rules";
import { loadBrain } from "../src/brain";
import { marksFor } from "../src/dashboard/marks";
import { contextPack } from "../src/core";
import { offerOnce, openOffers, cancelAsks, listAsks } from "../src/asks";
import { readJsonl } from "../src/util";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_COPY } from "../src/dashboard/html-app";
import { withTokenRole } from "../src/tokenrole";
import { hideNoteFrom } from "../src/dashboard/edit";

const H = "127.0.0.1:8799";
async function setup() {
  const { root } = await makeDemoBrain();
  let t = Date.parse(DEMO_NOW);
  const d = dashboardHandler(root, { port: 8799, loginKey: "k".repeat(32), now: () => new Date(t) });
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const req = async (method: string, path: string, fields?: Record<string, string>, referer = `http://${H}/home`) => {
    const body = fields ? new URLSearchParams(fields) : undefined;
    const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
    return { status: r.status, text: await r.text(), loc: r.headers.get("location") ?? "" };
  };
  const csrf = async () => (await req("GET", "/home")).text.match(/name="csrf" value="([^"]+)"/)![1]!;
  return { root, req, csrf, later: (min: number) => { t += min * 60_000; } };
}
const ID = "projects/product-discovery-course";
const KEY = `${ID}#next_step`;
const LET = `/let?key=${encodeURIComponent(KEY)}&agent=gemini`;
const SHARED = /^## .+ let you read one page, once/m;

test("Just this one: the tap is the approval, the page reaches the assistant once at its next context read, its view unchanged", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root, req, csrf } = await setup();
    const sheet = await req("GET", LET);
    expect(sheet.text).toContain('action="/action/let-once"');
    expect(sheet.text).toContain(APP_COPY.justOne);
    // Nothing reaches Gemini before the tap.
    expect(contextPack(root, "gemini", "course")).not.toMatch(SHARED);
    const r = await req("POST", "/action/let-once", { csrf: await csrf(), key: KEY, agent: "gemini" }, `http://${H}${LET}`);
    expect(r.status).toBe(303);
    expect(r.loc).toStartWith("/home?ok=");
    // The sheet now says it's on its way, and offers no second one.
    const again = await req("GET", LET);
    expect(again.text).toContain(APP_COPY.onItsWay.replace("{name}", "Gemini"));
    expect(again.text).not.toContain('action="/action/let-once"');
    // The next context read carries the page first, whatever its topic; the one after doesn't.
    const first = contextPack(root, "gemini", "something else entirely");
    expect(first).toMatch(SHARED);
    expect(first).toContain("Product Discovery");
    expect(first.indexOf("let you read one page")).toBeLessThan(first.indexOf("# pocketBrain context"));
    expect(contextPack(root, "gemini", "something else entirely")).not.toMatch(SHARED);
    // One read in the read log, under the owner's offer; Gemini's view and its mark are as before.
    const reads = readJsonl<{ agent: string; op: string; ids: string[] }>(join(root, "log", "reads.jsonl")).filter((x) => x.op === "ask_read");
    expect(reads).toEqual([expect.objectContaining({ agent: "gemini", ids: [ID] })]);
    expect(marksFor(loadRules(root), loadBrain(root))(KEY).find((m) => m.agent === "gemini")!.holds).toBe(false);
    expect(openOffers(root, "gemini")).toEqual([]);
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("Just this one needs a sign-in from the last few minutes", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root, req, csrf, later } = await setup();
    const c = await csrf();
    later(11);
    const r = await req("POST", "/action/let-once", { csrf: c, key: KEY, agent: "gemini" }, `http://${H}${LET}`);
    expect(r.status).toBe(303);
    expect(r.loc).toContain("err=");
    expect(openOffers(root, "gemini")).toEqual([]);
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("never a secret page, a page the assistant already reads, the Gardener or an assistant there isn't", async () => {
  const { root } = await makeDemoBrain();
  const file = join(root, `${ID}.md`);
  expect(() => offerOnce(root, "claude", ID)).toThrow(/already/);
  expect(() => offerOnce(root, "gardener", ID)).toThrow();
  expect(() => offerOnce(root, "nobody", ID)).toThrow();
  expect(() => offerOnce(root, "gemini", "people/nobody")).toThrow();
  writeFileSync(file, readFileSync(file, "utf8").replace(/^sensitivity: \w+$/m, "sensitivity: secret"));
  expect(() => offerOnce(root, "gemini", ID)).toThrow();
  expect(listAsks(root)).toEqual([]);
}, 60_000);

test("an offer turned secret, or an assistant cut off, before its check-in delivers nothing", async () => {
  const { root } = await makeDemoBrain();
  offerOnce(root, "gemini", ID);
  cancelAsks(root, "gemini");
  expect(contextPack(root, "gemini", "course")).not.toMatch(SHARED);
  offerOnce(root, "gemini", ID);
  const file = join(root, `${ID}.md`);
  writeFileSync(file, readFileSync(file, "utf8").replace(/^sensitivity: \w+$/m, "sensitivity: secret"));
  expect(contextPack(root, "gemini", "course")).not.toMatch(SHARED);
  expect(readJsonl<{ op: string }>(join(root, "log", "reads.jsonl")).filter((x) => x.op === "ask_read")).toEqual([]);
}, 60_000);

test("a reader token's context read leaves the offer for the assistant's full token", async () => {
  const { root } = await makeDemoBrain();
  offerOnce(root, "gemini", ID);
  expect(withTokenRole("gemini", "reader", () => contextPack(root, "gemini", "course"))).not.toMatch(SHARED);
  expect(contextPack(root, "gemini", "course")).toMatch(SHARED);
}, 60_000);

test("never a page the owner kept from that assistant by name, nor a probe decoy (slice audit, 2026-10-30)", async () => {
  const { root } = await makeDemoBrain();
  const pol = join(root, "rules", "policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8").replace(/^(  gemini: \{)/m, `$1 exclude: [${ID}],`));
  expect(loadRules(root).policy.agents.gemini!.exclude).toContain(ID);
  expect(() => offerOnce(root, "gemini", ID)).toThrow();
  const file = join(root, "projects/atlas-launch.md");
  writeFileSync(file, readFileSync(file, "utf8").replace(/^area: \w+$/m, "area: probe"));
  expect(() => offerOnce(root, "chatgpt", "projects/atlas-launch")).toThrow();
  expect(listAsks(root)).toEqual([]);
}, 60_000);

test("the one read carries no share_with-limited fact and no held value", async () => {
  const { root } = await makeDemoBrain();
  const file = join(root, `${ID}.md`);
  writeFileSync(file, readFileSync(file, "utf8").replace(/^facts:\n/m, `facts:\n  room_code:\n    value: Zebulon-4471\n    as_of: 2026-10-07\n    sources:\n      - owner:2026-10-07/home\n    verification: confirmed-by-owner\n    share_with: [claude]\n  grade_appeal:\n    value: Quillfeather-appeal\n    as_of: 2026-10-07\n    sources:\n      - gmail:f000000000000009\n    verification: verified-by-source\n    unseen: true\n`));
  // Claude, which the fact is shared with, gets it; the held value reaches nobody.
  expect(contextPack(root, "claude", "Product Discovery course")).toContain("Zebulon-4471");
  offerOnce(root, "gemini", ID);
  const got = contextPack(root, "gemini", "course");
  expect(got).toMatch(SHARED);
  expect(got).not.toContain("Zebulon");
  expect(got).not.toContain("Quillfeather");
}, 60_000);

test("kept from that assistant by name, or moved into probe, before its check-in delivers nothing (slice audit, G543)", async () => {
  for (const change of ["exclude", "probe"] as const) {
    const { root } = await makeDemoBrain();
    offerOnce(root, "gemini", ID);
    if (change === "exclude") hideNoteFrom(root, ID, "gemini");
    else { const f = join(root, `${ID}.md`); writeFileSync(f, readFileSync(f, "utf8").replace(/^area: \w+$/m, "area: probe")); }
    expect(contextPack(root, "gemini", "x")).not.toMatch(SHARED);
    expect(openOffers(root, "gemini")).toEqual([]);
    expect(readJsonl<{ op: string }>(join(root, "log", "reads.jsonl")).filter((x) => x.op === "ask_read")).toEqual([]);
  }
}, 60_000);

test("an offer holds to the assistant's kind and its left-out types at the read too (builder's audit, lows)", async () => {
  // A money page: Claude gets money, ChatGPT has it left out by type.
  const { root } = await makeDemoBrain();
  const pol = join(root, "rules", "policy.yaml");
  const money = loadBrain(root).find((n) => n.fm.id.startsWith("money/") && n.fm.sensitivity !== "secret")!;
  expect(() => offerOnce(root, "chatgpt", money.fm.id)).toThrow();
  // Made the Gardener by a hand edit after the offer: nothing reaches it.
  offerOnce(root, "gemini", ID);
  writeFileSync(pol, readFileSync(pol, "utf8").replace(/^(  gemini: \{)/m, "$1 role: gardener,"));
  expect(contextPack(root, "gemini", "x")).not.toMatch(SHARED);
  expect(readJsonl<{ op: string }>(join(root, "log", "reads.jsonl")).filter((x) => x.op === "ask_read")).toEqual([]);
}, 60_000);

test("the sheet offers Just this one only where it could be read", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { req } = await setup();
    const sheet = await req("GET", `/let?key=${encodeURIComponent("money/kitchen-budget#total")}&agent=chatgpt`);
    expect(sheet.status).toBe(200);
    expect(sheet.text).not.toContain('action="/action/let-once"');
    expect(sheet.text).toContain('action="/action/note-hide"');
  } finally { delete process.env.PB_NOW; }
}, 60_000);
