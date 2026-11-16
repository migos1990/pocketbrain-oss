// SPDX-License-Identifier: AGPL-3.0-only
// The first minute of a new brain (cold install, 2026-11-15; plans/close-three-gaps S1 part b): the
// first assistant's save about the owner shows on the home as "Not confirmed", a guess that asks
// nothing and files nothing; and the home says what to tell the memory until the owner's own page
// holds three things.
import { test, expect, setDefaultTimeout, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initBrain } from "../src/init";
import { handle } from "../src/server";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { homeView, FIRST_THINGS } from "../src/dashboard/home";
import { homePage, APP_COPY } from "../src/dashboard/html-app";
import { ownerSay } from "../src/owner-say";
import { ownerAsks } from "../src/waiting";

setDefaultTimeout(30_000);
// Pinned for this file: bun runs every test file in one process, and another file's PB_TODAY made a
// fact dated 2026-11-01 one from the future (the gate's run, 2026-11-15).
beforeEach(() => { process.env.PB_TODAY = "2026-10-08"; });

async function remember(root: string, token: string, body: Record<string, unknown>) {
  const res = await handle(root, new Request("http://pb/v1/remember", { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${token}` } }));
  return await res.json() as { outcome: string; message?: string };
}
const view = (root: string) => homeView(root, loadRules(root), loadBrain(root), new Date());

test("a trial assistant's save about the owner shows on the home as Not confirmed, and asks nothing", async () => {
  const root = join(mkdtempSync(join(tmpdir(), "pb-first-minute-")), "brain");
  const { token } = initBrain(root, { owner: "Sam Rivera", agent: "claude" });
  const w = await remember(root, token!, { type: "person", title: "Sam Rivera", attribute: "based_in", value: "Lisbon", as_of: "2026-10-01", sources: ["agent:claude"] });
  expect(w.outcome).toBe("inbox");
  const v = view(root);
  expect(v.unconfirmed).toMatchObject([{ page: "people/sam-rivera", what: "Sam Rivera's based in is Lisbon.", from: "Not confirmed · Claude said so." }]);
  // A guess: no count, nothing on the page, no ask anywhere.
  expect(ownerAsks(root).total).toBe(0);
  expect(JSON.stringify(loadBrain(root).find((n) => n.fm.id === "people/sam-rivera")!.fm.facts ?? {})).not.toContain("Lisbon");
  const html = homePage(v, "x");
  expect(html).toContain(APP_COPY.unconfirmedHead);
  expect(html).toContain("Sam Rivera&#39;s based in is Lisbon.");
});

test("an assistant's save that looks like money never shows its value on the home", async () => {
  const root = join(mkdtempSync(join(tmpdir(), "pb-first-minute-")), "brain");
  const { token } = initBrain(root, { owner: "Sam Rivera", agent: "claude" });
  await remember(root, token!, { type: "person", title: "Sam Rivera", attribute: "salary", value: "90000 a year", as_of: "2026-10-01", sources: ["agent:claude"] });
  expect(JSON.stringify(view(root).unconfirmed ?? [])).not.toContain("90000");
});

test("the home says to tell the memory three things until the owner's page holds them", () => {
  const root = join(mkdtempSync(join(tmpdir(), "pb-first-minute-")), "brain");
  initBrain(root, { owner: "Sam Rivera", token: false });
  expect(view(root).first).toBe(true);
  expect(homePage(view(root), "x")).toContain(APP_COPY.firstRun);
  const said = ["I work at Northwind", "I live in Lisbon", "I prefer short answers"];
  expect(said.length).toBe(FIRST_THINGS);
  for (const s of said) expect(ownerSay(root, s, { fresh: true }).kind).toBe("say.noted");
  expect(view(root).first).toBeUndefined();
  expect(homePage(view(root), "x")).not.toContain(APP_COPY.firstRun);
});
