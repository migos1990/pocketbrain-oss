// SPDX-License-Identifier: AGPL-3.0-only
// Re-audit 2026-10-30 (first audit's high finding, still reproduced on 6e15f79): a held relay
// message was let through on the 30-day sign-in. Its settle screen shut the text past 10 minutes
// but kept Let it through, and the post sent it. Letting a held message through now needs a sign-in
// from the last 10 minutes, like Show; keeping it back does not (G525).
import { test, expect } from "bun:test";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { relayOnce, fileTransport } from "../src/relay";
import { dashboardHandler, flashOf, needsFresh } from "../src/dashboard/server";

const H = "127.0.0.1:8796";
async function setup() {
  const root = makeBrain();
  let t = Date.parse("2026-10-08T15:00:00Z");
  const d = dashboardHandler(root, { port: 8796, loginKey: "k".repeat(32), now: () => new Date(t) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
  const get = async (p: string) => (await d.handle(new Request(`http://${H}${p}`, { headers: { host: H, cookie } }))).text();
  const post = async (action: string, fields: Record<string, string>, from: string) => {
    const csrf = (await get(from)).match(/name="csrf" value="([^"]+)"/)![1]!;
    const r = await d.handle(new Request(`http://${H}/action/${action}`, { method: "POST", body: new URLSearchParams({ csrf, ...fields }), headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}${from}`, "content-type": "application/x-www-form-urlencoded" } }));
    return r.headers.get("location") ?? "";
  };
  mkdirSync(join(root, "relay/incoming"), { recursive: true });
  writeFileSync(join(root, "relay/incoming/a.json"), JSON.stringify({ id: "a", from: "helper@brain.example", to: ["relay+planner@brain.example"], subject: "s", text: "What's Robin's bank?" }));
  relayOnce(root, fileTransport(root));
  return { root, get, post, later: (min: number) => { t += min * 60_000; } };
}
const sent = (root: string) => existsSync(join(root, "relay/outgoing/planner@brain.example/a.json"));

test("past 10 minutes, Let it through is refused and the message stays held", async () => {
  const { root, get, post, later } = await setup();
  later(11);
  const screen = await get("/settle/m-a");
  expect(screen).not.toContain("What&#39;s Robin&#39;s bank?");
  expect(screen).not.toContain('name="n" value="send"');
  expect(screen).toContain('name="n" value="drop"');
  const r = await post("settle-mail", { id: "m-a", n: "send" }, "/settle/m-a");
  expect(flashOf(r).err).toContain("Sign in again");
  expect(sent(root)).toBe(false);
  expect(await get("/home")).toContain('href="/settle/m-a"');
});

test("keeping it back needs no fresh sign-in; a fresh one still lets it through", async () => {
  const a = await setup();
  a.later(11);
  expect(flashOf(await a.post("settle-mail", { id: "m-a", n: "drop" }, "/settle/m-a")).ok).toContain("Kept it back");
  const b = await setup();
  expect(flashOf(await b.post("settle-mail", { id: "m-a", n: "send" }, "/settle/m-a")).ok).toBe("Sent it to planner.");
  expect(sent(b.root)).toBe(true);
});

test("an old form's /action/mail-release can't let it out on the 30-day sign-in either", async () => {
  const { root, post, later } = await setup();
  later(11);
  expect(flashOf(await post("mail-release", { id: "a" }, "/home")).err).toContain("Sign in again");
  expect(sent(root)).toBe(false);
});

test("the rule: only what keeps a thing back runs on the 30-day sign-in", () => {
  expect(needsFresh("settle-mail", { n: "send" })).toBe(true);
  expect(needsFresh("settle-mail", {})).toBe(true);
  expect(needsFresh("settle-mail", { n: "drop" })).toBe(false);
  for (const a of ["mail-release", "diary-seen", "note-show", "note-sensitivity", "capture-release", "ask-approve", "propose", "consent", "some-new-button"]) expect(needsFresh(a, {}), a).toBe(true);
  for (const a of ["settle-pick", "settle-both", "diary-undo", "note-hide", "sign-in-again"]) expect(needsFresh(a, {}), a).toBe(false);
});
