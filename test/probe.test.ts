// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { runChecks, record, probeOnce, failingChecks } from "../src/probe";
import { serve } from "../src/server";

const alerts = (root: string) => { const f = join(root, "log", "alerts.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };

// A fake network: each URL answers what the test says, anything else is down.
const net = (map: Record<string, Response | undefined>) => (async (url: string) => {
  const r = map[url];
  if (!r) throw new Error("down");
  return r.clone();
}) as any;

test("probe: the real server's /mcp is a plain 401 and /health answers", async () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "hub.yaml"), "hub: mac\nepoch: 1\nsince: 2026-10-08\nreplicas: { mac: {} }\n");
  const s = serve(root, 0);
  const url = `http://127.0.0.1:${s.port}`;
  writeFileSync(join(root, "rules", "hub.yaml"), `hub: mac\nepoch: 1\nsince: 2026-10-08\nreplicas: { mac: {} }\npublic_url: ${url}\n`);
  try {
    const checks = await runChecks(root, url);
    expect(checks.map((c) => [c.name, c.ok])).toEqual([["local", true], ["door", true], ["mcp", true]]);
  } finally { s.stop(true); }
});

test("probe: a door that starts failing raises one alert, not one per run; recovery is recorded", async () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "hub.yaml"), "hub: mac\nepoch: 1\nsince: 2026-10-08\nreplicas: { mac: {} }\npublic_url: https://brain.example\n");
  const up = net({ "http://hub/health": new Response("{}"), "https://brain.example/health": new Response("{}"), "https://brain.example/mcp": new Response("", { status: 401 }) });
  const tunnelDown = net({ "http://hub/health": new Response("{}") });
  expect(await probeOnce(root, "http://hub", up)).toEqual([]);
  const first = await probeOnce(root, "http://hub", tunnelDown);
  expect(first.map((c) => c.name)).toEqual(["door", "mcp"]);
  await probeOnce(root, "http://hub", tunnelDown);
  expect(alerts(root).filter((a) => a.agent === "hub").map((a) => a.check)).toEqual(["probe_door", "probe_mcp"]);
  await probeOnce(root, "http://hub", up);
  const state = JSON.parse(readFileSync(join(root, "log", "probe.json"), "utf8"));
  expect(state.door.ok).toBe(true);
});

test("probe: a 401 that invites OAuth (WWW-Authenticate) fails the MCP check", async () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "hub.yaml"), "hub: mac\nepoch: 1\nsince: 2026-10-08\nreplicas: { mac: {} }\npublic_url: https://brain.example\n");
  const oauthy = net({ "http://hub/health": new Response("{}"), "https://brain.example/health": new Response("{}"),
    "https://brain.example/mcp": new Response("", { status: 401, headers: { "www-authenticate": "Bearer resource_metadata=x" } }) });
  const c = (await runChecks(root, "http://hub", oauthy)).find((x) => x.name === "mcp")!;
  expect(c.ok).toBe(false);
  expect(c.detail).toMatch(/WWW-Authenticate/);
  expect(record(root, [c]).length).toBe(1);
});

// Absence alarms: a job that hangs shows as failed, not as quiet, and
// after the nightly pass an always-run check proves every note can still be found.
import { jobChecks, unsearchable } from "../src/probe";
import { runJob, recordJob } from "../src/start";
import { loadBrain, saveNote } from "../src/brain";

test("absence: a job that hangs past its timeout is recorded as failed at once, the write queue stays held until it ends, and the probe reports it", async () => {
  const root = makeBrain();
  recordJob(root, "night", undefined);
  // Past its time the job shows as failed at once, but runJob keeps waiting for it, so the
  // hub's write queue (serial) stays held until the job really ends.
  let finish!: () => void;
  let ended = false;
  const run = runJob(root, "night", () => new Promise<void>((ok) => { finish = ok; }), 30).then((r) => { ended = true; return r; });
  await Bun.sleep(80);
  expect(ended).toBe(false);
  const night = jobChecks(root).find((c) => c.name === "night")!;
  expect(night).toMatchObject({ ok: false });
  expect(night.detail).toContain("timed out");
  finish();
  expect(await run).toContain("timed out");
  expect(jobChecks(root).find((c) => c.name === "night")!.ok).toBe(false); // a late finish doesn't clear the alarm
  await runJob(root, "night", async () => {}, 1000);
  expect(jobChecks(root).find((c) => c.name === "night")!.ok).toBe(true);
});

