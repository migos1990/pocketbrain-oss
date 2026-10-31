// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { makeModel, type ModelRequest } from "../src/model";
import { verifyChain } from "../src/readlog";
import { usageEvents, usageFile, summary, capState, metered, usageItem } from "../src/usage";
import { sleep } from "../src/sleep";
import { write } from "../src/write";
import { digest } from "../src/digest";
import { openItems } from "../src/textline/items";
import { tick } from "../src/textline/poll";
import { fakeTransport, fakeSent } from "../src/textline/transport";
import { buildCells, cellsDir } from "../src/cell";
import { usagePage, setMonthlyCap } from "../src/dashboard/usage";

const PRICES = { model_minute: 0.1, model_input_per_million: 3, model_output_per_million: 15 };

function setUsage(root: string, usage: unknown) {
  const f = join(root, "rules", "policy.yaml");
  const doc = YAML.parse(readFileSync(f, "utf8"));
  if (usage === undefined) delete doc.usage; else doc.usage = usage;
  writeFileSync(f, YAML.stringify(doc));
}

function setup() {
  const root = makeBrain();
  const tok = { helper: issueToken(root, "helper"), planner: issueToken(root, "planner"), steward: issueToken(root, "steward") };
  const call = async (agent: keyof typeof tok, method: string, path: string, body?: unknown) => {
    const res = await handle(root, new Request(`http://pb${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${tok[agent]}` } }));
    return { status: res.status, text: await res.text() };
  };
  const mcp = (agent: keyof typeof tok, method: string, params?: unknown) => call(agent, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method, params });
  return { root, call, mcp };
}

const fake = (out = "x".repeat(400)) => makeModel({ provider: "fake", model: "f1" }, { fake: (_r: ModelRequest) => out });

test("a metered model call records tokens, seconds and cost per step, hash-chained", async () => {
  const root = makeBrain();
  setUsage(root, { prices: PRICES });
  await metered(root, "sleep.consolidate", fake()).complete({ system: "s", prompt: "p".repeat(3999) });
  await metered(root, "capture.extract", fake("{}"), "capture").complete({ system: "s", prompt: "p".repeat(399) });
  const [a, b] = usageEvents(root);
  expect(a).toMatchObject({ step: "sleep.consolidate", by: "reflect", outcome: "ok", provider: "fake", model: "f1", tokens_in: 1000, tokens_out: 100, estimated: true, day: "2026-10-08" });
  expect(a.cost).toBeCloseTo(1000 * 3 / 1e6 + 100 * 15 / 1e6 + a.seconds * 0.1 / 60, 6);
  expect(b).toMatchObject({ step: "capture.extract", by: "capture", tokens_in: 100, tokens_out: 1 });
  const s = summary(root);
  expect(s.total.calls).toBe(2);
  expect(s.steps.map((x) => x.step)).toEqual(["capture.extract", "sleep.consolidate"]);
  expect(verifyChain(usageFile(root))).toEqual({ entries: 2, unchained: 0 });
  // An edited line shows.
  const f = usageFile(root);
  writeFileSync(f, readFileSync(f, "utf8").replace('"tokens_in":1000', '"tokens_in":10'));
  expect(verifyChain(f).broken).toBe(1);
  // A failed call is recorded too (a provider may still bill it), then rethrown.
  const broken = makeModel({ provider: "fake", model: "f1" });
  await expect(metered(root, "upkeep.duplicates", broken).complete({ system: "", prompt: "" })).rejects.toThrow();
  expect(usageEvents(root).at(-1)).toMatchObject({ step: "upkeep.duplicates", outcome: "error" });
});

test("reads and writes are never metered, and keep working past the cap", async () => {
  const { root, call } = setup();
  setUsage(root, { prices: PRICES, cap: { monthly: 0.000001 } });
  await metered(root, "sleep.consolidate", fake()).complete({ system: "s", prompt: "p".repeat(3999) });
  expect(capState(root).state).toBe("over");
  // The owner is told agent mail held by the paused request check is waiting (relay step 3c).
  expect(usageItem(root)?.title).toContain("assistant mail that needs the request check is held for you");
  expect((await call("helper", "GET", "/v1/context")).status).toBe(200);
  expect((await call("planner", "GET", "/v1/search?q=course")).status).toBe(200);
  const w = await call("planner", "POST", "/v1/remember", { id: "projects/course-a", attribute: "next_step", value: "Book the room", as_of: "2026-10-08", sources: ["gmail:f000000000000006"] });
  expect(["committed", "disputed"]).toContain(JSON.parse(w.text).outcome);
  expect(usageEvents(root).length).toBe(1);
});

