// SPDX-License-Identifier: AGPL-3.0-only
// The owner's home (phone UI spec §2.1, owner 2026-10-26): the box answers on the same page, the
// diary lines come from diary/*.jsonl with Undo, at most 7 since yesterday (least certain first) and
// the rest folded, a private line says only that something is new, and no tab bar.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { dashboardHandler, flashOf } from "../src/dashboard/server";
import { write } from "../src/write";
import { loadBrain, type FactRecord } from "../src/brain";
import { homeView, SINCE_CAP } from "../src/dashboard/home";
import { loadRules } from "../src/rules";
import { HOME_COPY, esc } from "../src/dashboard/html-home";
import { APP_COPY } from "../src/dashboard/html-app";

const H = "127.0.0.1:8792";
function setup() {
  const root = makeBrain();
  const d = dashboardHandler(root, { port: 8792, loginKey: "k".repeat(32) });
  let cookie = "";
  const req = async (method: string, path: string, fields?: Record<string, string>) => {
    const body = fields ? new URLSearchParams(fields) : undefined;
    const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/home`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
    return { status: r.status, text: await r.text(), loc: r.headers.get("location") ?? "" };
  };
  const login = async () => { const r = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } })); cookie = r.headers.get("set-cookie")!.split(";")[0]!; };
  const csrf = async () => (await req("GET", "/home")).text.match(/name="csrf" value="([^"]+)"/)![1]!;
  return { root, req, login, csrf };
}
const role = (root: string) => (loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts!.role as FactRecord).value;
const NOW = new Date("2026-10-08T15:00:00Z");

test("the home has the box, not the old tab bar, and a told fact comes back as Noted with Undo that works", async () => {
  process.env.PB_NOW = NOW.toISOString();
  const { root, req, login, csrf } = setup();
  await login();
  const page = await req("GET", "/home");
  expect(page.status).toBe(200);
  expect(page.text).toContain(esc(APP_COPY.box));
  expect(page.text).not.toContain('class="tabs"');
  expect(page.text).not.toMatch(/to decide/i);
  const said = await req("POST", "/say", { csrf: await csrf(), q: "Jane Roy's role is program director" });
  expect(said.status).toBe(200);
  expect(said.text).toContain("Noted: Jane Roy is program director now.");
  expect(role(root)).toBe("program director");
  expect(said.text).toContain("Jane is program director now, not Course coordinator.");
  const token = said.text.match(/name="token" value="([0-9a-f]{16})"/)![1]!;
  const undone = await req("POST", "/action/diary-undo", { csrf: await csrf(), token });
  expect(undone.status).toBe(303);
  expect(undone.loc).toStartWith("/home?ok=");
  expect(flashOf(undone.loc).ok).toStartWith("Undone");
  expect(role(root)).toBe("Course coordinator");
  const after = await req("GET", "/home");
  expect(after.text).toContain(HOME_COPY.undone);
  delete process.env.PB_NOW;
});

test("a question answers on the page and writes nothing", async () => {
  const { root, req, login, csrf } = setup();
  await login();
  const r = await req("POST", "/say", { csrf: await csrf(), q: "what is Jane Roy's role?" });
  expect(r.text).toContain("Jane Roy&#39;s role is Course coordinator.");
  expect(role(root)).toBe("Course coordinator");
});

test("since yesterday: at most 7 lines, least certain first, the rest folded; private lines have no value", () => {
  const root = makeBrain();
  for (let i = 0; i < 9; i++) write(root, { agent: "planner", id: "projects/course-a", attribute: `note_${i}`, value: `v${i}`, as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source", ...(i === 8 ? { confidence: "inferred" } : {}) } as never);
  write(root, { agent: "steward", id: "people/paul-advisor", attribute: "fee", value: "1200 a year", as_of: "2026-10-05", sources: ["gmail:f000000000000003"], verification: "verified-by-source", sensitivity: "private" } as never);
  const v = homeView(root, loadRules(root), loadBrain(root), new Date());
  expect(v.since).toHaveLength(SINCE_CAP);
  expect(v.folded).toBe(3);
  expect(v.since[0]!.maybe).toBe(true);
  const all = homeView(root, loadRules(root), loadBrain(root), new Date(), { all: true });
  const priv = all.since.find((l) => l.page === "people/paul-advisor")!;
  expect(priv.shapeless).toBe(true);
  expect(priv.what).toBe("Something new about Paul.");
  expect(JSON.stringify(all)).not.toContain("1200 a year");
});

test("a line whose fact changed since says so instead of Undo", () => {
  const root = makeBrain();
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "role", value: "Program director", as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source" } as never);
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "role", value: "Dean", as_of: "2026-10-06", sources: ["gmail:f000000000000003"], verification: "verified-by-source" } as never);
  const v = homeView(root, loadRules(root), loadBrain(root), new Date());
  expect(v.since.map((l) => l.undo).sort()).toEqual(["changed", "undo"]);
});

test("a page opens on its prose; the box there knows the page; Undo there comes back to it", async () => {
  const { root, req, login, csrf } = setup();
  await login();
  const pg = await req("GET", "/p/people/jane-roy");
  expect(pg.status).toBe(200);
  expect(pg.text).toContain("<h1>Jane <span>Roy</span></h1>");
  expect(pg.text).toContain("Coordinates");
  expect(pg.text).not.toContain('class="tabs"');
  const said = await req("POST", "/say", { csrf: await csrf(), q: "her role is program director", page: "people/jane-roy" });
  expect(said.text).toContain("<h1>Jane <span>Roy</span></h1>");
  expect(said.text).toContain("Noted: Jane Roy is program director now.");
  const token = said.text.match(/name="token" value="([0-9a-f]{16})"/)![1]!;
  const undone = await req("POST", "/action/diary-undo", { csrf: await csrf(), token, page: "people/jane-roy" });
  expect(undone.loc).toStartWith("/p/people/jane-roy?ok=");
  expect(flashOf(undone.loc).ok).toStartWith("Undone");
  expect(role(root)).toBe("Course coordinator");
});

// The Mac's use-it check (2026-10-26): an org on a person's page was a link on the old page and plain
// words here. A linked value in Details opens its page.
test("a linked value in Details is a link to its page", async () => {
  const { root, req, login } = setup();
  await login();
  expect(write(root, { agent: "planner", id: "people/jane-roy", attribute: "works_on", value: "[[projects/course-a]]", as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source" } as never).outcome).toBe("committed");
  const pg = await req("GET", "/p/people/jane-roy");
  expect(pg.text).toMatch(/<dd><a [^>]*href="\/p\/projects\/course-a"[^>]*>Course A<\/a>/);
  expect(pg.text).toContain("Jane works on Course A."); // the diary line says the page's name, not its id
});

// The Mac's second check (2026-10-26): a line read "Maybe: <person>: open question is … orgs/<slug>"
// and a Gardener line led with a lowercase slug. The owner reads page names, never ids or slugs,
// and a guess says so in the small line, not with a "Maybe:" in front.
test("lines use page names, never ids or slugs; a guess is marked in the small line", async () => {
  const { root, req, login } = setup();
  await login();
  writeFileSync(join(root, "projects", "harbour-club.md"), `---\nid: projects/harbour-club\ntype: project\ntitle: harbour-club\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n---\n`);
  Bun.spawnSync(["git", "add", "-A"], { cwd: root }); Bun.spawnSync(["git", "commit", "-qm", "x"], { cwd: root });
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "open_question", value: "ask about orgs/bay-institute and [[projects/gone-page]]", as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source", confidence: "inferred" } as never);
  write(root, { agent: "planner", id: "projects/harbour-club", attribute: "status", value: "open", as_of: "2026-10-05", sources: ["gmail:f000000000000003"], verification: "verified-by-source" } as never);
  const v = homeView(root, loadRules(root), loadBrain(root), new Date(), { all: true });
  const q = v.since.find((l) => l.what.includes("open question"))!;
  expect(q.what).toBe("Jane's open question is ask about Bay institute and Gone page.");
  // A state says itself after the name (G634): "Harbour club is open", never "status is open".
  expect(v.since.find((l) => l.page === "projects/harbour-club")!.what).toBe("Harbour club is open.");
  const html = (await req("GET", "/home?all=1")).text;
  expect(html).not.toContain("Maybe:");
  expect(html).toContain("a guess");
  expect(html).not.toMatch(/orgs\/|projects\/gone/);
});
