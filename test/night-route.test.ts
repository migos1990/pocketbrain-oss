// SPDX-License-Identifier: AGPL-3.0-only
// While you slept over the owner's door: /night opens on the 30-day sign-in and shows no private
// value on it; the home links to it only while last night has something to say, and only until
// the page was opened once; a signed-out caller gets what any page gives.
import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { dashboardHandler } from "../src/dashboard/server";
import { write } from "../src/write";
import { setNoteSensitivity } from "../src/dashboard/edit";
import { NIGHT_COPY } from "../src/dashboard/night";

const H = "127.0.0.1:8798";
function setup(root = makeBrain()) {
  let t = Date.parse("2026-10-08T15:00:00Z");
  const d = dashboardHandler(root, { port: 8798, loginKey: "k".repeat(32), now: () => new Date(t) });
  let cookie = "";
  const get = async (path: string) => {
    const r = await d.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie } }));
    return { status: r.status, text: await r.text() };
  };
  const login = async () => { const r = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } })); cookie = r.headers.get("set-cookie")!.split(";")[0]!; };
  return { root, get, login, later: (min: number) => { t += min * 60_000; } };
}
const note = (root: string, now: string, attribute: string, value: string, extra: Record<string, unknown> = {}) => {
  process.env.PB_NOW = now;
  return write(root, { agent: "planner", id: "people/jane-roy", attribute, value, as_of: "2026-10-08", sources: ["agent:planner/2026-10-08"], verification: "self-reported", ...extra } as never);
};

test("the night page opens on the 30-day sign-in; the home links to it until it was opened once", async () => {
  const was = process.env.PB_NOW;
  try {
    const { root, get, login, later } = setup();
    expect(note(root, "2026-10-08T07:30:00Z", "prefers", "calls before nine").outcome).toBe("committed");
    note(root, "2026-10-08T07:40:00Z", "fee", "1200 dollars a year", { sensitivity: "private" });
    process.env.PB_NOW = "2026-10-08T15:00:00Z";
    expect((await get("/night")).status).toBe((await get("/home")).status);
    await login();
    later(30); // past the fresh ten minutes: the 30-day sign-in
    const log = join(root, "log", "reads.jsonl"), before = existsSync(log) ? readFileSync(log, "utf8") : "";
    const home = await get("/home");
    expect(home.text).toContain('href="/night"');
    expect(home.text).toContain("While you slept,");
    const night = await get("/night");
    expect(night.status).toBe(200);
    expect(night.text).toContain("calls before nine");
    expect(night.text).toContain('action="/action/diary-undo"');
    expect(night.text).not.toContain("1200 dollars");
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(before);
    // Seen once: the home lets go of the link; the page itself still answers.
    expect((await get("/home")).text).not.toContain('href="/night"');
    expect((await get("/night")).text).toContain("calls before nine");
    // The next morning, with nothing new overnight, it is a quiet night and the home says nothing.
    process.env.PB_NOW = "2026-10-09T15:00:00Z";
    expect((await get("/home")).text).not.toContain('href="/night"');
    expect((await get("/night")).text).toContain(NIGHT_COPY.quiet);
  } finally { if (was === undefined) delete process.env.PB_NOW; else process.env.PB_NOW = was; }
}, 60_000);

// Slice audit of the branch, 2026-11-14: the two states it tried by hand, kept as cases.
test("a page made private after the night, and a money conflict, show no value on the 30-day sign-in", async () => {
  const was = process.env.PB_NOW;
  try {
    const { root, get, login, later } = setup();
    expect(note(root, "2026-10-08T07:30:00Z", "prefers", "calls before nine").outcome).toBe("committed");
    note(root, "2026-10-08T07:32:00Z", "salary", "81,250 dollars a year");
    process.env.PB_NOW = "2026-10-08T07:34:00Z";
    write(root, { agent: "steward", id: "people/jane-roy", attribute: "salary", value: "97,700 dollars a year", as_of: "2026-10-08", sources: ["agent:steward/2026-10-08"], verification: "self-reported" } as never);
    process.env.PB_NOW = "2026-10-08T15:00:00Z";
    await login();
    later(30);
    const before = (await get("/night")).text;
    expect(before).toContain("calls before nine");
    for (const v of ["81,250", "97,700"]) expect(before).not.toContain(v);
    setNoteSensitivity(root, "people/jane-roy", "private");
    const after = (await get("/night")).text;
    for (const v of ["calls before nine", "81,250", "97,700"]) expect(after).not.toContain(v);
  } finally { if (was === undefined) delete process.env.PB_NOW; else process.env.PB_NOW = was; }
}, 60_000);

// Code review of PR 177 (G823): before 07:00 the page is the night so far, so opening it early
// must not hide what the rest of the night files.
test("opened in the small hours, the home links again when the night files more", async () => {
  const was = process.env.PB_NOW;
  try {
    const { root, get, login } = setup();
    note(root, "2026-10-08T04:10:00Z", "prefers", "calls before nine");
    process.env.PB_NOW = "2026-10-08T04:30:00Z"; // 00:30 by the owner's clock
    await login();
    expect((await get("/home")).text).toContain('href="/night"');
    await get("/night");
    expect((await get("/home")).text).not.toContain('href="/night"');
    note(root, "2026-10-08T07:30:00Z", "nickname", "Janie");
    process.env.PB_NOW = "2026-10-08T15:00:00Z";
    expect((await get("/home")).text).toContain('href="/night"');
    expect((await get("/night")).text).toContain("Janie");
    expect((await get("/home")).text).not.toContain('href="/night"');
  } finally { if (was === undefined) delete process.env.PB_NOW; else process.env.PB_NOW = was; }
}, 60_000);
