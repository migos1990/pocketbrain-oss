// SPDX-License-Identifier: AGPL-3.0-only
// Audit v11 Medium (G645): after Show on another person's health value, the home said "Your
// assistants get it now", but write() keeps such a value shared with the resolver only (share_with,
// src/checks.ts thirdPartySensitive), so carve refuses it to every other assistant. The done line
// now says who gets it.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { readNote } from "../src/core";
import { loadRules } from "../src/rules";

async function dash(root: string, port: number) {
  const { dashboardHandler, flashOf } = await import("../src/dashboard/server");
  const H = `127.0.0.1:${port}`;
  const d = dashboardHandler(root, { port, loginKey: "k".repeat(32), now: () => new Date("2026-10-08T14:00:00Z") });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
  const req = async (method: string, path: string, fields?: Record<string, string>) => {
    const body = fields ? new URLSearchParams(fields) : undefined;
    const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/home`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
    return { text: await r.text(), loc: r.headers.get("location") ?? "" };
  };
  return { req, flashOf };
}
const csrfOf = (html: string) => html.match(/name="csrf" value="([^"]+)"/)![1]!;

test("Show on another person's health value never says every assistant gets it", async () => {
  const root = makeBrain();
  const r = write(root, { agent: "planner", id: "people/jane-roy", attribute: "medical", value: "a diagnosis of diabetes", as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source", sensitivity: "private" } as never);
  expect(["committed", "inbox"]).toContain(r.outcome);
  const { req, flashOf } = await dash(root, 8861);
  const csrf = csrfOf((await req("GET", "/home")).text);
  const ok = flashOf((await req("POST", "/action/diary-seen", { csrf, key: "people/jane-roy#medical" })).loc).ok ?? "";
  expect(ok).toContain("diabetes");
  expect(ok).not.toContain("Your assistants get it now");
  // What the line says is what carve does: the planner still can't read it.
  expect(JSON.stringify(readNote(root, "planner", "people/jane-roy"))).not.toContain("diabetes");
  const resolver = loadRules(root).policy.resolver;
  expect(ok).toContain(resolver ? `Only ${resolver} gets it` : "No assistant gets it");
});

test("one done line for several values says who gets which", async () => {
  const { whoGetsIt } = await import("../src/dashboard/server");
  expect(whoGetsIt([undefined])).toBe("Your assistants get it now.");
  expect(whoGetsIt([undefined, undefined])).toBe("Your assistants get them now.");
  expect(whoGetsIt([[]])).toBe("No assistant gets it: it's another person's private matter.");
  expect(whoGetsIt([["steward"], ["steward"]])).toBe("Only steward gets them: some are another person's private matter.");
  expect(whoGetsIt([undefined, ["steward"]])).toBe("Your assistants get them now, except where some are another person's private matter: only steward gets those.");
});