test("absence: every note must be findable; a note filed under the wrong path or missing from an agent's index fails the check", async () => {
  const root = makeBrain();
  expect(unsearchable(root)).toEqual([]);
  const jane = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
  jane.fm.id = "people/jane-r";
  saveNote(root, jane); // writes people/jane-r.md
  // Moved by hand: the file's path no longer matches its id.
  const { renameSync } = await import("node:fs");
  renameSync(join(root, "people/jane-r.md"), join(root, "people/jane-roy-copy.md"));
  expect(unsearchable(root).join("\n")).toContain("people/jane-roy-copy.md");
  await runJob(root, "searchable", async () => { const p = unsearchable(root); if (p.length) throw new Error(`${p.length} note(s) can't be found: ${p[0]}`); }, 1000);
  expect(jobChecks(root).find((c) => c.name === "searchable")).toMatchObject({ ok: false });
});

// Bug hunt #134: a torn log/probe.json (crash mid-write) made every later probe throw before it
// alerted, and failingChecks read it as "nothing failing".
test("probe: a torn probe.json still alerts, reads as failing, and is rewritten whole", async () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "hub.yaml"), "hub: mac\nepoch: 1\nsince: 2026-10-08\nreplicas: { mac: {} }\npublic_url: https://brain.example\n");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(root, "log"), { recursive: true });
  writeFileSync(join(root, "log", "probe.json"), '{\n  "local": { "ok": true, "since": "2026-10-0');
  expect(failingChecks(root).map((c) => c.name)).toEqual(["probe"]);
  await probeOnce(root, "http://hub", net({ "http://hub/health": new Response("{}") }));
  expect(alerts(root).map((a) => a.check)).toContain("probe_door");
  expect(() => JSON.parse(readFileSync(join(root, "log", "probe.json"), "utf8"))).not.toThrow();
  expect(failingChecks(root).map((c) => c.name)).toContain("door");
});

test("probe: /health fails when the brain's rules can't be read, so the local check alerts", async () => {
  const root = makeBrain();
  const s = serve(root, 0);
  const url = `http://127.0.0.1:${s.port}`;
  try {
    expect((await fetch(`${url}/health`)).status).toBe(200);
    writeFileSync(join(root, "rules", "policy.yaml"), readFileSync(join(root, "rules", "policy.yaml"), "utf8") + "\nbad: [\n");
    const h = await fetch(`${url}/health`);
    expect(h.status).toBe(503);
    expect(await h.text()).not.toContain("policy.yaml\n");
    const checks = await runChecks(root, url);
    expect(checks.find((c) => c.name === "local")?.ok).toBe(false);
  } finally { s.stop(true); }
});

test("probe: with the owner's Tailscale login set, a missing https door on 8443 is a failing check, and a served one passes (G629)", async () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "hub.yaml"), "hub: mac\nepoch: 1\nsince: 2026-10-08\nreplicas: { mac: {} }\ndashboard_tailnet: true\ndashboard_tailnet_login: robin@example.com\ndashboard_tailnet_devices: [100.88.1.2]\n");
  const status = (o: unknown) => () => ({ exitCode: 0, stdout: Buffer.from(JSON.stringify(o)) });
  const hub = net({ "http://hub/health": new Response("ok") });
  const gone = (await runChecks(root, "http://hub", hub, status({}))).find((c) => c.name === "phone_door")!;
  expect(gone.ok).toBe(false);
  expect(gone.detail).toContain("tailscale serve --bg --https=8443 http://127.0.0.1:8788");
  const up = { Web: { "mini.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8788" } } } } };
  expect((await runChecks(root, "http://hub", hub, status(up))).find((c) => c.name === "phone_door")!.ok).toBe(true);
});
