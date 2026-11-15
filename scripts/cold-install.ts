// SPDX-License-Identifier: AGPL-3.0-only
// The first ten minutes, from cold (plans/close-three-gaps S1; docs/install-with-an-agent.md). On a
// clean home folder, as a stranger or their assistant would: the installer against a local mirror
// of this checkout (no network to our site), `init`, `start`, two apps on this computer connected
// through the stdio bridge, then the story a new owner lives:
//   1. the owner tells the box two things (POST /say, signed in as `pocketbrain open` would be);
//   2. assistant A asks and answers from them; assistant B asks and gets only its own cut;
//   3. A sends the `remember` a real model sends first (no as_of, no area): refused with its fix,
//      then saved, and the owner's home shows it as "Not confirmed" while no assistant reads it.
// It prints one timed line: clean machine to a second assistant answering. Exit 1 at the first
// step that fails, naming it. Never the real brain, never this machine's Claude Code: everything
// lives in a temp folder, `claude` is a fake that logs its arguments, and the hub listens on its
// own ports (never 8787), so a hub already running here is left alone.
//   bun scripts/cold-install.ts [--ref <commit>] [--repo <dir>] [--keep] [--json]
// --ref defaults to this checkout's HEAD: commit first, the installer clones what git has.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const APP = join(import.meta.dir, "..");
const PORT = 18787, DASH = 18788;
// This computer only, plain http as every local check in this repo (scripts/e2e.ts).
// The hub is up when its /health answers; the url is a parameter so the loopback address is built once.
const answers = (base: string) => fetch(`${base}/health`).then((r) => r.ok, () => false);
const HUB = `http://127.0.0.1:${PORT}`, DASHBOARD = `http://127.0.0.1:${DASH}`;
const OWNER = "Sam Rivera";
// The second is a role: what assistant B's names-and-roles cut is given, where the first is not.
const TOLD = ["I prefer short answers", "My role is head of design"];
type Res = { code: number; out: string; stdout: string };

export interface ColdRun { ok: boolean; failed?: string; why?: string; commit: string; seconds: Record<string, number>; total?: number; line: string }

