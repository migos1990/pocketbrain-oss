// SPDX-License-Identifier: AGPL-3.0-only
// Backlog row 284: every error the owner can hit says what happened and the one command or click
// that fixes it. One catalog (src/owner-errors.ts), one snapshot of it (docs/owner-errors.md), and
// checks that each surface (dashboard, CLI, doctor, consent, installer) speaks only from it.
import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeBrain } from "./fixture";
import { OWNER_ERRORS, ownerError, ownerErrorHtml, renderCatalog, type OwnerError, type OwnerErrorId } from "../src/owner-errors";
import { dashboardHandler } from "../src/dashboard/server";
import { esc as escHtml } from "../src/dashboard/html";
import { doctor } from "../src/doctor";
import { propose } from "../src/consent";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const entries = Object.entries(OWNER_ERRORS) as [OwnerErrorId, OwnerError][];

test("docs/owner-errors.md lists every owner-facing error with its fix (snapshot)", () => {
  const file = join(ROOT, "docs", "owner-errors.md");
  if (process.env.PB_ERRORS_UPDATE) writeFileSync(file, renderCatalog());
  expect(existsSync(file) ? readFileSync(file, "utf8") : "").toBe(renderCatalog());
});

test("every fix names a real command, dashboard page or doc", () => {
  const usage = Bun.spawnSync(["bun", "src/cli.ts", "help", "--all"], { cwd: ROOT }).stdout.toString();
  const commands = new Set([...usage.matchAll(/^\s{2}([a-z][a-z-]*)\b/gm)].map((m) => m[1]));
  const server = read("src/dashboard/server.ts");
  const problems: string[] = [];
  for (const [id, e] of entries) {
    const f = e.fix as Record<string, unknown>;
    const words = [f.run, f.first, f.then].filter((x): x is string => typeof x === "string").join(" ");
    for (const m of words.matchAll(/pocketbrain ([a-z][a-z-]*)/g)) if (m[1] !== "help" && !commands.has(m[1])) problems.push(`${id}: no command pocketbrain ${m[1]}`);
    if (typeof f.path === "string" && !server.includes(`p === "${f.path}"`)) problems.push(`${id}: no dashboard page ${f.path}`);
    if (typeof f.read === "string" && !existsSync(join(ROOT, f.read))) problems.push(`${id}: no doc ${f.read}`);
    if (/[.]$/.test(e.what) || /[.]$/.test(String(f.then ?? ""))) problems.push(`${id}: ends with its own period`);
  }
  expect(problems).toEqual([]);
});

test("each line says what happened, then Fix:, and a missing value is a bug, not a blank", () => {
  expect(ownerError("doctor.server-down", { port: 8787 })).toBe("Nothing answers on 127.0.0.1:8787. Fix: run pocketbrain menubar restart, or pocketbrain start on a machine without launchd.");
  expect(ownerError("doctor.gardener-paused", { agent: "g", why: "" })).toBe(`g is paused. Fix: click "Resume" on the Assistants page in the dashboard.`);
  expect(() => ownerError("doctor.server-down")).toThrow(/missing \{port\}/);
});

test("the dashboard's error pages come from the catalog", async () => {
  const root = makeBrain();
  const H = "127.0.0.1:8793";
  const d = dashboardHandler(root, { port: 8793, loginKey: "k".repeat(32) });
  const get = async (path: string, headers: Record<string, string> = {}) => { const r = await d.handle(new Request(`http://${H}${path}`, { headers: { host: H, ...headers } })); return { status: r.status, text: await r.text() }; };
  // Each is a page in the owner app's look, its words from the catalog (G621: they were bare text).
  const asPage = (id: Parameters<typeof ownerErrorHtml>[0]) => ownerErrorHtml(id, {}, escHtml);
  const host = await get("/", { host: "evil.example" });
  expect(host.status).toBe(421);
  expect(host.text).toContain(asPage("dash.host"));
  const key = await get("/login?key=nope");
  expect(key.status).toBe(403);
  expect(key.text).toContain(asPage("dash.login-key"));
  const out = await get("/overview");
  expect(out.status).toBe(401);
  expect(out.text).toContain(asPage("dash.signed-out"));
  const cookie = (await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }))).headers.get("set-cookie")!.split(";")[0];
  const missing = await get("/no/such/page", { cookie });
  expect(missing.status).toBe(404);
  expect(missing.text).toContain(`<h1>There&#39;s no page at this address</h1><p>Open the dashboard's <a href="/">Home</a> page.</p>`);
  expect((await get("/agent/nobody", { cookie })).text).toContain("No assistant called nobody");
  const post = await d.handle(new Request(`http://${H}/x`, { method: "POST", body: new URLSearchParams({ csrf: "wrong" }), headers: { host: H, cookie, "content-type": "application/x-www-form-urlencoded" } }));
  expect(post.status).toBe(403);
  expect(await post.text()).toContain(asPage("dash.csrf"));
  // No error words typed straight into a response: each goes through the catalog.
  const src = read("src/dashboard/server.ts");
  expect(src.match(/\btext\(\s*["'`]/g) ?? []).toEqual([]);
  expect(src.match(/title: "(Not found|Gone|Can't add)"/g) ?? []).toEqual([]);
});

test("doctor: every warning and failure carries its fix, from the catalog", async () => {
  const root = makeBrain();
  const f = await doctor(root, { offline: true });
  const bad = f.filter((x) => x.level !== "ok");
  expect(bad.length).toBeGreaterThan(0);
  for (const x of bad) expect(x.text).toMatch(/\. Fix: .+\.$/);
  // In the source, a warn or FAIL is only ever raised by a catalog id.
  for (const file of ["src/doctor.ts", "src/backup.ts"]) {
    const loose = read(file).split("\n").filter((l) => /\badd\(("[^"]*", )?"(warn|FAIL)"|level: "(warn|FAIL)"(?! \|)/.test(l));
    expect({ file, loose }).toEqual({ file, loose: [] });
  }
});

test("failed consent says what to type instead", async () => {
  const root = makeBrain();
  await expect(propose(root, "helper", "   ")).rejects.toThrow(ownerError("consent.empty"));
  await expect(propose(root, "Bad Name", "handles errands")).rejects.toThrow(ownerError("consent.bad-name", { agent: "Bad Name" }));
});

test("the command line: no brain and an unknown command each name the fix", () => {
  const empty = mkdtempSync(join(tmpdir(), "nobrain-"));
  const env = { ...process.env, PB_CONFIG_DIR: join(empty, "cfg"), PB_BRAIN: "" };
  const none = Bun.spawnSync(["bun", join(ROOT, "src/cli.ts"), "digest"], { cwd: empty, env });
  expect(none.exitCode).toBe(1);
  expect(none.stderr.toString().trim()).toBe(ownerError("cli.no-brain", { dir: empty }));
  const unknown = Bun.spawnSync(["bun", join(ROOT, "src/cli.ts"), "frobnicate", "--brain", makeBrain()], { cwd: empty, env });
  expect(unknown.exitCode).toBe(2);
  expect(unknown.stderr.toString().trim()).toBe(ownerError("cli.unknown", { cmd: "frobnicate" }));
});

test("install.sh: every failure line is a catalog entry, and every entry is used", () => {
  const sh = read("install.sh");
  const lines = [...sh.matchAll(/fail "([^"]+)"/g)].map((m) => m[1]);
  const install = entries.filter(([, e]) => e.where === "install").map(([id]) => ownerError(id));
  expect(lines.sort()).toEqual(install.sort());
});