test("past the monthly cap every model step pauses; a step cap pauses only that step", async () => {
  const root = makeBrain();
  setUsage(root, { prices: PRICES, cap: { monthly: 1, steps: { "capture.extract": 0.001 } } });
  const cap = metered(root, "capture.extract", fake(), "capture");
  await cap.complete({ system: "s", prompt: "p".repeat(3999) });
  await expect(cap.complete({ system: "s", prompt: "p" })).rejects.toThrow("paused: capture.extract reached its monthly cap ($0.0010)");
  await metered(root, "upkeep.duplicates", fake()).complete({ system: "s", prompt: "p" }); // other steps still run
  expect(usageItem(root)?.title).toBe("capture.extract reached its monthly cap and is paused");

  setMonthlyCap(root, "0.002");
  const m = metered(root, "sleep.consolidate", fake());
  await expect(m.complete({ system: "s", prompt: "p" })).rejects.toThrow("paused: this month's model spend cap ($0.0020) is reached");
  // The nightly pass carries on and says what it held, for the morning note.
  for (let i = 0; i < 2; i++) write(root, { agent: "helper", kind: "journal", text: `Jane Roy is now Program director (${i})`, sources: ["gmail:f000000000000006"] });
  const r = await sleep(root, { model: m });
  expect(r.held.join("\n")).toContain("model spend cap ($0.0020) is reached");
});

// ---------- agents never see it ----------

// Everything an agent can receive: MCP handshake, tool list, every tool, every API route,
// errors, the public routes.
async function agentTranscript(root: string, call: ReturnType<typeof setup>["call"], mcp: ReturnType<typeof setup>["mcp"]): Promise<string[]> {
  const out: string[] = [];
  const keep = (r: { text: string }) => out.push(r.text.replace(/"(at|recorded|last_confirmed|updated|heartbeat)": "[^"]*"/g, '"$1": "T"').replace(/inbox\/[^"]+\.yaml/g, "inbox/F").replace(/commit [0-9a-f]{7,}/g, "commit H").replace(/(new-org)-[0-9a-f]{6}\b/g, "$1-H")); // a new note's suffix is random (G28)
  for (const a of ["helper", "planner", "steward"] as const) {
    keep(await mcp(a, "initialize", {}));
    keep(await mcp(a, "tools/list"));
    for (const [name, args] of [["orientation", {}], ["context_pack", {}], ["context_pack", { topic: "course" }], ["search", { query: "jane" }], ["read", { id: "projects/course-a" }], ["read", { id: "money/main-bank" }],
      ["remember", { id: "projects/course-a", attribute: "next_step", value: `Prepare session 7 (${a})`, as_of: "2026-10-08", sources: ["gmail:f000000000000006"] }],
      ["remember", { id: "projects/course-a", attribute: "next_step", value: "password: hunter2", as_of: "2026-10-08", sources: ["gmail:f000000000000006"] }],
      ["retire", { id: "projects/course-a", attribute: "next_step", as_of: "2026-10-08", sources: ["gmail:f000000000000006"] }],
      ["unknown_tool", {}]] as const)
      keep(await mcp(a, "tools/call", { name, arguments: args }));
    for (const p of ["/v1", "/v1/orientation", "/v1/orientation?format=json", "/v1/context", "/v1/search?q=bank", "/v1/notes/people%2Fjane-roy", "/v1/disputes", "/v1/louis/outbox", "/v1/nope"]) keep(await call(a, "GET", p));
    keep(await call(a, "POST", "/v1/remember", { title: "New Org", type: "org", area: "work", attribute: "website", value: "https://example.org", as_of: "2026-10-08", sources: ["url:https://example.org"] }));
  }
  for (const p of ["/", "/health", "/openapi.json"]) keep({ text: await (await handle(root, new Request(`http://pb${p}`))).text() });
  return out;
}

test("agents never see model spend: every agent-facing output is identical with no cap, under it and over it", async () => {
  const runs: Record<string, string[]> = {};
  for (const mode of ["off", "under", "over"] as const) {
    const { root, call, mcp } = setup();
    if (mode !== "off") setUsage(root, { currency: "USD", prices: PRICES, cap: { monthly: mode === "over" ? 0.000001 : 1000, steps: { "sleep.consolidate": 500 } } });
    if (mode === "over") await metered(root, "sleep.consolidate", fake()).complete({ system: "s", prompt: "p".repeat(4000) });
    if (mode === "over") expect(capState(root).state).toBe("over");
    runs[mode] = await agentTranscript(root, call, mcp);
    buildCells(root);
    const files = (d: string): string[] => readdirSync(d).flatMap((f) => statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]);
    for (const f of files(cellsDir(root)).filter((x) => /\.(ya?ml|json|md)$/.test(x))) expect(readFileSync(f, "utf8")).not.toMatch(/usage|prices|monthly/i);
  }
  expect(runs.under).toEqual(runs.off);
  expect(runs.over).toEqual(runs.off);
}, 60_000);

