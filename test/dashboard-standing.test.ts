// SPDX-License-Identifier: AGPL-3.0-only
// The dashboard's "Who matters" page (docs/standing.md): the owner approves or changes a suggested
// level in one click, adds people by hand, and nothing is applied without a click.
import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { brain, traffic } from "./standing-fixture";
import { dashboardHandler, flashOf } from "../src/dashboard/server";
import { loadStanding, suggestStanding } from "../src/standing";
import { git } from "../src/git";
import { digest } from "../src/digest";

const H = "127.0.0.1:8792";

function setup(standing?: Record<string, unknown>) {
  const root = brain(standing ?? { me: ["robin@example.com"], people: {} });
  const d = dashboardHandler(root, { port: 8792, loginKey: "k".repeat(32) });
  let cookie = "";
  const req = async (method: string, path: string, fields?: Record<string, string>, from = "/people") => {
    const body = fields ? new URLSearchParams(fields) : undefined;
    const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}${from}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
    const loc = r.headers.get("location") ?? "";
    return { status: r.status, text: await r.text(), loc, ...flashOf(loc) };
  };
  const login = async () => { const r = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } })); cookie = r.headers.get("set-cookie")!.split(";")[0]; };
  const csrf = async () => (await req("GET", "/people")).text.match(/name="csrf" value="([^"]+)"/)![1];
  const post = async (action: string, fields: Record<string, string> = {}) => req("POST", `/action/${action}`, { csrf: await csrf(), ...fields });
  return { root, req, post, login };
}
const standingFile = (root: string) => readFileSync(join(root, "rules", "standing.yaml"), "utf8");
// The forms on the page for one person, by their hidden person field.
const formsFor = (html: string, person: string) => [...html.matchAll(/<form[^>]*action="\/action\/([a-z-]+)"[^>]*>(.*?)<\/form>/gs)]
  .filter((m) => m[2].includes(`name="person" value="${person}"`)).map((m) => ({ action: m[1], html: m[2] }));

test("the page lists suggestions with the reason and one Approve per person; opening it changes nothing", async () => {
  const { root, req, login } = setup();
  traffic(root, "Sam <sam@example.com>", 20, 20, 10);
  traffic(root, "jane@northfield.example", 3, 2, 600);
  traffic(root, "stranger@spam.example", 30, 0);
  await login();
  const before = standingFile(root);
  const head = git(root, ["rev-parse", "HEAD"]);
  const r = await req("GET", "/people");
  expect(r.status).toBe(200);
  expect(r.text).toContain("Sam Roy");
  expect(r.text).toContain("20 from them, 20 from you");
  expect(r.text).toContain("Jane Roy");
  expect(r.text).not.toContain("stranger@spam.example"); // only people with a note, matched by trusted address
  const sam = formsFor(r.text, "people/sam-roy");
  // One click applies exactly what was suggested.
  expect(sam.find((f) => f.action === "standing-approve")?.html).toContain("Make close");
  // The level picker never starts on inner circle: only the owner names family.
  const pick = sam.find((f) => f.action === "standing-set")!.html;
  expect(pick).toMatch(/<option value="close" selected>/);
  expect(pick).not.toMatch(/value="inner" selected/);
  expect(r.text).not.toContain("suggested: inner");
  // Nothing applied by looking.
  expect(standingFile(root)).toBe(before);
  expect(git(root, ["rev-parse", "HEAD"])).toBe(head);
});

