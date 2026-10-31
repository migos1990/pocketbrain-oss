// SPDX-License-Identifier: AGPL-3.0-only
// The first page after a write (backlog #320, docs/perf.md "The owner's pages"): the dashboard
// carves an assistant only when a page shows what it sees. After a write every carve is made again
// (about 1 s at 10k notes), so the deck, history and the brain's lists must not wait for one.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { dashboardHandler } from "../src/dashboard/server";
import { carvesMade } from "../src/dashboard/data";
import * as core from "../src/core";

const H = "127.0.0.1:8788";

async function signedIn(root: string) {
  const d = dashboardHandler(root, { port: 8788, loginKey: "k".repeat(32) });
  const r = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  return async (path: string) => {
    const x = await d.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie } }));
    return { status: x.status, text: await x.text() };
  };
}

const write = (root: string, value: string) =>
  core.remember(root, "planner", { id: "people/jane-roy", attribute: "role", value, as_of: "2026-10-08", sources: ["gmail:f000000000000009"] });

test("after a write, pages that show no assistant's view don't carve; the ones that do still count right", async () => {
  const root = makeBrain();
  const get = await signedIn(root);
  expect((await get("/overview")).status).toBe(200);
  write(root, "Program director");
  for (const p of ["/history", "/brain", "/upkeep", "/usage", "/digest"]) {
    const before = carvesMade();
    expect((await get(p)).status, p).toBe(200);
    expect(carvesMade() - before, p).toBe(0);
  }
  const before = carvesMade();
  const home = await get("/overview");
  expect(carvesMade()).toBeGreaterThan(before);
  // the counts on the Overview are the carve's, as before
  const st = (await import("../src/dashboard/data")).loadState(root);
  const helper = st.agents.find((a) => a.name === "helper")!;
  expect(helper.notes).toBe(st.carves.get("helper")!.visible.size);
  expect(home.text).toContain(`sees ${helper.notes} of ${st.notes.length} note`);
});

test("a carve made for one page is kept for the next until the brain changes", async () => {
  const root = makeBrain();
  const get = await signedIn(root);
  await get("/overview");
  const before = carvesMade();
  await get("/overview");
  await get("/agents");
  expect(carvesMade()).toBe(before);
  write(root, "Program head");
  await get("/agents");
  expect(carvesMade()).toBeGreaterThan(before);
});
