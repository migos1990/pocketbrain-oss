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
  expect(decodeURIComponent(loc)).not.toContain("1200");
  expect(decodeURIComponent(loc)).not.toContain("fee");
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