test("Approve is one owner commit with the suggested level, and the suggestion is gone", async () => {
  const { root, post, req, login } = setup();
  traffic(root, "Sam <sam@example.com>", 20, 20, 10);
  await login();
  const r = await post("standing-approve", { person: "people/sam-roy" });
  expect(r.err).toBe("");
  expect(r.ok).toBe("Sam Roy is now close.");
  expect(r.loc.startsWith("/people?")).toBe(true);
  expect(loadStanding(root).people["people/sam-roy"]).toMatchObject({ tier: "close", addresses: ["sam@example.com"] });
  expect(git(root, ["log", "-1", "--format=%an|%s"])).toBe("Robin|owner: standing people/sam-roy close");
  expect(suggestStanding(root)).toEqual([]);
  // Now listed under the people the owner placed, not as a suggestion.
  const page = (await req("GET", "/people")).text;
  expect(formsFor(page, "people/sam-roy").some((f) => f.action === "standing-approve")).toBe(false);
  expect(formsFor(page, "people/sam-roy").some((f) => f.action === "standing-set")).toBe(true);
});

test("Approve of something not suggested any more is refused, not applied", async () => {
  const { root, post, login } = setup();
  await login();
  const r = await post("standing-approve", { person: "people/sam-roy" });
  expect(r.err).toContain("no suggestion");
  expect(loadStanding(root).people).toEqual({});
});

test("the owner picks another level, inner circle included, with authority, from the same row", async () => {
  const { root, post, login } = setup();
  traffic(root, "Sam <sam@example.com>", 20, 20, 10);
  await login();
  const r = await post("standing-set", { person: "people/sam-roy", tier: "inner", authority: "them" });
  expect(r.ok).toBe("Sam Roy is now inner circle, with authority over you.");
  expect(loadStanding(root).people["people/sam-roy"]).toMatchObject({ tier: "inner", authority: "them", addresses: ["sam@example.com"] });
  // Change it again, then take them off the list.
  expect((await post("standing-set", { person: "people/sam-roy", tier: "known", authority: "none" })).ok).toBe("Sam Roy is now known.");
  expect(loadStanding(root).people["people/sam-roy"].authority).toBeUndefined();
  expect((await post("standing-set", { person: "people/sam-roy", tier: "none" })).ok).toBe("Sam Roy has no standing now.");
  expect(loadStanding(root).people["people/sam-roy"]).toBeUndefined();
});

test("Add someone sets a person nobody suggested; only person notes, only real levels", async () => {
  const { root, post, req, login } = setup();
  await login();
  const page = (await req("GET", "/people")).text;
  // The picker lists person notes not yet placed.
  expect(page).toMatch(/<option value="people\/sam-roy">Sam Roy<\/option>/);
  expect((await post("standing-set", { person: "people/sam-roy", tier: "inner" })).ok).toBe("Sam Roy is now inner circle.");
  expect((await post("standing-set", { person: "projects/course-a", tier: "inner" })).err).toContain("no person note");
  expect((await post("standing-set", { person: "people/jane-roy", tier: "boss" })).err).toContain("tier must be");
  expect((await post("standing-set", { person: "people/jane-roy", tier: "known", authority: "god" })).err).toContain("authority is");
  expect(loadStanding(root).people["people/jane-roy"]).toBeUndefined();
});

test("Not now hides a suggestion until the signals call for a higher level", async () => {
  const { root, post, login } = setup();
  traffic(root, "jane@northfield.example", 3, 2, 600);
  await login();
  expect(suggestStanding(root).map((x) => x.person)).toEqual(["people/jane-roy"]);
  const r = await post("standing-dismiss", { person: "people/jane-roy" });
  expect(r.ok).toBe("Jane Roy won't be suggested as known again.");
  expect(suggestStanding(root)).toEqual([]);
  expect(digest(root).text).not.toContain("[standing]");
  expect(loadStanding(root).people).toEqual({}); // nothing written to rules/
  expect(git(root, ["status", "--porcelain", "--ignored=no", "log/standing"])).toBe(""); // kept with the local traffic log, never committed
  // Much more traffic, answered fast: now close is suggested.
  traffic(root, "jane@northfield.example", 20, 20, 10);
  expect(suggestStanding(root).map((x) => [x.person, x.tier])).toEqual([["people/jane-roy", "close"]]);
});

