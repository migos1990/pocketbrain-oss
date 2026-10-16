// SPDX-License-Identifier: AGPL-3.0-only
// The browser door (/b): for assistants that can't send headers but can fill a sign-in form
// from their own password vault. Same token, same slice, fewer routes.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken, revokeTokens } from "../src/auth";
import { tunnelConfig } from "../src/hub";
import { main } from "../src/cli";
import { git } from "../src/git";
import YAML from "yaml";
import { loadBrain, saveNote } from "../src/brain";
import * as ms from "../src/memsync";

const policy = (root: string) => join(root, "rules/policy.yaml");
function allowBrowser(root: string, agent: string, extra = "") {
  const p = policy(root);
  writeFileSync(p, readFileSync(p, "utf8").replace(new RegExp(`^  ${agent}: \\{ `, "m"), `  ${agent}: { browser: true, ${extra}`));
}

function setup(opts: { allow?: string[] } = {}) {
  const root = makeBrain();
  for (const a of opts.allow ?? ["steward", "helper"]) allowBrowser(root, a);
  const tok = { steward: issueToken(root, "steward"), helper: issueToken(root, "helper"), planner: issueToken(root, "planner") };
  const req = async (method: string, path: string, o: { cookie?: string; form?: Record<string, string>; headers?: Record<string, string> } = {}) => {
    const res = await handle(root, new Request(`http://pb${path}`, {
      method, redirect: "manual",
      body: o.form ? new URLSearchParams(o.form).toString() : undefined,
      headers: { ...(o.form ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers },
    }));
    return { status: res.status, headers: res.headers, text: await res.text() };
  };
  const login = async (agent: keyof typeof tok) => {
    const r = await req("POST", "/b/login", { form: { agent, password: tok[agent] } });
    const cookie = r.headers.get("set-cookie")?.split(";")[0];
    return { ...r, cookie };
  };
  const csrf = (html: string) => html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
  return { root, tok, req, login, csrf };
}

test("the sign-in page shows a vault-fillable form and nothing from the brain", async () => {
  const { req } = setup();
  const r = await req("GET", "/b");
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("text/html");
  expect(r.text).toContain('type="password"');
  expect(r.text).toContain('autocomplete="current-password"');
  expect(r.text).not.toContain("Maple Trust");
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
});

test("signing in sets a strict session cookie; a bad token or a token in the URL gets nothing", async () => {
  const { req, login } = setup();
  const ok = await login("steward");
  expect(ok.status).toBe(303);
  const set = ok.headers.get("set-cookie")!;
  for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/b"]) expect(set).toContain(flag);
  const bad = await req("POST", "/b/login", { form: { agent: "steward", password: "pb_steward_nope" } });
  expect(bad.status).toBe(401);
  expect(bad.headers.get("set-cookie")).toBeNull();
  expect((await req("GET", `/b/login?password=x`)).status).toBe(405);
});

test("the door is off for an agent unless policy.yaml says browser: true", async () => {
  const { login } = setup();
  const r = await login("planner");
  expect(r.status).toBe(401);
  expect(r.cookie).toBeUndefined();
});

test("a session reads only its own slice, escaped, and the cookie opens nothing outside /b", async () => {
  const { req, login } = setup();
  const s = (await login("steward")).cookie!;
  const h = (await login("helper")).cookie!;
  expect((await req("GET", "/b/search?q=bank", { cookie: s })).text).toContain("money%2Fmain-bank");
  const hs = await req("GET", "/b/search?q=maple", { cookie: h });
  expect(hs.status).toBe(200);
  expect(hs.text).not.toContain("Maple Trust");
  const hidden = await req("GET", "/b/notes/money%2Fmain-bank", { cookie: h });
  expect(hidden.status).toBe(404);
  expect((await req("GET", "/b/notes/money%2Fmain-bank", { cookie: s })).text).toContain("Maple Trust Bank");
  const ctx = await req("GET", "/b/context?topic=course", { cookie: h });
  expect(ctx.status).toBe(200);
  expect(ctx.text).toContain("Course A");
  expect((await req("GET", "/b/orientation", { cookie: h })).text).toContain("helper");
  expect((await req("GET", "/b/changes", { cookie: h })).status).toBe(200);
  // The cookie is not a bearer token anywhere else.
  expect((await req("GET", "/v1/context", { cookie: s })).status).toBe(401);
  expect((await req("GET", "/v1/owner/texts", { cookie: s })).status).toBe(401);
  // Resolver and owner routes don't exist on this door.
  expect((await req("GET", "/b/disputes", { cookie: s })).status).toBe(404);
});

test("note text is escaped, so a note can't put markup or script on the page", async () => {
  const { root, req, login } = setup();
  const f = join(root, "projects/course-a.md");
  writeFileSync(f, readFileSync(f, "utf8") + "\n<script>alert(1)</script>\n");
  const h = (await login("helper")).cookie!;
  const r = await req("GET", "/b/context?topic=course", { cookie: h });
  expect(r.text).not.toContain("<script>alert(1)</script>");
  expect(r.text).toContain("&lt;script&gt;");
});

test("revoking the token or pausing the agent ends its sessions on the next request", async () => {
  const { root, req, login } = setup();
  const s = (await login("steward")).cookie!;
  expect((await req("GET", "/b/search?q=bank", { cookie: s })).status).toBe(200);
  revokeTokens(root, "steward");
  const after = await req("GET", "/b/search?q=bank", { cookie: s });
  expect(after.status).toBe(401);
  expect(after.text).not.toContain("main-bank");

  const h = (await login("helper")).cookie!;
  const p = policy(root);
  writeFileSync(p, readFileSync(p, "utf8").replace("helper: { browser: true, ", "helper: { browser: true, status: paused, "));
  expect((await req("GET", "/b/search?q=course", { cookie: h })).status).toBe(403);
});

test("remember needs the session's form token; identity comes from the session, never the form", async () => {
  const { req, login, csrf } = setup();
  const h = (await login("helper")).cookie!;
  const home = await req("GET", "/b", { cookie: h });
  const t = csrf(home.text);
  expect(t.length).toBeGreaterThan(10);
  const form = { id: "projects/course-a", attribute: "room", value: "B-201", as_of: "2026-10-08", sources: "agent:helper", agent: "steward" };
  expect((await req("POST", "/b/remember", { cookie: h, form })).status).toBe(403);
  const r = await req("POST", "/b/remember", { cookie: h, form: { ...form, csrf: t } });
  expect(r.status).toBe(200);
  // helper is trial: its write is a proposal, which proves it was not written as steward.
  expect(r.text).toMatch(/inbox|refused/);
  expect(r.text).not.toContain("committed");
});

test("signing out ends the session", async () => {
  const { req, login, csrf } = setup();
  const h = (await login("helper")).cookie!;
  const t = csrf((await req("GET", "/b", { cookie: h })).text);
  expect((await req("POST", "/b/logout", { cookie: h, form: { csrf: t } })).status).toBe(303);
  expect((await req("GET", "/b/search?q=course", { cookie: h })).status).toBe(401);
});

test("the tunnel lets /b out and still keeps the dashboard in", () => {
  const re = new RegExp(tunnelConfig(makeBrain()).match(/path: (.*)/)![1]);
  for (const p of ["/b", "/b/", "/b/login", "/b/search", "/b/notes/projects%2Fcourse-a"]) expect(re.test(p)).toBe(true);
  for (const p of ["/", "/bx", "/dashboard", "/login"]) expect(re.test(p)).toBe(false);
});

test("connect --browser turns the door on for that agent only and prints just the key with --key-only", async () => {
  const root = makeBrain();
  const out: string[] = [], errs: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  console.error = (...a: unknown[]) => errs.push(a.join(" "));
  let code: number;
  try { code = main(["connect", "planner", "--browser", "--key-only", "--url", "https://brain.example", "--brain", root]); } finally { console.log = log; console.error = err; }
  expect(code).toBe(0);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatch(/^pb_planner_[A-Za-z0-9_-]+$/);
  expect(errs.join("\n")).toContain("https://brain.example/b");
  expect(errs.join("\n")).not.toContain(out[0]);
  const p = YAML.parse(readFileSync(policy(root), "utf8"));
  expect(p.agents.planner.browser).toBe(true);
  expect(p.agents.helper.browser).toBeUndefined();
  expect(git(root, ["log", "-1", "--format=%s", "--", "rules/policy.yaml"])).toContain("browser");
  const res = await handle(root, new Request("http://pb/b/login", { method: "POST", redirect: "manual", body: new URLSearchParams({ agent: "planner", password: out[0] }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } }));
  expect(res.status).toBe(303);
});

test("review: junk sign-ins from one client don't lock out another", async () => {
  const { req, tok } = setup();
  for (let i = 0; i < 25; i++) await req("POST", "/b/login", { form: { agent: "steward", password: `pb_steward_junk${i}` }, headers: { "cf-connecting-ip": "203.0.113.9" } });
  expect((await req("POST", "/b/login", { form: { agent: "steward", password: "pb_x" }, headers: { "cf-connecting-ip": "203.0.113.9" } })).status).toBe(429);
  const other = await req("POST", "/b/login", { form: { agent: "steward", password: tok.steward }, headers: { "cf-connecting-ip": "198.51.100.4" } });
  expect(other.status).toBe(303);
});

test("review: a malformed note id is a 404 page, not a 500", async () => {
  const { req, login } = setup();
  const s = (await login("steward")).cookie!;
  const r = await req("GET", "/b/notes/%E0", { cookie: s });
  expect(r.status).toBe(404);
  expect(r.headers.get("content-type")).toContain("text/html");
});

test("review: the agent field can't forge lines in the hub log", async () => {
  const { req, tok } = setup();
  const errs: string[] = [];
  const err = console.error;
  console.error = (...a: unknown[]) => errs.push(a.join(" "));
  try { await req("POST", "/b/login", { form: { agent: "x\nbrowser door: sign-in ok for steward", password: tok.steward } }); } finally { console.error = err; }
  expect(errs.join("|")).not.toContain("\n");
  expect(errs.join("|")).not.toContain("sign-in ok");
});

test("audit: a read-only agent reads but its remember is refused, with no inbox entry", async () => {
  const root = makeBrain();
  allowBrowser(root, "helper", "status: read-only, ");
  const tok = issueToken(root, "helper");
  const post = (path: string, form: Record<string, string>, cookie = "") => handle(root, new Request(`http://pb${path}`, { method: "POST", redirect: "manual", body: new URLSearchParams(form).toString(), headers: { "content-type": "application/x-www-form-urlencoded", cookie } }));
  const cookie = (await post("/b/login", { agent: "helper", password: tok })).headers.get("set-cookie")!.split(";")[0];
  const home = await (await handle(root, new Request("http://pb/b", { headers: { cookie } }))).text();
  expect((await handle(root, new Request("http://pb/b/context", { headers: { cookie } }))).status).toBe(200);
  const before = git(root, ["rev-list", "--count", "HEAD"]);
  const csrf = home.match(/name="csrf" value="([^"]+)"/)![1];
  const r = await (await post("/b/remember", { csrf, id: "projects/course-a", attribute: "room", value: "B-201", as_of: "2026-10-08", sources: "agent:helper" }, cookie)).text();
  expect(r).toContain("refused");
  expect(git(root, ["rev-list", "--count", "HEAD"])).toBe(before);
});

