// SPDX-License-Identifier: AGPL-3.0-only
// Red team #236 on the sealed edge (pocketbrain-app-reviews/redteam-236-batches-20-21.md).
// G178: anyone who could read a bundle and write to queue/ could commit as an enrolled agent: the
// bundle carried the hub's public key and the token hashes tokens.yaml stores, and replay trusted
// the op's agent and token hash. Now each queued op carries a MAC under a key only a live token
// (or the hub's home state) can derive, and a bundle names no token hash.
// G181: the gardener's cell was published with its windows dropped, so its token read at the edge
// at any hour. An agent with hours (windows, or the gardener role) is never published, and replay
// refuses its queued ops.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { createPublicKey, generateKeyPairSync, diffieHellman, hkdfSync, createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { enroll, publish, replay, edgeHandle, type Bundle } from "../src/edge";
import { tokenInfo } from "../src/auth";
import { loadBrain } from "../src/brain";

let out = "";
beforeEach(() => { process.env.PB_CONFIG_DIR = join(mkdtempSync(join(tmpdir(), "pb-edge-home-")), "keys"); out = mkdtempSync(join(tmpdir(), "pb-edge-out-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; delete process.env.PB_NOW; });

// What an attacker with only the bundle can do: seal any op to the hub's public key.
function sealToHub(hubPublic: string, data: Buffer) {
  const pub = createPublicKey({ key: Buffer.from(hubPublic, "base64"), format: "der", type: "spki" });
  const eph = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: pub });
  const epk = eph.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(epk), "pocketbrain edge v1 queue", 32));
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from("queue"));
  const ct = Buffer.concat([c.update(data), c.final()]);
  return { epk, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}
const nextStep = (root: string) => JSON.stringify(loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.facts!.next_step);
const mcp = (token: string, name: string, args: Record<string, unknown> = {}) => edgeHandle(out, new Request("http://edge/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }));
const ARGS = { id: "projects/course-a", attribute: "next_step", value: "Forged by the edge store", as_of: "2026-10-07", sources: ["gmail:f000000000000009"], verification: "verified-by-source" };

test("G178: a forged queue entry (only the bundle, no token) is refused on replay and commits nothing", async () => {
  const root = makeBrain();
  enroll(root, "planner");
  publish(root, out);
  const b = JSON.parse(readFileSync(join(out, "planner.json"), "utf8")) as Bundle;
  // The hash tokens.yaml stores, as the attacker would guess it from the brain or a bundle.
  const tokenHash = tokenInfo(root).planner![0].hash;
  mkdirSync(join(out, "queue"), { recursive: true });
  for (const [i, op] of [
    { tool: "remember", args: ARGS, agent: "planner", token_hash: tokenHash, at: new Date().toISOString() },
    { tool: "remember", args: ARGS, agent: "planner", token_hash: tokenHash, at: new Date().toISOString(), mac: "AAAA" },
  ].entries()) writeFileSync(join(out, "queue", `${Date.now()}-forged0${i}.json`), JSON.stringify(sealToHub(b.hub_key, Buffer.from(JSON.stringify(op)))));
  const rs = await replay(root, out);
  expect(rs.map((r) => r.outcome)).toEqual(["refused", "refused"]);
  expect(rs[0].message).toContain("not signed");
  expect(nextStep(root)).not.toContain("Forged by the edge store");
});

test("G178: a bundle names no token hash that tokens.yaml stores", () => {
  const root = makeBrain();
  enroll(root, "planner");
  publish(root, out);
  const raw = readFileSync(join(out, "planner.json"), "utf8");
  for (const t of tokenInfo(root).planner!) expect(raw).not.toContain(t.hash);
});

test("G178: a real edge write still replays, and one whose args were changed in the queue doesn't", async () => {
  const root = makeBrain();
  const token = enroll(root, "planner");
  publish(root, out);
  await mcp(token, "remember", { ...ARGS, value: "Publish the grades" });
  await mcp(token, "remember", { ...ARGS, attribute: "status", value: "active" });
  expect(readdirSync(join(out, "queue")).filter((f) => f.endsWith(".json")).length).toBe(2);
  const rs = await replay(root, out);
  expect(rs.map((r) => r.outcome)).toEqual(["committed", "committed"]);
  expect(nextStep(root)).toContain("Publish the grades");
});

test("G181: an agent with hours (the gardener) is never published, so its token reads nothing at the edge", async () => {
  const root = makeBrain();
  const token = enroll(root, "gardener");
  const p = publish(root, out);
  expect(p.published).not.toContain("gardener");
  expect(p.left_out.gardener).toContain("hours");
  process.env.PB_NOW = "2026-10-08T15:00:00Z";
  const r = await mcp(token, "read", { id: "money/main-bank" });
  expect(r.status).toBe(401);
});

test("G181: a queued op from an agent with hours is refused on replay, whenever it was queued", async () => {
  const root = makeBrain();
  const token = enroll(root, "planner");
  publish(root, out);
  await mcp(token, "remember", { ...ARGS, value: "Queued before it got hours" });
  // The owner gives planner hours after the write was queued.
  const f = join(root, "rules", "policy.yaml");
  const doc = YAML.parseDocument(readFileSync(f, "utf8"));
  doc.setIn(["agents", "planner", "windows"], ["daily 03:25-05:00"]);
  writeFileSync(f, doc.toString());
  const [r] = await replay(root, out);
  expect(r.outcome).toBe("refused");
  expect(r.message).toContain("hours");
  expect(nextStep(root)).not.toContain("Queued before it got hours");
});

test("G178: a signed write copied back into the queue doesn't run twice", async () => {
  const root = makeBrain();
  const token = enroll(root, "planner");
  publish(root, out);
  await mcp(token, "remember", { ...ARGS, value: "Publish the grades" });
  const [f] = readdirSync(join(out, "queue")).filter((x) => x.endsWith(".json"));
  const copy = readFileSync(join(out, "queue", f), "utf8");
  const first = (await replay(root, out))[0];
  expect(first.message ?? "").not.toContain("not signed");
  expect(first.outcome).not.toBe("refused");
  writeFileSync(join(out, "queue", `${Date.now()}-again.json`), copy);
  const [again] = await replay(root, out);
  expect(again.outcome).toBe("refused");
  expect(again.message).toContain("already replayed");
});