test("pinning a source-verified address is a button with a confirm, and only for addresses on the note", async () => {
  const { root, post, req, login } = setup({ me: ["robin@example.com"], people: { "people/sam-roy": { tier: "inner", addresses: ["sam@example.com"] } } });
  await login();
  const page = (await req("GET", "/people")).text;
  const pin = formsFor(page, "people/sam-roy").find((f) => f.action === "standing-pin" && f.html.includes("sam.new@example.com"));
  expect(pin).toBeDefined();
  expect(page).toMatch(/data-confirm="[^"]*sam\.new@example\.com/);
  expect(page).not.toContain("sam.claimed@example.com"); // a self-reported address is never offered
  expect((await post("standing-pin", { person: "people/sam-roy", address: "sam.claimed@example.com" })).err).toContain("not a confirmed or source-verified address");
  expect((await post("standing-pin", { person: "people/sam-roy", address: "sam.new@example.com" })).ok).toBe("Pinned sam.new@example.com for Sam Roy.");
  expect(loadStanding(root).people["people/sam-roy"]).toMatchObject({ tier: "inner", addresses: ["sam.new@example.com", "sam@example.com"] });
});

test("every standing button needs the session's CSRF token", async () => {
  const { root, req, login } = setup();
  traffic(root, "Sam <sam@example.com>", 20, 20, 10);
  await login();
  for (const [action, f] of [["standing-approve", { person: "people/sam-roy" }], ["standing-set", { person: "people/sam-roy", tier: "inner" }], ["standing-dismiss", { person: "people/sam-roy" }]] as const) {
    const r = await req("POST", `/action/${action}`, f);
    expect(r.status).toBe(403);
  }
  expect(loadStanding(root).people).toEqual({});
});

test("on a replica the buttons say where standing is set, and write nothing", async () => {
  const { root, post, login } = setup();
  writeFileSync(join(root, "rules", "hub.yaml"), YAML.stringify({ hub: "mini", epoch: 1, replicas: { mini: {}, laptop: {} } }));
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "commit", "-q", "-m", "hub"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
  Bun.spawnSync(["git", "config", "--local", "pocketbrain.replica", "laptop"], { cwd: root });
  await login();
  const before = standingFile(root);
  const r = await post("standing-set", { person: "people/sam-roy", tier: "inner" });
  expect(r.err).toContain("standing is set on the hub");
  expect(standingFile(root)).toBe(before);
});

test("the overview says when suggestions wait, and the tab is there", async () => {
  const { root, req, login } = setup();
  await login();
  expect((await req("GET", "/overview")).text).not.toContain("standing suggestion");
  traffic(root, "Sam <sam@example.com>", 20, 20, 10);
  traffic(root, "jane@northfield.example", 3, 2, 600);
  const home = (await req("GET", "/overview")).text;
  expect(home).toContain("2 standing suggestions");
  expect(home).toContain('href="/people"');
});

// ---------- review findings ----------

test("a click applies only the level that was on screen: if the signals moved, it is refused", async () => {
  const { root, post, req, login } = setup();
  traffic(root, "jane@northfield.example", 3, 2, 600);
  await login();
  const shown = formsFor((await req("GET", "/people")).text, "people/jane-roy").find((f) => f.action === "standing-approve")!.html;
  expect(shown).toContain('name="tier" value="known"');
  traffic(root, "jane@northfield.example", 20, 20, 10); // a pull lands between the page and the click
  const r = await post("standing-approve", { person: "people/jane-roy", tier: "known" });
  expect(r.err).toContain("changed to close since you looked");
  expect((await post("standing-dismiss", { person: "people/jane-roy", tier: "known" })).err).toContain("changed to close");
  expect(loadStanding(root).people).toEqual({});
  expect(suggestStanding(root).map((x) => x.tier)).toEqual(["close"]);
});

