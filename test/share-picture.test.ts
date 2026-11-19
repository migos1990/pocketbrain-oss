// SPDX-License-Identifier: AGPL-3.0-only
// The share picture (/share): one image the owner makes from their own memory and shows to someone
// who has never heard of any of this. It says, in the owner's voice, what a page is, why each
// assistant gets a different part, and shows the split by kind of page: a row per kind, a column per
// assistant, from each assistant's own carve. It is made to be public, so it holds kinds and counts
// and nothing else: no page name, no value, no word of the memory, and an assistant's name only
// when it names nobody (or never, when the owner hides them). The picture is drawn in the owner's
// browser; the hub sends nothing anywhere.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeBrain, makeDemoBrain } from "./fixture";
import { loadState } from "../src/dashboard/data";
import { sharePicture, sharePage, shareWords, exampleLine, kindOf, SHARE_COPY, SHARE_READERS, SHARE_KINDS, type SharePicture } from "../src/dashboard/share";
import { seeList } from "../src/dashboard/see";
import { dashboardHandler } from "../src/dashboard/server";
import { records } from "../src/carve";
import { appendJsonl } from "../src/util";
import { DEMO_NOW } from "../scripts/demo-brain";

const demo = async () => { process.env.PB_NOW = DEMO_NOW; const { root } = await makeDemoBrain(); return root; };
const jsonIn = (html: string, id: string) => JSON.parse(html.match(new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`))![1]!);
const modelIn = (html: string) => jsonIn(html, "pic");
// Every string a value can hold, however deep.
const leaves = (v: unknown): string[] => typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(leaves) : v && typeof v === "object" ? Object.values(v).flatMap(leaves) : [];
// The sentences a stranger reads on the picture (not the table's labels).
const sentences = (w: ReturnType<typeof shareWords>) => [w.h, w.sub, w.example, w.only, w.tested].filter(Boolean).flatMap((t) => t.split(/(?<=[.?!])\s+/));

test("the picture's counts are each assistant's own cut by kind of page, the same numbers See as shows", async () => {
  try {
    const s = loadState(await demo());
    const p = sharePicture(s)!;
    expect(p.pages).toBe(99);
    expect(p.kinds).toEqual([{ kind: "people", pages: 61 }, { kind: "projects", pages: 14 }, { kind: "orgs", pages: 12 }, { kind: "money", pages: 2 }, { kind: "decisions", pages: 10 }]);
    // Most first, so the picture reads as one memory cut three ways. A cell is [whole pages, pages in part].
    expect(p.readers.map((r) => [r.name, r.pages])).toEqual([["Claude", 99], ["ChatGPT", 97], ["Gemini", 83]]);
    expect(p.readers.map((r) => r.cells)).toEqual([
      [[60, 1], [14, 0], [12, 0], [2, 0], [10, 0]],
      [[59, 2], [14, 0], [12, 0], [0, 0], [10, 0]],
      [[20, 41], [5, 0], [3, 9], [0, 0], [5, 0]],
    ]);
    for (const [i, agent] of ["claude", "chatgpt", "gemini"].entries()) {
      const l = seeList(s, agent, { fresh: true })!, rows = l.kinds.flatMap((k) => k.pages), r = p.readers[i]!;
      expect(r.pages).toBe(l.given);
      for (const [j, k] of p.kinds.entries()) {
        const mine = rows.filter((x) => kindOf(x.id) === k.kind);
        expect([k.pages, ...r.cells[j]!]).toEqual([mine.length, mine.filter((x) => x.state === "all").length, mine.filter((x) => x.state === "part").length]);
      }
    }
    expect(p.differ).toBe(true);
  } finally { delete process.env.PB_NOW; }
}, 60_000);

// The owner's friends, 2026-11-19: "What's an example of a box", "A box could be my son?" (G995).
test("the picture says what a page is, with examples from the kinds this memory has", async () => {
  try {
    const s = loadState(await demo());
    const p = sharePicture(s)!, w = shareWords(s, p);
    expect(w.sub).toContain("a page for each person, project and company");
    // Each row is a kind in plain words, with how many pages it has.
    expect(w.kinds).toEqual(["People", "Projects", "Companies", "Money", "Decisions"]);
    // A memory without projects doesn't say it has them.
    const only = (keep: (k: string) => boolean): SharePicture => ({ ...p, kinds: p.kinds.filter((k) => keep(k.kind)), readers: p.readers.map((r) => ({ ...r, cells: r.cells.filter((_, j) => keep(p.kinds[j]!.kind)) })) });
    expect(shareWords(s, only((k) => k !== "projects")).sub).toContain("a page for each person, company and account");
    expect(shareWords(s, only((k) => k === "money")).sub).toContain("a page for each thing I want remembered");
    // A folder the owner made up is the owner's word: its pages are counted under Other, never named.
    expect(kindOf("people/ada")).toBe("people");
    expect(kindOf("boat-refit/hull")).toBe("other");
    for (const k of p.kinds) expect(SHARE_KINDS).toContain(k.kind);
  } finally { delete process.env.PB_NOW; }
}, 60_000);

// "Why would I want one assistant to only know some things" (G996).
test("the picture gives the reason, and one example of the split from this memory's own counts", async () => {
  try {
    const s = loadState(await demo());
    const p = sharePicture(s)!, w = shareWords(s, p);
    expect(w.sub).toContain("because I don't want every AI to know everything about me");
    // Money first when one assistant gets it and another gets none of it.
    expect(w.example).toBe("Claude gets both of my pages about money, and ChatGPT gets none of them.");
    const pic = (kind: SharePicture["kinds"][number], a: [number, number], b: [number, number]): SharePicture => ({ pages: kind.pages, more: 0, differ: true, kinds: [kind], readers: [{ name: "Ada", pages: a[0] + a[1], cells: [a] }, { name: "Bo", pages: b[0] + b[1], cells: [b] }] });
    expect(exampleLine(pic({ kind: "money", pages: 1 }, [1, 0], [0, 0]))).toBe("Ada gets my one page about money, and Bo doesn't get it.");
    expect(exampleLine(pic({ kind: "people", pages: 40 }, [38, 2], [0, 0]))).toBe("Ada gets all 40 of my pages about people, and Bo gets none of them.");
    expect(exampleLine(pic({ kind: "orgs", pages: 9 }, [5, 1], [2, 0]))).toBe("Ada gets 6 of my 9 pages about companies, and Bo gets only 2.");
    expect(exampleLine(pic({ kind: "decisions", pages: 9 }, [5, 0], [0, 1]))).toBe("Ada gets 5 of my 9 pages about decisions, and Bo gets only 1.");
    // Pages nobody can name a kind for are no example.
    expect(exampleLine(pic({ kind: "other", pages: 4 }, [4, 0], [0, 0]))).toBe("");
    // The same cut for everyone: no example, and no sentence that says the parts differ.
    const same = { ...pic({ kind: "people", pages: 4 }, [4, 0], [4, 0]), differ: false };
    expect(exampleLine(same)).toBe("");
    const ws = shareWords(s, same);
    expect(ws.h).toBe(SHARE_COPY.hSame);
    expect(`${ws.h} ${ws.sub}`).not.toMatch(/different|because/);
  } finally { delete process.env.PB_NOW; }
}, 60_000);

// "The way your Claude talks": "Blank blank. Important blank." (G997).
test("the picture's words are whole sentences in the owner's own voice, never a slogan", async () => {
  try {
    const s = loadState(await demo());
    const p = sharePicture(s)!, w = shareWords(s, p);
    const said = sentences(w);
    expect(said.length).toBeGreaterThanOrEqual(4);
    for (const line of said) expect(line.split(/\s+/).length, line).toBeGreaterThanOrEqual(7);
    expect(w.h).toMatch(/\bmy\b/);
    expect(w.sub).toMatch(/\bI\b/);
    const all = leaves(w).join(" ");
    expect(all).not.toMatch(/\breaders?\b|the owner|makes the cut|one memory\.|shapes and counts/i);
    // The fixed copy too, whichever variant is drawn.
    for (const t of [SHARE_COPY.h, SHARE_COPY.hSame, SHARE_COPY.sub, SHARE_COPY.subSame, SHARE_COPY.only, SHARE_COPY.tested]) for (const line of t.split(/(?<=[.?!])\s+/)) expect(line.split(/\s+/).length, line).toBeGreaterThanOrEqual(7);
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("nothing of the memory is in the picture or its page: no title, other name, page address or value", async () => {
  try {
    const s = loadState(await demo());
    const html = sharePage(s)!, model = modelIn(html);
    // What the page says: its words between tags, and everything the drawing is made from (numbers and words).
    const said = `${html.slice(html.indexOf("<main"), html.indexOf("</main>")).replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")}\n${JSON.stringify(model)}\n${JSON.stringify(jsonIn(html, "say"))}`.toLowerCase();
    const names = new Set(Object.values(s.rules.policy.agents).map((a) => String(a.label ?? "").toLowerCase()));
    let checked = 0;
    for (const n of s.notes) {
      const own = [String(n.fm.title ?? ""), ...(n.fm.aliases ?? []).map(String), n.fm.id, n.fm.id.split("/").at(-1)!];
      const values = Object.values(n.fm.facts ?? {}).flatMap((f) => records(f).flatMap((r) => leaves(r.value)));
      const words = n.body.split(/\n+/).map((l) => l.trim()).filter((l) => l.length >= 24);
      for (const t of [...own, ...values, ...words]) {
        const needle = t.trim().toLowerCase();
        // A short everyday value ("work", "active") is no one's secret, and an assistant's own name is the picture's subject.
        if (needle.length < 6 || names.has(needle) || /^[\d\s./:-]+$/.test(needle)) continue;
        checked++;
        if (said.includes(needle)) throw new Error(`the share page holds "${t}" from ${n.fm.id}`);
      }
    }
    expect(checked).toBeGreaterThan(500);
    // The model itself: numbers, a name per assistant from the rules, and kinds from one fixed list. No other string.
    const labels = Object.values(s.rules.policy.agents).map((a) => a.label);
    for (const str of leaves(model)) expect([...labels, ...SHARE_KINDS]).toContain(str);
    expect(Object.keys(model).sort()).toEqual(["differ", "kinds", "more", "pages", "readers"]);
    for (const k of model.kinds) expect(Object.keys(k).sort()).toEqual(["kind", "pages"]);
    for (const r of model.readers) expect(Object.keys(r).sort()).toEqual(["cells", "name", "pages"]);
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("an assistant named after a person, or after the owner, is drawn as Assistant 1", async () => {
  try {
    const root = await demo();
    const f = join(root, "rules", "policy.yaml"), y = readFileSync(f, "utf8");
    writeFileSync(f, y.replace("label: ChatGPT", "label: Helene Lefebvre's helper").replace("label: Gemini", "label: Robin's Gemini"));
    const s = loadState(root), p = sharePicture(s)!;
    // Numbered in the order they are drawn.
    expect(p.readers.map((r) => r.name)).toEqual(["Claude", "Assistant 1", "Assistant 2"]);
    expect(sharePage(s)!).not.toMatch(/Lefebvre|Robin/);
  } finally { delete process.env.PB_NOW; }
}, 60_000);

// G994: a label can name a workplace or a project, and only the owner knows which do.
test("the owner can draw the picture with no assistant's name on it", async () => {
  try {
    const s = loadState(await demo());
    const p = sharePicture(s, { names: false })!;
    expect(p.readers.map((r) => r.name)).toEqual(["Assistant 1", "Assistant 2", "Assistant 3"]);
    const html = sharePage(s, { names: false })!;
    expect(html).not.toMatch(/Claude|ChatGPT|Gemini/);
    expect(shareWords(s, p).example).toBe("Assistant 1 gets both of my pages about money, and Assistant 2 gets none of them.");
    // One tap each way, and the page says which it is.
    expect(html).toContain(`href="/share">${SHARE_COPY.namesOn}</a>`);
    expect(html).not.toContain(SHARE_COPY.namesNote);
    expect(sharePage(s)!).toContain(`href="/share?names=off">${SHARE_COPY.namesOff}</a>`);
    expect(sharePage(s)!).toContain(SHARE_COPY.namesNote);
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("the picture says the split passed its nightly check only when the last night found nothing", async () => {
  try {
    const root = await demo();
    expect(sharePage(loadState(root))!).not.toContain(SHARE_COPY.tested.split("{")[0]!);
    const line = "passed its nightly check on 8 Oct";
    const night = { at: "2026-10-08T08:10:00Z", code: "abc1234", memories: 300, doors: ["mcp", "api", "browser"], leaks: 0, missing: 0, owed: 900, pages: 1, facts: 1, readers: 1, answers: 1, seeds: { from: 1, to: 300 }, failed_seeds: [], ms: 1 };
    appendJsonl(join(root, "log", "slice-proof.jsonl"), night);
    expect(sharePage(loadState(root))!).toContain(line);
    appendJsonl(join(root, "log", "slice-proof.jsonl"), { ...night, at: "2026-10-09T08:10:00Z", leaks: 1 });
    expect(sharePage(loadState(root))!).not.toContain("nightly check on");
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("with fewer than two assistants there is no picture, and the page says what it needs", () => {
  const root = makeBrain();
  const f = join(root, "rules", "policy.yaml");
  const s = loadState(root), own = sharePicture(s);
  if (own) expect(own.readers.length).toBeGreaterThanOrEqual(2);
  for (const a of Object.values(s.rules.policy.agents)) (a as { status?: string }).status = "paused";
  expect(sharePicture(s)).toBeUndefined();
  expect(sharePage(s)!).toContain(SHARE_COPY.needsTwo);
  expect(sharePage(s)!).not.toContain('id="pic"');
  expect(existsSync(f)).toBe(true);
});

test("more assistants than the picture has rows for: the first ones are drawn and the rest are counted", async () => {
  try {
    const root = await demo();
    const f = join(root, "rules", "policy.yaml"), y = readFileSync(f, "utf8");
    const line = y.split("\n").find((l) => /^\s+gemini:/.test(l))!;
    const extra = Array.from({ length: SHARE_READERS }, (_, i) => line.replace("gemini:", `helper${i}:`).replace("label: Gemini", `label: Helper ${i}`).replace("browser: true, ", ""));
    writeFileSync(f, y.replace(line, [line, ...extra].join("\n")));
    const p = sharePicture(loadState(root))!;
    expect(p.readers.length).toBe(SHARE_READERS);
    expect(p.more).toBe(3);
  } finally { delete process.env.PB_NOW; }
}, 60_000);

const H = "127.0.0.1:8797";
test("/share opens on the 30-day sign-in, only for the owner, logs no read, and Who knows links to it", async () => {
  const root = makeBrain();
  let t = Date.parse("2026-10-08T15:00:00Z");
  const d = dashboardHandler(root, { port: 8797, loginKey: "k".repeat(32), now: () => new Date(t) });
  let cookie = "";
  const get = async (path: string) => { const r = await d.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie } })); return { status: r.status, text: await r.text(), csp: r.headers.get("content-security-policy") ?? "" }; };
  expect((await get("/share")).status).toBe(401);
  const r = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  cookie = r.headers.get("set-cookie")!.split(";")[0]!;
  const log = join(root, "log", "reads.jsonl"), before = existsSync(log) ? readFileSync(log, "utf8") : "";
  t += 30 * 60_000;
  const page = await get("/share");
  expect(page.status).toBe(200);
  expect(page.text).toContain(SHARE_COPY.title);
  expect((await get("/share?names=off")).status).toBe(200);
  // The page can reach nothing but the hub it came from: the picture leaves only by the owner's own share.
  expect(page.csp).toContain("connect-src 'self'");
  expect(page.text).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|WebSocket/);
  expect((await get("/who")).text).toContain('href="/share"');
  expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(before);
});
