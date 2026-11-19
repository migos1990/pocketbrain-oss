// SPDX-License-Identifier: AGPL-3.0-only
// The share picture (/share): one image the owner makes from their own memory and posts, "One
// memory. Three readers.": a square per page, drawn once per assistant from that assistant's own
// carve. It is made to be public, so it holds shapes and counts and nothing else: no page name, no
// value, no word of the memory, and an assistant's name only when it names nobody. The picture is
// drawn in the owner's browser; the hub sends nothing anywhere.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeBrain, makeDemoBrain } from "./fixture";
import { loadState } from "../src/dashboard/data";
import { sharePicture, sharePage, squares, SHARE_COPY, SHARE_READERS, SHARE_SQUARES } from "../src/dashboard/share";
import { seeList } from "../src/dashboard/see";
import { dashboardHandler } from "../src/dashboard/server";
import { records } from "../src/carve";
import { appendJsonl } from "../src/util";
import { DEMO_NOW } from "../scripts/demo-brain";

const demo = async () => { process.env.PB_NOW = DEMO_NOW; const { root } = await makeDemoBrain(); return root; };
const modelIn = (html: string) => JSON.parse(html.match(/<script type="application\/json" id="pic">([\s\S]*?)<\/script>/)![1]!);
// Every string a value can hold, however deep.
const leaves = (v: unknown): string[] => typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(leaves) : v && typeof v === "object" ? Object.values(v).flatMap(leaves) : [];

test("the picture's counts are each assistant's own cut, the same numbers See as shows", async () => {
  try {
    const s = loadState(await demo());
    const p = sharePicture(s)!;
    expect(p.pages).toBe(99);
    expect(p.per).toBe(1);
    // Most first, so the picture reads as one memory cut three ways.
    expect(p.readers.map((r) => [r.name, r.pages, r.part])).toEqual([["Claude", 99, 1], ["ChatGPT", 97, 2], ["Gemini", 83, 50]]);
    for (const [i, agent] of ["claude", "chatgpt", "gemini"].entries()) {
      const l = seeList(s, agent, { fresh: true })!, rows = l.kinds.flatMap((k) => k.pages), r = p.readers[i]!;
      expect([r.pages, r.part]).toEqual([l.given, l.part]);
      expect(r.squares.length).toBe(p.pages);
      expect(r.squares.filter((c) => c === 2).length).toBe(rows.filter((x) => x.state === "all").length);
      expect(r.squares.filter((c) => c === 1).length).toBe(rows.filter((x) => x.state === "part").length);
      expect(r.squares.filter((c) => c === 0).length).toBe(rows.filter((x) => x.state === "not").length);
      expect([r.facts, p.facts]).toEqual([rows.reduce((n, x) => n + x.given, 0), rows.reduce((n, x) => n + x.of, 0)]);
    }
    // One place per page in every row: a page ChatGPT is not given is the same square in each.
    const [claude, chatgpt] = p.readers;
    expect(chatgpt!.squares.some((c, i) => c === 0 && claude!.squares[i] === 2)).toBe(true);
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("nothing of the memory is in the picture or its page: no title, other name, page address or value", async () => {
  try {
    const s = loadState(await demo());
    const html = sharePage(s)!, model = modelIn(html);
    // What the page says: its words between tags, and everything the drawing is made from.
    const said = `${html.slice(html.indexOf("<main"), html.indexOf("</main>")).replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")}\n${JSON.stringify(model)}`.toLowerCase();
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
    // The model itself: numbers, and a name per assistant from the rules. No other string.
    const labels = Object.values(s.rules.policy.agents).map((a) => a.label);
    for (const str of leaves(model)) expect(labels).toContain(str);
    expect(Object.keys(model).sort()).toEqual(["facts", "more", "pages", "per", "readers"]);
    for (const r of model.readers) expect(Object.keys(r).sort()).toEqual(["facts", "name", "pages", "part", "squares"]);
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

test("a memory too large for one square a page draws several pages a square, and says how many", () => {
  expect(squares([2, 2, 1, 0, 0, 2], 6)).toEqual({ per: 1, squares: [2, 2, 1, 0, 0, 2] });
  // Whole only when every page in the square is given whole, empty only when none is given.
  expect(squares([2, 2, 2, 1, 0, 0, 0, 2, 2], 3)).toEqual({ per: 3, squares: [2, 1, 1] });
  const big = squares(Array.from({ length: 5000 }, (_, i) => (i % 2 ? 2 : 0) as 0 | 2), SHARE_SQUARES);
  expect(big.per).toBe(Math.ceil(5000 / SHARE_SQUARES));
  expect(big.squares.length).toBeLessThanOrEqual(SHARE_SQUARES);
});

test("the nightly check's line is on the picture only when the last night found nothing", async () => {
  try {
    const root = await demo();
    expect(sharePage(loadState(root))!).not.toContain(SHARE_COPY.tested.split("{")[0]!);
    const night = { at: "2026-10-08T08:10:00Z", code: "abc1234", memories: 300, doors: ["mcp", "api", "browser"], leaks: 0, missing: 0, owed: 900, pages: 1, facts: 1, readers: 1, answers: 1, seeds: { from: 1, to: 300 }, failed_seeds: [], ms: 1 };
    appendJsonl(join(root, "log", "slice-proof.jsonl"), night);
    expect(sharePage(loadState(root))!).toContain("300 memories, 3 doors, 0 leaks, 0 missing");
    appendJsonl(join(root, "log", "slice-proof.jsonl"), { ...night, at: "2026-10-09T08:10:00Z", leaks: 1 });
    expect(sharePage(loadState(root))!).not.toContain("300 memories");
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
  // The page can reach nothing but the hub it came from: the picture leaves only by the owner's own share.
  expect(page.csp).toContain("connect-src 'self'");
  expect(page.text).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|WebSocket/);
  expect((await get("/who")).text).toContain('href="/share"');
  expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(before);
});
