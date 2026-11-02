// SPDX-License-Identifier: AGPL-3.0-only
// Audit v5 (2026-10-27): Show redirected to /home?ok=<page>: <attr> is <value>, so a held value sat in
// the URL (history, logs, a shared screenshot), and an error flashed its raw message with paths.
// A message now travels as an opaque id kept on the hub for this sign-in; an error from inside the
// code says it plainly, with no path.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { dashboardHandler, ownerFacingError } from "../src/dashboard/server";
import { CoreError } from "../src/core";

const H = "127.0.0.1:8792";

// The location's words, past the server's random ids: the flash's (ok=@…) and the diary's Undo
// tokens (tok=, 16 hex). "fee" is hex, so it once matched a token by chance (G632).
function wordsOf(loc: string): string {
  const u = new URL(loc, `http://${H}`);
  expect(u.searchParams.get("ok")).toMatch(/^@[\w-]{16}$/);
  expect(u.searchParams.get("tok") ?? "").toMatch(/^(?:[0-9a-f]{16}(?:,[0-9a-f]{16})*)?$/);
  for (const k of ["ok", "tok"]) u.searchParams.delete(k);
  return decodeURIComponent(u.pathname + u.search);
}

test("Show's message is on the page, never in the URL", async () => {
  const root = makeBrain();
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "fee", value: "1200 dollars a year", as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source" } as never);
  const d = dashboardHandler(root, { port: 8792, loginKey: "k".repeat(32) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
  const get = async (path: string, c = cookie) => (await d.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie: c } }))).text();
  const csrf = (await get("/home")).match(/name="csrf" value="([^"]+)"/)![1]!;
  const r = await d.handle(new Request(`http://${H}/action/diary-seen`, { method: "POST", body: new URLSearchParams({ csrf, key: "people/jane-roy#fee" }), headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/home`, "content-type": "application/x-www-form-urlencoded" } }));
  expect(r.status).toBe(303);
  const loc = r.headers.get("location")!;
  const rest = wordsOf(loc);
  expect(rest).not.toContain("1200");
  expect(rest).not.toContain("fee");
  expect(await get(loc)).toContain("fee is 1200 dollars a year");
  // Another sign-in holding the same link sees nothing.
  const r1 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  expect(r1.status).toBe(303);
});

test("an error from inside the code says so plainly, with no path; a refusal keeps its words", () => {
  const raw = new Error("ENOENT: no such file or directory, open '/Users/someone/pocketbrain-brain/people/x.md'");
  const said = ownerFacingError(raw);
  expect(said).not.toContain("/Users");
  expect(said).not.toContain("pocketbrain-brain");
  expect(ownerFacingError(new CoreError(409, "Nothing to settle there any more."))).toBe("Nothing to settle there any more.");
  expect(ownerFacingError(new CoreError(404, "no note at /tmp/a/b.md"))).not.toContain("/tmp/a");
});

// The flake, pinned (G632): at this time the Undo token for Jane Roy's fee is 5a37cb69feede409,
// which holds "fee". The URL still carries no value or key.
test("an Undo token that happens to hold the value's words isn't a value in the URL", async () => {
  process.env.PB_NOW = "2026-10-08T14:02:24.000Z";
  try {
    const root = makeBrain();
    write(root, { agent: "planner", id: "people/jane-roy", attribute: "fee", value: "1200 dollars a year", as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source" } as never);
    const d = dashboardHandler(root, { port: 8796, loginKey: "k".repeat(32) });
    const h = "127.0.0.1:8796";
    const r0 = await d.handle(new Request(`http://${h}/login?key=${"k".repeat(32)}`, { headers: { host: h } }));
    const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
    const home = await (await d.handle(new Request(`http://${h}/home`, { headers: { host: h, cookie } }))).text();
    const csrf = home.match(/name="csrf" value="([^"]+)"/)![1]!;
    const r = await d.handle(new Request(`http://${h}/action/diary-seen`, { method: "POST", body: new URLSearchParams({ csrf, key: "people/jane-roy#fee" }), headers: { host: h, cookie, origin: `http://${h}`, referer: `http://${h}/home`, "content-type": "application/x-www-form-urlencoded" } }));
    const loc = r.headers.get("location")!;
    expect(new URL(loc, `http://${h}`).searchParams.get("tok")).toBe("5a37cb69feede409");
    const rest = wordsOf(loc);
    expect(rest).not.toContain("fee");
    expect(rest).not.toContain("1200");
  } finally { delete process.env.PB_NOW; }
});
