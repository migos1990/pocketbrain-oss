// SPDX-License-Identifier: AGPL-3.0-only
// OpenFGA as a second lock on the carve (src/fga.ts), against a stand-in OpenFGA API: FGA can
// only take slices away, a removed tuple cuts the slice on the next refresh, an unreachable FGA
// fails closed, and FGA never receives a note id or a value.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { FgaClient, startFga, stopFga, refreshFga, syncFga, tuplesFromPolicy, sliceObject, type Tuple } from "../src/fga";
import { search, contextPack } from "../src/core";
import { loadRules } from "../src/rules";
import { useCells, buildCells, cellInfo } from "../src/cell";
import { restoreCells } from "./cells";

let server: ReturnType<typeof Bun.serve>;
let url = "";
let tuples: Tuple[] = [];
let down = false;
const bodies: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      if (down) return new Response("down", { status: 503 });
      const path = new URL(req.url).pathname.replace(/^\/stores\/st1/, "");
      const raw = await req.text();
      bodies.push(raw);
      const b = JSON.parse(raw || "{}");
      if (path === "/list-objects") {
        const objects = tuples.filter((t) => t.user === b.user && t.relation === "reader" && t.object.startsWith(`${b.type}:`)).map((t) => t.object);
        return Response.json({ objects });
      }
      if (path === "/read") return Response.json({ tuples: tuples.map((key) => ({ key })) });
      if (path === "/write") {
        const k = (t: Tuple) => `${t.user}|${t.relation}|${t.object}`;
        const del = new Set((b.deletes?.tuple_keys ?? []).map(k));
        tuples = [...tuples.filter((t) => !del.has(k(t))), ...(b.writes?.tuple_keys ?? [])];
        return Response.json({});
      }
      if (path === "/authorization-models") return Response.json({ authorization_model_id: "m1" });
      return new Response("nope", { status: 404 });
    },
  });
  url = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));
afterEach(() => { stopFga(); restoreCells(); down = false; });

function brain() {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "fga.yaml"), `api_url: ${url}\nstore_id: st1\nrefresh_s: 3600\nmax_age_s: 3600\n`);
  return root;
}
const work = (root: string, agent: string) => search(root, agent, "course").filter((h) => !h.id.startsWith("people/") && !h.id.startsWith("orgs/")).length;
const client = () => new FgaClient({ api_url: url, store_id: "st1" });

test("sync writes exactly policy.yaml's agent slices, and FGA only ever sees agent and slice names", async () => {
  const root = brain();
  tuples = [{ user: "agent:helper", relation: "reader", object: "slice:stale" }];
  const dry = await syncFga(root, { client: client() });
  expect(dry.remove).toEqual([{ user: "agent:helper", relation: "reader", object: "slice:stale" }]);
  expect(tuples.length).toBe(1); // dry run wrote nothing
  await syncFga(root, { client: client(), apply: true });
  expect(tuples).toEqual(tuplesFromPolicy(loadRules(root)));
  expect(tuples.some((t) => t.object === sliceObject("area:work"))).toBe(true);
  expect(bodies.join("\n")).not.toMatch(/projects\/|money\//);
});

for (const cells of [false, true]) {
  test(`removing a tuple in FGA cuts that slice; FGA never adds one (cells ${cells ? "on" : "off"})`, async () => {
    const root = brain();
    if (cells) { useCells(true); buildCells(root); }
    await syncFga(root, { client: client(), apply: true });
    const before = work(root, "helper");
    expect(before).toBeGreaterThan(0);

    // An extra slice granted only in FGA is ignored.
    tuples.push({ user: "agent:helper", relation: "reader", object: "slice:all" });
    await startFga(root, client());
    expect(work(root, "helper")).toBe(before);
    expect(search(root, "helper", "bank").length).toBe(0);

    // The owner deletes helper's work slice in the FGA console.
    tuples = tuples.filter((t) => !(t.user === "agent:helper" && t.object === sliceObject("area:work")));
    await refreshFga(root, client());
    expect(work(root, "helper")).toBe(0);
    expect(work(root, "planner")).toBeGreaterThan(0);
    // Reads still come from a cell, rebuilt from the narrowed slices (invariant 10).
    if (cells) expect(cellInfo(root, "helper")?.slices).not.toContain("area:work");

    // And puts it back: no rebuild needed.
    tuples.push({ user: "agent:helper", relation: "reader", object: sliceObject("area:work") });
    await refreshFga(root, client());
    expect(work(root, "helper")).toBe(before);
  });
}

test("FGA unreachable past max_age_s: outside agents get nothing (fail closed)", async () => {
  const root = brain();
  writeFileSync(join(root, "rules", "fga.yaml"), `api_url: ${url}\nstore_id: st1\nrefresh_s: 3600\nmax_age_s: 0\n`);
  await syncFga(root, { client: client(), apply: true });
  down = true;
  await startFga(root, client());
  await Bun.sleep(5);
  expect(work(root, "helper")).toBe(0);
  expect(contextPack(root, "helper")).not.toMatch(/Course A/);
});

test("without rules/fga.yaml the hub doesn't turn it on and nothing changes", async () => {
  const root = makeBrain();
  expect(await startFga(root)).toBe(false);
  expect(work(root, "helper")).toBeGreaterThan(0);
});
