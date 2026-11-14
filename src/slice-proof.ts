// SPDX-License-Identifier: AGPL-3.0-only
// The nightly slice check and its one dated line (docs/slice-proof.md): "300 memories, 3 doors,
// 0 leaks". After the night pass the hub runs scripts/slice-proof.ts in a child process: made-up
// memories (random brains with random rules, test/carve-gen.ts), each read as every one of its
// assistants through every door an assistant reads through, each answer checked against the leak
// oracle, which is written from the rules without the carve code. New memories every night.
// It never reads or writes the owner's brain: the only thing it leaves there is one line a night in
// log/slice-proof.jsonl (counts and seed numbers, never a value) and the `slice_proof` heartbeat.
// A leak, or a run that didn't finish, fails the heartbeat, so the home says so; it is a fault in
// this version of the code, not in the owner's memory. No model, no network.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appendJsonl, readJsonl, codeAtStart } from "./util";
import { beat } from "./heartbeat";

export interface SliceProof {
  at: string;          // when the run ended
  code: string;        // the code version that was checked
  memories: number;    // made-up memories read
  doors: string[];     // the doors each was read through
  leaks: number;       // memories in which any assistant got anything carved out for it
  pages: number; facts: number; readers: number; answers: number;
  seeds: { from: number; to: number };
  failed_seeds: number[]; // replay one: CARVE_SEED=<n> bun test test/carve-property.test.ts
  ms: number;
  error?: string;      // the run didn't finish: nothing above is a result
}

const FILE = (root: string) => join(root, "log", "slice-proof.jsonl");
export const SLICE_PROOF_CASES = 300;
export const SLICE_PROOF_MINUTES = 90;

export function sliceProofs(root: string): SliceProof[] {
  return readJsonl<SliceProof>(FILE(root)).filter((p) => p && typeof p.at === "string");
}
// The last run that finished, for the app and the public page.
export function lastSliceProof(root: string): SliceProof | undefined {
  return sliceProofs(root).filter((p) => !p.error).at(-1);
}

// The line, the same words everywhere it is shown. The day is the caller's to print (`at`).
export function sliceProofLine(p: Pick<SliceProof, "memories" | "doors" | "leaks">): string {
  const n = (k: number, one: string, many: string) => `${k.toLocaleString("en-US")} ${k === 1 ? one : many}`;
  return `${n(p.memories, "memory", "memories")}, ${n(p.doors.length, "door", "doors")}, ${n(p.leaks, "leak", "leaks")}`;
}

// How long the line has held: the unbroken run of finished nights with no leak, newest back, on
// any code version. A night that leaked or didn't finish ends it.
export function sliceProofStreak(all: SliceProof[]): { nights: number; memories: number; since?: string } {
  let nights = 0, memories = 0, since: string | undefined;
  for (let i = all.length - 1; i >= 0; i--) {
    const p = all[i];
    if (p.error || p.leaks > 0) break;
    nights++; memories += p.memories; since = p.at;
  }
  return { nights, memories, since };
}

// Tonight's seeds: a block of its own for every day, so each night reads memories no night read before.
export function seedsFor(day: string, cases = SLICE_PROOF_CASES): { from: number; to: number } {
  const n = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
  const from = 1_000_000 + n * 1_000;
  return { from, to: from + Math.min(Math.max(cases, 1), 1_000) - 1 };
}

type Child = { exited: Promise<number>; stdout: ReadableStream<Uint8Array> | null; kill: (signal?: string) => void };
let running = false;