const SPEND_WORDS = /\b(usage|spend|spent|budget|bill|billing|meter|quota|credits?|price|cost|cap|paused|model|tokens?)\b|\$\s?\d/i;

test("the owner hears in the digest with amounts, and by text only as an opaque account notice", async () => {
  const root = makeBrain();
  setUsage(root, { prices: PRICES, cap: { monthly: 0.01, alert_at: 0.5 } });
  const m = metered(root, "sleep.consolidate", fake("y".repeat(1200)));
  await m.complete({ system: "s", prompt: "p".repeat(400) }); // 100 in, 300 out: $0.0048 + time
  await m.complete({ system: "s", prompt: "p".repeat(400) });
  expect(capState(root).state).toBe("warn");
  expect(openItems(root).find((i) => i.kind === "usage")!.title).toBe("Account notice: open the dashboard when you can");
  await m.complete({ system: "s", prompt: "p".repeat(400) });
  const it = openItems(root).find((i) => i.kind === "usage")!;
  expect(it.key).toBe("usage:over:2026-10");
  expect(it.title).not.toMatch(SPEND_WORDS);
  const d = digest(root).text;
  expect(d).toMatch(/\*\*Model spend cap reached\*\*: \$0\.01\d+ of \$0\.0100 this month/);
  expect(d).toContain("- Model calls since the last digest: 3 (");
  writeFileSync(join(root, "rules", "escalation.yaml"), YAML.stringify({ transport: { use: "fake" }, quiet_hours: null, batch: { style: "list", wait_minutes: 0, max_wait_count: 1, min_gap_minutes: 0, max_items: 5, max_chars: 480 } }));
  await tick(root, { now: new Date("2026-10-08T15:00:00Z"), transport: fakeTransport(root) });
  const sent = fakeSent(root).map((x) => x.text).join("\n");
  expect(sent).toContain("Account notice, action needed");
  expect(sent).not.toMatch(SPEND_WORDS);
});

test("the dashboard's spend page and cap action", async () => {
  const root = makeBrain();
  setUsage(root, { prices: PRICES, cap: { monthly: 10 } });
  await metered(root, "sleep.consolidate", fake()).complete({ system: "s", prompt: "p".repeat(3999) });
  const p = usagePage(root, "csrf");
  expect(p.body).toContain("Model spend, 2026-10");
  expect(p.body).toMatch(/<b>\$0\.00\d+<\/b> this month of a \$10\.00 cap/);
  expect(p.body).toContain("sleep.consolidate");
  expect(setMonthlyCap(root, "25")).toBe("monthly model spend cap set to $25.00");
  expect(capState(root).cap).toBe(25);
  expect(() => setMonthlyCap(root, "-3")).toThrow();
  expect(setMonthlyCap(root, "none")).toBe("model spend cap removed");
  expect(capState(root).state).toBe("none");
  expect(existsSync(usageFile(root))).toBe(true);
});

test("tokens are priced at the model's list price unless the owner overrides it; unknown models are flagged", async () => {
  const root = makeBrain();
  const stub = (provider: "anthropic" | "openai", model: string): import("../src/model").Model => ({
    config: { provider, model },
    complete: async () => ({ text: "ok", provider, model: `${model}-20261001`, usage: { input_tokens: 1_000_000, output_tokens: 100_000 } }),
  });
  await metered(root, "sleep.consolidate", stub("anthropic", "claude-sonnet-5-5")).complete({ system: "", prompt: "" });
  expect(usageEvents(root).at(-1)).toMatchObject({ cost: 2 + 1, model: "claude-sonnet-5-5-20261001" });
  await metered(root, "sleep.consolidate", stub("openai", "gpt-unknown")).complete({ system: "", prompt: "" });
  expect(usageEvents(root).at(-1)).toMatchObject({ cost: 0, unpriced: true });
  setUsage(root, { prices: { model_input_per_million: 1, model_output_per_million: 1 } });
  await metered(root, "sleep.consolidate", stub("openai", "gpt-unknown")).complete({ system: "", prompt: "" });
  expect(usageEvents(root).at(-1)!.cost).toBeCloseTo(1.1, 6);
  expect(usageEvents(root).at(-1)!.unpriced).toBeUndefined();
});