test("audit: a paused agent, or one outside its hours, can't sign in", async () => {
  const { root, req, tok } = setup();
  const p = policy(root);
  writeFileSync(p, readFileSync(p, "utf8").replace("helper: { browser: true, ", "helper: { browser: true, status: paused, "));
  const r = await req("POST", "/b/login", { form: { agent: "helper", password: tok.helper } });
  expect(r.status).not.toBe(303);
  expect(r.headers.get("set-cookie")).toBeNull();

  allowBrowser(root, "gardener");
  const g = issueToken(root, "gardener");
  process.env.PB_NOW = "2026-10-08T18:00:00Z"; // mid-afternoon in Toronto, outside its windows
  try {
    const out = await req("POST", "/b/login", { form: { agent: "gardener", password: g } });
    expect(out.status).toBe(401);
    expect(out.headers.get("set-cookie")).toBeNull();
  } finally { delete process.env.PB_NOW; }
});

test("audit: note text is escaped on search, note and changes pages too", async () => {
  const { root, req, login } = setup();
  const f = join(root, "projects/course-a.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("title: Course A", 'title: "Course A <script>x</script>"').replace("value: Grade the midterm", 'value: "Grade <script>y</script>"') + "\n<script>alert(1)</script>\n");
  git(root, ["commit", "-qam", "test: markup in projects/course-a#next_step"]);
  const h = (await login("helper")).cookie!;
  for (const p of ["/b/search?q=course", "/b/notes/projects%2Fcourse-a", "/b/changes?since=2026-01-01T00:00:00Z"]) {
    const r = await req("GET", p, { cookie: h });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("<script");
    expect(r.text).toContain("&lt;script&gt;");
  }
});

test("follow-up: /b/orientation tells the agent to save the browser instruction, not the API one", async () => {
  const { req, login } = setup();
  const h = (await login("helper")).cookie!;
  const r = await req("GET", "/b/orientation", { cookie: h });
  expect(r.status).toBe(200);
  expect(r.text).toContain("Save this in your own instructions");
  expect(r.text).toContain("http://pb/b");
  expect(r.text).not.toContain("GET /v1/orientation, then");
  expect(r.text).not.toContain("Authorization: Bearer");
});

test("a reader token keeps its personal cap on /b, and a resolver token can't sign in there (G25)", async () => {
  const { root, req } = setup();
  const signIn = async (password: string) => {
    const r = await req("POST", "/b/login", { form: { agent: "steward", password } });
    return { status: r.status, cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  const plain = await signIn(issueToken(root, "steward"));
  expect((await req("GET", "/b/notes/money%2Fmain-bank", { cookie: plain.cookie })).status).toBe(200);
  const reader = await signIn(issueToken(root, "steward", "reader"));
  expect(reader.status).toBe(303);
  const hidden = await req("GET", "/b/notes/money%2Fmain-bank", { cookie: reader.cookie });
  const missing = await req("GET", "/b/notes/money%2Fno-such-note", { cookie: reader.cookie });
  expect(hidden.status).toBe(404);
  expect(hidden.text).toBe(missing.text.replace("money/no-such-note", "money/main-bank"));
  expect((await req("GET", "/b/search?q=bank", { cookie: reader.cookie })).text).not.toContain("money/main-bank");
  const resolver = await signIn(issueToken(root, "steward", "resolver"));
  expect(resolver.status).toBe(401);
  expect(resolver.cookie).toBeUndefined();
});

test("G18: connect --browser gives a reader key", () => {
  const root = makeBrain();
  const log = console.log, err = console.error;
  console.log = () => {}; console.error = () => {};
  try { main(["connect", "steward", "--browser", "--key-only", "--brain", root]); } finally { console.log = log; console.error = err; }
  const t = YAML.parse(readFileSync(join(root, "rules/tokens.yaml"), "utf8"));
  expect(t.agents.steward).toHaveLength(1);
  expect(t.agents.steward[0].role).toBe("reader");
});

test("the remember form offers the hub's today as as_of, so an agent's clock running ahead isn't refused", async () => {
  const { req, login } = setup();
  const h = (await login("helper")).cookie!;
  const r = await req("GET", "/b/remember", { cookie: h });
  expect(r.text).toMatch(/name="as_of"[^>]*value="2026-10-08"/);
  expect(r.text).toContain("today here is 2026-10-08");
});

test("the door's tab shows the logo, with a light bar on dark tabs, and the CSP lets only that inline image in", async () => {
  const { req } = setup();
  const r = await req("GET", "/b");
  const href = decodeURIComponent(r.text.match(/<link rel="icon" href="([^"]+)"/)?.[1] ?? "");
  expect(href).toStartWith("data:image/svg+xml,");
  expect(href).toContain("@media (prefers-color-scheme:dark){.m{fill:#fff}}");
  expect(r.headers.get("content-security-policy")).toContain("img-src data:");
});

test("memory check on /b: a changed fact in the slice is listed with its pointer; the form confirms it and answers questions; another session's ids do nothing", async () => {
  const { root, req, login, csrf } = setup();
  const { cookie } = await login("helper");
  const first = await req("GET", "/b/memory-check", { cookie });
  expect(first.text).toContain("Nothing to do"); // the first check is the baseline
  const notes = loadBrain(root);
  const jane = notes.find((n) => n.fm.id === "people/jane-roy")!;
  const was = jane.fm.facts!.role as any;
  jane.fm.history = { role: [{ ...was }] };
  jane.fm.facts!.role = { ...was, value: "Program <b>director</b>", as_of: "2026-10-14" };
  saveNote(root, jane);
  const bank = notes.find((n) => n.fm.id === "money/main-bank")!;
  (bank.fm.facts![Object.keys(bank.fm.facts!)[0]] as any).value = "New Harbour Bank";
  saveNote(root, bank);

  const page = await req("GET", "/b/memory-check", { cookie });
  expect(page.text).toContain("Program &lt;b&gt;director&lt;/b&gt;"); // escaped
  expect(page.text).toContain("in pocketBrain (people/jane-roy)");
  expect(page.text).not.toContain("Harbour"); // withheld from helper
  const id = page.text.match(/name="changes_seen" value="([^"]+)"/)![1];
  expect((await req("POST", "/b/memory-check", { cookie, form: { csrf: "nope", changes_seen: id } })).status).toBe(403);

  const sent = await req("POST", "/b/memory-check", { cookie, form: { csrf: csrf(page.text), changes_seen: id } });
  expect(sent.text).toContain("up to date");
  const qid = sent.text.match(/name="a:([^"]+)"/)![1];
  const steward = await login("steward");
  await req("POST", "/b/memory-check", { cookie: steward.cookie, form: { csrf: csrf((await req("GET", "/b/memory-check", { cookie: steward.cookie })).text), [`a:${qid}`]: "Teaching assistant" } });
  expect(ms.state(root).quizzes.find((q) => q.id === qid)!.state).toBe("open"); // not steward's to answer
  await req("POST", "/b/memory-check", { cookie, form: { csrf: csrf(sent.text), [`a:${qid}`]: "in pocketBrain (people/jane-roy)" } });
  expect(ms.state(root).quizzes.find((q) => q.id === qid)!.verdict).toBe("in-sync");
});

test("What changed on /b says it starts at the last visit and can always look back 7 or 30 days, or show the ones past the first page", async () => {
  const { req, login } = setup();
  const { cookie } = await login("helper");
  await req("GET", "/b/changes", { cookie }); // the first visit moves the cursor
  const again = (await req("GET", "/b/changes", { cookie })).text;
  expect(again).toMatch(/since your last visit/i);
  const week = again.match(/href="(\/b\/changes\?since=[^"]+)">Last 7 days/)?.[1];
  expect(week).toBeDefined();
  expect(again).toMatch(/href="\/b\/changes\?since=[^"]+">Last 30 days/);
  expect((await req("GET", week!.replace(/&amp;/g, "&"), { cookie })).status).toBe(200);
});
