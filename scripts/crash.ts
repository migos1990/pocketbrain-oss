// SPDX-License-Identifier: AGPL-3.0-only
// Crash check (docs/perf.md): kill -9 the hub in the middle of agents' writes, the nightly
// sleep pass and a backup, on a synthetic brain, then check that nothing is corrupt, every
// write the hub acknowledged is in git, and the hub starts again and takes a new write.
//   bun scripts/crash.ts [--rounds 10] [--notes 1000] [--keep]
// Exits 1 on any finding. Synthetic data only.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synthBrain } from "./perf";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const sh = (cwd: string, ...a: string[]) => { const r = Bun.spawnSync(a, { cwd, stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() }; };
const killGroup = (p: { pid: number }) => { try { process.kill(-p.pid, "SIGKILL"); } catch { /* already gone */ } };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// What a crash may never leave behind.
export async function checkBrain(root: string, acked: { id: string; attribute: string; value: string }[] = []): Promise<string[]> {
  const bad: string[] = [];
  // A git command the hub had started outlives it (kill -9 doesn't reach children): let it end,
  // as it would on a real machine, before judging what is on disk.
  for (let i = 0; i < 100 && existsSync(join(root, ".git", "index.lock")); i++) await pause(100);
  await pause(500);
  const fsck = sh(root, "git", "fsck", "--no-dangling", "--no-progress");
  if (fsck.code !== 0) bad.push(`git fsck: ${(fsck.err || fsck.out).split("\n").slice(0, 3).join(" | ")}`);
  const { loadBrain } = await import("../src/brain");
  try { loadBrain(root); } catch (e) { bad.push(`a note doesn't parse: ${(e as Error).message.slice(0, 200)}`); }
  const { verifyChain } = await import("../src/readlog");
  for (const f of ["log/writes.jsonl", "log/reads.jsonl"]) {
    const v = verifyChain(join(root, f));
    if (v.broken) bad.push(`${f}: chain broken at line ${v.broken} (${v.why})`);
  }
  const head = new Map<string, string>();
  for (const a of acked) {
    const text = head.get(a.id) ?? head.set(a.id, sh(root, "git", "show", `HEAD:${a.id}.md`).out).get(a.id)!;
    if (!text.includes(a.value)) bad.push(`acknowledged write lost from git: ${a.id}#${a.attribute} = ${a.value}`);
  }
  return bad;
}

async function startHub(root: string, port: number) {
  // In its own process group, so a kill takes its git children too, as a launchd restart
  // (kickstart -k) or a power cut does.
  const p = Bun.spawn(["setsid", "bun", CLI, "serve", "--brain", root, "--port", String(port)], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  for (let i = 0; i < 600; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return p; } catch { /* not up yet */ }
    if (p.exitCode !== null) throw new Error(`hub exited ${p.exitCode}: ${(await new Response(p.stderr).text()).slice(-400)}`);
    await pause(200);
  }
  throw new Error("hub didn't start in 120 s");
}