function arg(args: string[], name: string): string | undefined { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

export async function coldInstall(o: { repo?: string; ref?: string; keep?: boolean; log?: (s: string) => void } = {}): Promise<ColdRun> {
  const repo = o.repo ?? APP;
  const log = o.log ?? (() => {});
  const ref = o.ref ?? Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim();
  const commit = Bun.spawnSync(["git", "rev-parse", "--short", `${ref}^{commit}`], { cwd: repo }).stdout.toString().trim() || ref;
  const base = mkdtempSync(join(tmpdir(), "pb-cold-"));
  const home = join(base, "home"), brain = join(home, "my-brain"), bin = join(base, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  // A fake `claude`: init's connect runs `claude mcp add`, which must never reach a real one.
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$@" >> "${join(base, "claude-calls")}"\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const bunDir = dirname(process.execPath);
  // A clean environment: none of this shell's pocketBrain settings, HOME the empty folder, and the
  // pocketbrain command where the installer puts it ($HOME/.bun/bin), as its last line says.
  const env: Record<string, string> = { HOME: home, PATH: [bin, join(home, ".bun", "bin"), bunDir, "/usr/local/bin", "/usr/bin", "/bin"].join(":"), TMPDIR: base, LANG: "C.UTF-8" };
  for (const k of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "BUN_CONFIG_REGISTRY", "NPM_CONFIG_REGISTRY"]) if (process.env[k]) env[k] = process.env[k]!;
  const run = (cmd: string[], extra: Record<string, string> = {}): Res => {
    const r = Bun.spawnSync(cmd, { cwd: home, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode ?? 1, out: `${r.stdout}${r.stderr}`, stdout: `${r.stdout}` };
  };
  const seconds: Record<string, number> = {};
  const t0 = performance.now();
  let hub: ReturnType<typeof Bun.spawn> | undefined;
  const result = (failed?: string, why?: string): ColdRun => {
    const total = Math.round((performance.now() - t0) / 100) / 10;
    const line = failed
      ? `cold install FAILED at ${failed} (${commit}): ${why}`
      : `cold install (${commit}, ${new Date().toISOString().slice(0, 10)}): clean machine to a second assistant answering in ${seconds.second_answer} s; first save shown as Not confirmed; ${total} s in all`;
    return { ok: !failed, ...(failed ? { failed, why } : {}), commit, seconds, ...(failed ? {} : { total }), line };
  };
  const step = async <T>(name: string, f: () => T | Promise<T>): Promise<T> => {
    const t = performance.now();
    const v = await f();
    seconds[name] = Math.round((performance.now() - t) / 100) / 10;
    log(`  ${name}: ${seconds[name]} s`);
    return v;
  };
  class Fail extends Error { constructor(public at: string, why: string) { super(why); } }
  const must = (at: string, ok: unknown, why: string) => { if (!ok) throw new Fail(at, why); };
  try {
    // ---------- the machine part ----------
    await step("install", () => {
      const r = run(["sh", join(repo, "install.sh")], { POCKETBRAIN_REPO: repo, POCKETBRAIN_REF: ref });
      must("install", r.code === 0, r.out.trim().split("\n").slice(-3).join(" / "));
    });
    await step("init", () => {
      const r = run(["pocketbrain", "init", brain, "--name", OWNER, "--kind", "claude-code", "--write"]);
      must("init", r.code === 0, r.out.trim().split("\n").slice(-3).join(" / "));
      must("init", existsSync(join(base, "claude-calls")) && readFileSync(join(base, "claude-calls"), "utf8").includes("mcp add"), "init didn't connect Claude Code (no claude mcp add)");
      // init ends on one line: where the memory is and the first thing to tell it.
      const last = r.stdout.trim().split("\n").at(-1) ?? "";
      must("init", /pocketbrain open[\s\S]*three things/.test(last), `init's last line doesn't say to open the memory and tell it three things: ${last}`);
    });
    await step("start", async () => {
      hub = Bun.spawn(["pocketbrain", "start", "--port", String(PORT), "--dashboard-port", String(DASH)], { cwd: home, env, stdout: "ignore", stderr: "ignore" });
      for (let i = 0; i < 120; i++) {
        if (await answers(HUB)) return;
        await Bun.sleep(250);
      }
      must("start", false, "the hub didn't answer /health in 30 s");
    });
    // Assistant B: a second app on this computer, given only names and roles (contacts-basic).
    await step("connect_b", () => {
      const r = run(["pocketbrain", "add", "cursor", "--kind", "cursor", "--slices", "contacts-basic", "--write", "--yes"]);
      must("connect_b", r.code === 0, r.out.trim().split("\n").slice(-3).join(" / "));
    });

    // ---------- the owner's box ----------
    const dash = await step("sign_in", async () => {
      const file = join(brain, ".git", "pb-dashboard-login");
      for (let i = 0; i < 40 && !existsSync(file); i++) await Bun.sleep(250);
      must("sign_in", existsSync(file), "the hub kept no sign-in link");
      const link = String((JSON.parse(readFileSync(file, "utf8")) as { local?: string }).local ?? "");
      const r = await fetch(link, { redirect: "manual" });
      const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
      must("sign_in", cookie, `signing in gave no session (${r.status})`);
      const page = async (path: string, init: RequestInit = {}) => { const x = await fetch(DASHBOARD + path, { redirect: "follow", ...init, headers: { cookie, ...(init.headers ?? {}) } }); return { status: x.status, html: await x.text() }; };
      const home_ = await page("/home");
      must("sign_in", home_.status === 200, `the home answered ${home_.status}`);
      must("sign_in", /three things/.test(home_.html), "the new owner's home doesn't say to tell the memory three things");
      return { page, csrf: home_.html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "" };
    });
    await step("owner_tells", async () => {
      for (const q of TOLD) {
        const r = await dash.page("/say", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: dash.csrf, q }) });
        must("owner_tells", r.status === 200 && /Noted/.test(r.html), `the box didn't note "${q}" (${r.status})`);
      }
    });

    // ---------- two assistants ask ----------
    const a = mcp(["pocketbrain", "mcp", "--agent", "claude", "--url", HUB], home, env);
    const b = mcp(["pocketbrain", "mcp", "--agent", "cursor", "--url", HUB], home, env);
    try {
      const ask = (c: Mcp) => c.call("context_pack", { topic: OWNER });
      await step("first_answer", async () => {
        const t = await ask(a);
        must("first_answer", /short answers/.test(t) && /head of design/.test(t), `assistant A's pack doesn't hold what the owner said: ${t.slice(0, 1500)}`);
      });
      await step("second_answer_b", async () => {
        const t = await ask(b);
        must("second_answer_b", /head of design/.test(t), `assistant B's pack doesn't hold the role its cut gives it: ${t.slice(0, 1500)}`);
        must("second_answer_b", !/short answers/.test(t), "assistant B was given a fact outside its cut");
      });
      seconds.second_answer = Math.round((performance.now() - t0) / 100) / 10;

      // ---------- the first save a real model sends ----------
      await step("first_save", async () => {
        const first = await a.call("remember", { type: "person", title: OWNER, attribute: "based_in", value: "Lisbon", sources: ["agent:claude"] });
        must("first_save", /"refused"/.test(first) && /Fix:/.test(first), `a save with no date wasn't refused with its fix: ${first.slice(0, 300)}`);
        // Dated as the assistant is told to date it: by the brain's clock, which its pack gives.
        const day = (await ask(a)).match(/Today is (\d{4}-\d{2}-\d{2}) on the brain's clock/)?.[1];
        must("first_save", day, "the pack doesn't say the brain's day");
        const again = await a.call("remember", { type: "person", title: OWNER, attribute: "based_in", value: "Lisbon", as_of: day, sources: ["agent:claude"] });
        must("first_save", /"inbox"/.test(again), `the dated save didn't land: ${again.slice(0, 300)}`);
        const h = await dash.page("/home");
        must("first_save", /Not confirmed/.test(h.html) && /Lisbon/.test(h.html), "the owner's home doesn't show the assistant's save as Not confirmed");
        // A guess makes nothing true for anyone: neither assistant reads it.
        for (const c of [a, b]) must("first_save", !/Lisbon/.test(await ask(c)), "an unconfirmed save reached an assistant");
      });
    } finally { a.close(); b.close(); }
    return result();
  } catch (e) {
    if (e instanceof Fail) return result(e.at, e.message);
    return result("rig", (e as Error).message);
  } finally {
    hub?.kill();
    await hub?.exited;
    if (!o.keep) rmSync(base, { recursive: true, force: true });
    else log(`kept: ${base}`);
  }
}