// One night's run, apart from the hub: a child process on brains of its own in a temp folder, so
// the hub keeps answering and its write queue is never held. Off with PB_SLICE_PROOF=0.
export async function sliceProofNight(root: string, o: { day?: string; cases?: number; spawn?: (cmd: string[]) => Child; timeoutMs?: number; now?: () => Date } = {}): Promise<string> {
  if (!o.spawn && process.env.PB_SLICE_PROOF === "0") return "slice check: off (PB_SLICE_PROOF=0)";
  // An install without the repo's scripts and tests (the npm package ships src/ only) has no check to
  // run: it says so once in the hub log and leaves no failing job behind.
  const script = join(import.meta.dir, "..", "scripts", "slice-proof.ts");
  if (!o.spawn && !existsSync(script)) return "slice check: not in this install (it needs the repo's scripts and tests)";
  if (running) return "slice check: last night's is still running";
  running = true;
  const t0 = Date.now(), now = o.now ?? (() => new Date());
  const cases = o.cases ?? (Number(process.env.PB_SLICE_PROOF_CASES) || SLICE_PROOF_CASES);
  const seeds = seedsFor(o.day ?? now().toISOString().slice(0, 10), cases);
  const fail = (error: string): string => {
    appendJsonl(FILE(root), { at: now().toISOString(), code: codeAtStart(), memories: 0, doors: [], leaks: 0, pages: 0, facts: 0, readers: 0, answers: 0, seeds, failed_seeds: [], ms: Date.now() - t0, error: error.slice(0, 200) } satisfies SliceProof);
    beat(root, "slice_proof", { ok: false, error, ms: Date.now() - t0 });
    return `slice check: didn't finish: ${error}`;
  };
  try {
    const cmd = [process.execPath, script, "--json", "--from", String(seeds.from), "--cases", String(seeds.to - seeds.from + 1)];
    // The child gets none of the hub's keys or brain paths: a path, a temp folder and nothing else.
    const env = { PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? "", HOME: process.env.HOME ?? "" };
    const child = (o.spawn ?? ((c) => Bun.spawn(c, { stdout: "pipe", stderr: "ignore", env }) as unknown as Child))(cmd);
    const ms = o.timeoutMs ?? SLICE_PROOF_MINUTES * 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const out = child.stdout ? new Response(child.stdout).text() : Promise.resolve("");
    const code = await Promise.race([child.exited, new Promise<"late">((done) => { timer = setTimeout(() => done("late"), ms); })]);
    if (timer) clearTimeout(timer);
    if (code === "late") { try { child.kill("SIGKILL"); } catch { /* gone */ } return fail(`stopped after ${Math.round(ms / 60_000) || 1} min`); }
    let r: Partial<SliceProof> | undefined;
    try { r = JSON.parse((await out).trim().split("\n").at(-1) ?? ""); } catch { /* no line */ }
    if (!r || typeof r.memories !== "number" || typeof r.leaks !== "number" || !Array.isArray(r.doors) || r.error) return fail(r?.error ?? `the run exited ${code} with no result`);
    // A short run is not a result: every memory asked for, through at least one door, with answers read.
    const asked = seeds.to - seeds.from + 1;
    if (r.memories !== asked || !r.doors.length || !(Number(r.answers) > 0)) return fail(`the run read ${r.memories} of ${asked} memories through ${r.doors.length} door(s)`);
    const p: SliceProof = { at: now().toISOString(), code: codeAtStart(), memories: r.memories, doors: r.doors.map(String), leaks: r.leaks, pages: Number(r.pages) || 0, facts: Number(r.facts) || 0, readers: Number(r.readers) || 0, answers: Number(r.answers) || 0, seeds, failed_seeds: (r.failed_seeds ?? []).map(Number).slice(0, 50), ms: Date.now() - t0 };
    appendJsonl(FILE(root), p);
    beat(root, "slice_proof", p.leaks ? { ok: false, error: `${sliceProofLine(p)}: this version gave an assistant something its rules keep from it, on made-up memories (seeds ${p.failed_seeds.slice(0, 5).join(", ")})`, ms: p.ms } : { ok: true, ms: p.ms });
    return `slice check: ${sliceProofLine(p)} (${p.answers.toLocaleString("en-US")} answers read)`;
  } catch (e) { return fail((e as Error).message); }
  finally { running = false; }
}