async function main(argv: string[]): Promise<number> {
  const num = (f: string, d: number) => { const i = argv.indexOf(f); return i >= 0 ? Number(argv[i + 1]) : d; };
  const rounds = num("--rounds", 10);
  const root = mkdtempSync(join(tmpdir(), "pb-crash-"));
  const s = synthBrain(root, { notes: num("--notes", 1000), days: 200 });
  // Steward owns the personal area: its writes there commit directly (elsewhere they'd be proposals).
  const mine = s.ids.filter((id) => s.area.get(id) === "personal");
  process.env.PB_TODAY = s.today;
  const { issueToken } = await import("../src/auth");
  const token = issueToken(root, "steward");
  // A stream of writes as fast as the hub takes them: lift the request budget (src/budget.ts).
  const pol = join(root, "rules", "policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8").replace(/\n*$/, "\n") + "budget: { requests_per_minute: 100000, writes_per_hour: 100000 }\n");
  sh(root, "git", "add", "-A"); sh(root, "git", "-c", "user.name=louis", "-c", "user.email=l@x", "commit", "-qm", "token");
  const port = 18700 + Math.floor(Math.random() * 200);
  const findings: string[] = [];
  const acked: { id: string; attribute: string; value: string }[] = [];
  let n = 0;

  // 1. Writes: a steady stream of remember calls, killed at a random moment each round.
  for (let r = 0; r < rounds; r++) {
    const hub = await startHub(root, port);
    const stop = Date.now() + 300 + Math.random() * 1500;
    const inflight: Promise<void>[] = [];
    while (Date.now() < stop) {
      const w = { id: mine[n % mine.length], attribute: `crash_${n}`, value: `crash value ${n}` };
      n++;
      inflight.push(fetch(`http://127.0.0.1:${port}/v1/remember`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ ...w, as_of: s.today, sources: [`gmail:${n.toString(16).padStart(16, "0")}`] }) })
        .then(async (res) => { const j = await res.json().catch(() => ({})); if (res.ok && (j as { outcome?: string }).outcome === "committed") acked.push(w); })
        .catch(() => { /* killed mid-request: not acknowledged */ }));
      await pause(15);
    }
    killGroup(hub);
    await Promise.all(inflight);
    await hub.exited;
    findings.push(...(await checkBrain(root, acked)).map((f) => `writes round ${r + 1}: ${f}`));
  }
  // After all that, the hub must start and commit a new write.
  {
    const hub = await startHub(root, port);
    const w = { id: mine[1], attribute: "after_crash", value: "after crash value" };
    const res = await fetch(`http://127.0.0.1:${port}/v1/remember`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ ...w, as_of: s.today, sources: ["gmail:00000000000000ff"] }) });
    const j = await res.json().catch(() => ({})) as { outcome?: string; message?: string };
    if (j.outcome !== "committed") findings.push(`after the crashes a new write wasn't committed: ${JSON.stringify(j).slice(0, 200)}`);
    else acked.push(w);
    killGroup(hub); await hub.exited;
    findings.push(...(await checkBrain(root, acked)).map((f) => `after restart: ${f}`));
  }

  // 2. The nightly sleep pass, killed partway through (forgetting commits one fact at a time).
  for (let r = 0; r < Math.max(3, Math.floor(rounds / 2)); r++) {
    const p = Bun.spawn(["setsid", "bun", CLI, "sleep", "--no-judge", "--no-upkeep", "--brain", root], { stdout: "ignore", stderr: "ignore", env: { ...process.env } });
    await pause(400 + Math.random() * 3000);
    killGroup(p); await p.exited;
    findings.push(...(await checkBrain(root, acked)).map((f) => `sleep round ${r + 1}: ${f}`));
  }
  const after = Bun.spawnSync(["bun", CLI, "sleep", "--no-judge", "--no-upkeep", "--brain", root], { stdout: "pipe", stderr: "pipe" });
  if (after.exitCode !== 0) findings.push(`sleep after the crashes failed: ${after.stderr.toString().slice(-300)}`);
  findings.push(...(await checkBrain(root, acked)).map((f) => `after sleep: ${f}`));

  // 3. A backup, killed partway through: no half file may look like a backup, the next one works.
  if (Bun.which("age")) {
    const key = Bun.spawnSync(["age-keygen"]).stdout.toString().match(/age1[0-9a-z]+/)![0];
    const dest = mkdtempSync(join(tmpdir(), "pb-crash-backups-"));
    sh(root, "bun", CLI, "backup", "--init", "--pub", key, "--brain", root);
    for (let r = 0; r < 3; r++) {
      const p = Bun.spawn(["setsid", "bun", CLI, "backup", "--dest", dest, "--brain", root], { stdout: "ignore", stderr: "ignore" });
      await pause(100 + Math.random() * 600);
      killGroup(p); await p.exited;
    }
    const ok = sh(root, "bun", CLI, "backup", "--dest", dest, "--brain", root);
    if (ok.code !== 0) findings.push(`backup after the crashes failed: ${ok.err.slice(-300)}`);
    for (const f of readdirSync(dest)) {
      if (f.endsWith(".tar.age") && !f.startsWith(".")) {
        const t = Bun.spawnSync(["sh", "-c", `head -c 40 '${join(dest, f)}'`]).stdout.toString();
        if (!t.startsWith("age-encryption.org/v1")) findings.push(`backup ${f} isn't an age file`);
      } else if (f.endsWith(".partial")) findings.push(`backup left a half-written ${f} behind (${statSync(join(dest, f)).size} bytes)`);
    }
    findings.push(...(await checkBrain(root, acked)).map((f) => `after backup: ${f}`));
    if (!argv.includes("--keep")) rmSync(dest, { recursive: true, force: true });
  }

  console.log(`${acked.length} acknowledged writes over ${rounds} kills; sleep and backup killed too`);
  for (const f of [...new Set(findings)]) console.log(`✗ ${f}`);
  console.log(findings.length ? "CRASH FINDINGS" : "✓ no corruption, no lost acknowledged write, clean restarts");
  if (argv.includes("--keep")) console.log(`kept ${root}`); else rmSync(root, { recursive: true, force: true });
  return findings.length ? 1 : 0;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