// ---------- a stdio MCP client, as an app on this computer runs the bridge ----------
interface Mcp { call(tool: string, args: Record<string, unknown>): Promise<string>; close(): void }
function mcp(cmd: string[], cwd: string, env: Record<string, string>): Mcp {
  const p = Bun.spawn(cmd, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const waiting = new Map<number, (v: unknown) => void>();
  let id = 0, buf = "";
  (async () => {
    const dec = new TextDecoder();
    for await (const chunk of p.stdout as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      for (let i; (i = buf.indexOf("\n")) >= 0;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { const m = JSON.parse(line) as { id?: number }; if (m.id !== undefined) waiting.get(m.id)?.(m); } catch { /* not ours */ }
      }
    }
  })();
  const send = (m: unknown) => { p.stdin.write(`${JSON.stringify(m)}\n`); p.stdin.flush(); };
  const request = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => reject(new Error(`no answer to ${method} in 30 s`)), 30_000);
    waiting.set(n, (v) => { clearTimeout(timer); resolve(v); });
    send({ jsonrpc: "2.0", id: n, method, params });
  });
  const ready = request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cold-install", version: "1" } }).then(() => send({ jsonrpc: "2.0", method: "notifications/initialized" }));
  return {
    async call(tool, args) {
      await ready;
      const m = await request("tools/call", { name: tool, arguments: args }) as { result?: { content?: { text?: string }[] }; error?: { message?: string } };
      return m.result?.content?.map((c) => c.text ?? "").join("\n") ?? `error: ${m.error?.message ?? "no answer"}`;
    },
    close() { try { p.stdin.end(); } catch { /* gone */ } p.kill(); },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const r = await coldInstall({ repo: arg(args, "--repo"), ref: arg(args, "--ref"), keep: args.includes("--keep"), log: json ? undefined : (s) => console.log(s) });
  console.log(json ? JSON.stringify(r) : r.line);
  process.exit(r.ok ? 0 : 1);
}
