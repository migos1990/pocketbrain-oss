// SPDX-License-Identifier: AGPL-3.0-only
// Audit v5 (2026-10-27): the box said "Noted" whatever write() did, so a sentence that opened a
// conflict read as saved; and a chip was a dead end or counted as typed words.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { ownerSay } from "../src/owner-say";

test("what differs from the page's value says so, never 'Noted'", async () => {
  const { write } = await import("../src/write");
  const root = makeBrain();
  // A source dated after what the owner now says it was: the two disagree, and the home asks.
  expect(write(root, { agent: "planner", id: "people/jane-roy", attribute: "role", value: "Dean", as_of: "2026-10-08", sources: ["gmail:f000000000000011"], verification: "verified-by-source" } as never).outcome).toBe("committed");
  const r = ownerSay(root, "Jane Roy's role is chair last week");
  expect(r.kind).toBe("say.disputed");
  expect(r.text).not.toMatch(/^Noted/);
  expect(r.text).toContain("Dean");
  expect(r.text).toContain("Waiting on you");
});

// G461: the owner's own earlier word is an earlier value, never a conflict with their newer one;
// the box says so, never a bare "Noted" that reads as if the value changed.
test("the owner's earlier word is noted as earlier, and the newer one stays", () => {
  const root = makeBrain();
  expect(ownerSay(root, "Jane Roy's role is dean").kind).toBe("say.noted");
  const r = ownerSay(root, "Jane Roy's role is chair last week");
  expect(r.kind).toBe("say.earlier");
  expect(r.text).toBe("Noted as earlier: Jane Roy's role was chair. It's dean now; the earlier one is under Earlier values.");
});

test("a near name's chip resends the sentence with the right name, and it lands", () => {
  const root = makeBrain();
  const near = ownerSay(root, "Jane Ray's role is program director");
  expect(near.kind).toBe("say.near-name");
  const chip = near.chips!.find((c) => c.label === "Jane Roy")!;
  expect(chip.say).toBe("Jane Roy's role is program director");
  expect(ownerSay(root, chip.say, { chip: true }).kind).toBe("say.noted");
});

test("a chip tap is recorded as a tap on the owner's own sentence, not as typed words", async () => {
  const { loadBrain } = await import("../src/brain");
  const root = makeBrain();
  const ask = ownerSay(root, "Jane Roy is tired today");
  expect(ask.kind).toBe("say.confirm-role");
  expect(ownerSay(root, ask.chips![0]!.say, { chip: true }).kind).toBe("say.noted");
  const role = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts!.role as { sources: string[] };
  expect(role.sources.some((s) => /^owner:\d{4}-\d{2}-\d{2}\/home\/chip$/.test(s))).toBe(true);
});

// Coordinator, 2026-10-27: a chip stays the owner's word only because it resends the owner's own
// sentence. A chip never brings a word the owner didn't type (the near-name chip swaps the name for
// the page's, nothing else), and the server counts as a tap only a chip it offered this sign-in.
test("every chip is made of the owner's own words, a page's name and the box's few fixed words", async () => {
  const { loadBrain } = await import("../src/brain");
  const root = makeBrain();
  const titles = loadBrain(root).map((n) => String(n.fm.title));
  const FIXED = new Set(["new", "page", "in", "s", "role", "is", "yes", "forget", ...Object.keys((await import("../src/rules")).loadRules(root).policy.areas)]);
  const words = (t: string) => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const typed of ["Zed Quorum is a ski instructor", "Jane Ray's role is program director", "Jane Roy is tired today", "forget Paul Advisr", "Zed Quorum works at Bay Institute"]) {
    const r = ownerSay(root, typed);
    for (const c of r.chips ?? []) {
      const allowed = new Set([...words(typed), ...titles.flatMap(words), ...FIXED]);
      expect(words(c.say).filter((w) => !allowed.has(w)), `${typed} -> ${c.say}`).toEqual([]);
    }
  }
});

test("a chip the box never offered is read as typed words", async () => {
  const { dashboardHandler } = await import("../src/dashboard/server");
  const { loadBrain } = await import("../src/brain");
  const root = makeBrain();
  const H = "127.0.0.1:8791";
  const d = dashboardHandler(root, { port: 8791, loginKey: "k".repeat(32) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
  const home = await (await d.handle(new Request(`http://${H}/home`, { headers: { host: H, cookie } }))).text();
  const csrf = home.match(/name="csrf" value="([^"]+)"/)![1]!;
  const say = (q: string, chip: boolean) => d.handle(new Request(`http://${H}/say`, { method: "POST", body: new URLSearchParams({ csrf, q, ...(chip ? { chip: "1" } : {}) }), headers: { host: H, cookie, origin: `http://${H}`, "content-type": "application/x-www-form-urlencoded" } }));
  const refs = (attr: string) => (loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts![attr] as { sources: string[] }).sources;
  await say("Jane Roy's nickname is JR", true);
  expect(refs("nickname").some((s) => s.endsWith("/chip"))).toBe(false);
  const ask = await (await say("Jane Roy is tired today", false)).text();
  const chipSay = ask.match(/name="q" value="([^"]+)"><input type="hidden" name="chip" value="1"/)?.[1] ?? ask.match(/name="q" value="([^"]+)"[^>]*>(?:<input[^>]*>)*<button>Yes, note the role/)?.[1];
  expect(chipSay).toBeTruthy();
  await say(chipSay!.replace(/&#39;/g, "'"), true);
  expect(refs("role").some((s) => s.endsWith("/chip"))).toBe(true);
});
