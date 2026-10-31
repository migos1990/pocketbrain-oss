// SPDX-License-Identifier: AGPL-3.0-only
// pocketbrain support bundle (backlog 297): one file a pilot user can send for help. Versions,
// doctor, job health, the shape of rules/ (keys, not values) and the hub log's last lines, with
// secrets, addresses and anything from the brain scrubbed. Seeded secrets and private values
// must not survive, and the bundle refuses to write if one would.
import { test, expect } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain } from "../src/brain";
import { supportBundle } from "../src/support";

const APP = join(import.meta.dir, "..");
const cli = (root: string, home: string, ...a: string[]) => {
  const r = Bun.spawnSync(["bun", "src/cli.ts", ...a], { cwd: APP, env: { ...process.env, PB_BRAIN: root, HOME: home }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

// Everything that must not leave the machine, seeded where a careless bundle would pick it up.
const TOKEN = `pb_planner_${"A1b2C3d4".repeat(4)}`;
const API_KEY = `sk-ant-api03-${"x9Y8z7W6".repeat(4)}`;
const LOGIN = "http://127.0.0.1:8788/login?key=Zq7RkP2mVt9LxW4sNc8HbJ3dFy6GaE1u";
const EMAIL = "sam.owner@example.org";
const IP = "203.0.113.57";
const PHONE = "+1 514-555-0199";
const DOOR = "brain.sam-example.org";

function seeded() {
  const root = makeBrain();
  const home = mkdtempSync(join(tmpdir(), "pb-support-home-"));
  const notes = loadBrain(root);
  const bank = notes.find((n) => n.path === "money/main-bank.md")!;
  const bankValue = String((bank.fm.facts!.bank as { value: string }).value); // "Maple Trust Bank", a private fact
  const jane = notes.find((n) => n.path === "people/jane-roy.md")!;
  const body = jane.body.trim().split("\n")[0]; // a note body line
  writeFileSync(join(root, "rules", "hub.yaml"), `hub: laptop\nepoch: 1\nreplicas:\n  laptop: {}\npublic_url: https://${DOOR}\nowner_email: ${EMAIL}\n`);
  const logs = join(home, "Library", "Logs");
  mkdirSync(logs, { recursive: true });
  const log = join(logs, "com.pocketbrain.start.log");
  for (let i = 0; i < 250; i++) appendFileSync(log, `2026-10-16T03:${String(i % 60).padStart(2, "0")}:00Z filler line ${i}\n`);
  appendFileSync(log, [
    `owner dashboard (this machine only): ${LOGIN}`,
    `planner wrote with ${TOKEN}`,
    `ANTHROPIC_API_KEY=${API_KEY}`,
    `mail from ${EMAIL} via ${IP}, call ${PHONE}`,
    `door https://${DOOR}/mcp answered`,
    `write money/main-bank#bank = ${bankValue} (${bank.fm.title})`,
    `capture said: ${body}`,
    `read ${home}/pocketbrain-brain/people/jane-roy.md for Jane Roy`,
    "last line of the log",
  ].join("\n") + "\n");
  mkdirSync(join(root, "log"), { recursive: true });
  writeFileSync(join(root, "log", "start-state.json"), JSON.stringify({ night_error: `fact ${bankValue} blew up`, digest_at: "2026-10-16T07:00:00Z" }));
  return { root, home, secrets: [TOKEN, API_KEY, LOGIN, "Zq7RkP2mVt9LxW4sNc8HbJ3dFy6GaE1u", EMAIL, IP, PHONE, DOOR, bankValue, bank.fm.title, body, "Jane Roy", "jane-roy", home] };
}

test("the bundle has versions, doctor, jobs, the rules' keys and the log's last lines, and nothing it was seeded with", async () => {
  const { root, home, secrets } = seeded();
  const b = await supportBundle(root, { home, now: new Date("2026-10-16T08:00:00Z") });
  for (const s of secrets) expect(b).not.toContain(s);
  expect(b).not.toMatch(/maple trust/i);
  // What support needs is there.
  for (const h of ["## Versions", "## Doctor", "## Jobs", "## Rules shape", "## Hub log"]) expect(b).toContain(h);
  expect(b).toMatch(/pocketBrain \d+\.\d+\.\d+/);
  expect(b).toContain("brain format 1");
  expect(b).toMatch(/night: failed/); // the job's state, without its message's private words
  expect(b).toContain("public_url: <text>"); // the key, not the value
  expect(b).toContain("agents:");
  // The last 200 log lines, scrubbed in place so they still read.
  const log = b.slice(b.indexOf("## Hub log")).split("\n").filter((l) => /^\s{2}\S/.test(l));
  expect(log.length).toBe(200);
  expect(b).toContain("filler line 249");
  expect(b).not.toContain("filler line 58\n");
  expect(b).toContain("last line of the log");
  expect(b).toContain("door https://[host]/mcp answered");
  expect(b).toContain("[email]");
  expect(b).toContain("~/pocketbrain-brain/");
});

test("the bundle refuses to exist if a secret shape or a brain value would still be in it", async () => {
  const { root, home } = seeded();
  await expect(supportBundle(root, { home, now: new Date(), extra: ["password: hunter2xyz9"] })).rejects.toThrow(/not written/);
});

test("pocketbrain support bundle writes one file only you can read and says what's in it", () => {
  const { root, home, secrets } = seeded();
  const out = join(mkdtempSync(join(tmpdir(), "pb-support-out-")), "bundle.txt");
  const r = cli(root, home, "support", "bundle", "--out", out);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(r.out).toContain(out);
  expect(r.out).toContain("no note content");
  expect(statSync(out).mode & 0o777).toBe(0o600);
  const text = readFileSync(out, "utf8");
  for (const s of secrets) expect(text).not.toContain(s);
  expect(cli(root, home, "support").code).toBe(2);
});