test("Not now on a close suggestion hides it until Suggest again, or until the note is replaced", async () => {
  const { root, post, req, login } = setup();
  traffic(root, "Sam <sam@example.com>", 20, 20, 10);
  await login();
  expect((await post("standing-dismiss", { person: "people/sam-roy", tier: "close" })).ok).toBe("Sam Roy won't be suggested again. Suggest again brings them back.");
  expect(suggestStanding(root)).toEqual([]);
  const page = (await req("GET", "/people")).text;
  expect(formsFor(page, "people/sam-roy").some((f) => f.action === "standing-undismiss")).toBe(true);
  expect((await post("standing-undismiss", { person: "people/sam-roy" })).ok).toBe("Sam Roy can be suggested again.");
  expect(suggestStanding(root).map((x) => x.person)).toEqual(["people/sam-roy"]);
  // A newer note under the same id is a different person: the old dismissal doesn't hide it.
  await post("standing-dismiss", { person: "people/sam-roy", tier: "close" });
  const f = join(root, "people", "sam-roy.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("created: 2026-10-01", "created: 2026-10-09"));
  expect(suggestStanding(root).map((x) => x.person)).toEqual(["people/sam-roy"]);
});

test("a suggestion says which addresses it counted and that a source-only one isn't the owner's word", async () => {
  const { root, req, login } = setup();
  // Jane's address on the note came from a mail, not from the owner (an agent could have written it).
  traffic(root, "jane@northfield.example", 3, 2, 600);
  traffic(root, "Sam <sam@example.com>", 20, 20, 10);
  await login();
  const page = (await req("GET", "/people")).text;
  expect(page).toContain("jane@northfield.example <span class=\"sub\">(from a source only, not confirmed by you)</span>");
  expect(page).toContain("sam@example.com <span class=\"sub\">(you confirmed it)</span>");
});

test("Not now on a replica writes nothing either", async () => {
  const { root, post, login } = setup();
  traffic(root, "jane@northfield.example", 3, 2, 600);
  writeFileSync(join(root, "rules", "hub.yaml"), YAML.stringify({ hub: "mini", epoch: 1, replicas: { mini: {}, laptop: {} } }));
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "commit", "-q", "-m", "hub"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
  Bun.spawnSync(["git", "config", "--local", "pocketbrain.replica", "laptop"], { cwd: root });
  await login();
  expect((await post("standing-dismiss", { person: "people/jane-roy", tier: "known" })).err).toContain("standing is set on the hub");
  expect(existsSync(join(root, "log", "standing", "dismissed.json"))).toBe(false);
});

test("a broken standing file shows as one line on the overview, not a broken page", async () => {
  const { root, req, login } = setup();
  await login();
  writeFileSync(join(root, "rules", "standing.yaml"), "people: [unclosed\n");
  const r = await req("GET", "/overview");
  expect(r.status).toBe(200);
  expect(r.text).toContain("Can't read your standing list");
});

test("titles and addresses are escaped on the page", async () => {
  const { root, req, login } = setup();
  const f = join(root, "people", "sam-roy.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("title: Sam Roy", `title: "<script>alert(1)</script>"`));
  traffic(root, "Sam <sam@example.com>", 20, 20, 10);
  await login();
  const page = (await req("GET", "/people")).text;
  expect(page).not.toContain("<script>alert(1)");
  expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("a broken standing file never takes the hub down: everyone counts as unknown, and the owner is told", async () => {
  const { root, post, login } = setup({ me: ["robin@example.com"], people: { "people/sam-roy": { tier: "inner", addresses: ["sam@example.com"] } } });
  writeFileSync(join(root, "rules", "standing.yaml"), "people: [unclosed\n");
  const { whoIs } = await import("../src/core");
  expect(whoIs(root, "steward", "sam@example.com").standing.tier).not.toBe("inner");
  expect(digest(root).text).toContain("rules/standing.yaml doesn't parse");
  await login();
  expect((await post("standing-set", { person: "people/sam-roy", tier: "close" })).err).toContain("fix it by hand first");
  expect(readFileSync(join(root, "rules", "standing.yaml"), "utf8")).toBe("people: [unclosed\n"); // never written over
});
