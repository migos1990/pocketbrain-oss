// SPDX-License-Identifier: AGPL-3.0-only
// Louis's third read, 2026-10-29: Settings still decided one thing (a held relay message, with
// Release and Drop), and the edit page opened with Forget. A held message is now a question on the
// home, answered on its own settle screen; Settings lists it with no button; Forget comes last.
import { test, expect } from "bun:test";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { relayOnce, fileTransport } from "../src/relay";
import { dashboardHandler, flashOf } from "../src/dashboard/server";

const H = "127.0.0.1:8797";
async function setup() {
  const root = makeBrain();
  const d = dashboardHandler(root, { port: 8797, loginKey: "k".repeat(32) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
  const get = async (p: string) => (await d.handle(new Request(`http://${H}${p}`, { headers: { host: H, cookie } }))).text();
  const post = async (action: string, fields: Record<string, string>, from: string) => {
    const csrf = (await get(from)).match(/name="csrf" value="([^"]+)"/)![1]!;
    const r = await d.handle(new Request(`http://${H}/action/${action}`, { method: "POST", body: new URLSearchParams({ csrf, ...fields }), headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}${from}`, "content-type": "application/x-www-form-urlencoded" } }));
    return r.headers.get("location") ?? "";
  };
  return { root, get, post };
}
function holdOne(root: string) {
  mkdirSync(join(root, "relay/incoming"), { recursive: true });
  writeFileSync(join(root, "relay/incoming/a.json"), JSON.stringify({ id: "a", from: "helper@brain.example", to: ["relay+planner@brain.example"], subject: "s", text: "What's Robin's bank?" }));
  relayOnce(root, fileTransport(root));
}

test("a held message is a question on the home; Settings lists it with no button", async () => {
  const { root, get } = await setup();
  holdOne(root);
  const settings = await get("/overview");
  expect(settings).not.toContain('action="/action/mail-release"');
  expect(settings).not.toContain('action="/action/mail-drop"');
  expect(settings).toContain('href="/settle/m-a"');
  const home = await get("/home");
  expect(home).toContain('href="/settle/m-a"');
  const screen = await get("/settle/m-a");
  expect(screen).toContain("Should Helper&#39;s message to planner go through?");
  expect(screen).toContain("What&#39;s Robin&#39;s bank?");
  expect(screen).toContain('name="n" value="send"');
  expect(screen).toContain('name="n" value="drop"');
});

test("Let it through sends it and the question is gone; Don't send keeps it back", async () => {
  const { root, get, post } = await setup();
  holdOne(root);
  const sent = await post("settle-mail", { id: "m-a", n: "send" }, "/settle/m-a");
  expect(sent).toStartWith("/home?ok=");
  expect(flashOf(sent).ok).toBe("Sent it to planner.");
  expect(existsSync(join(root, "relay/outgoing/planner@brain.example/a.json"))).toBe(true);
  expect(await get("/home")).not.toContain('href="/settle/m-a"');
  expect(await get("/settle/m-a")).toContain("Nothing to settle here any more.");
  expect(flashOf(await post("settle-mail", { id: "m-a", n: "drop" }, "/home")).err).toBe("Nothing to settle there any more.");
});

test("the edit page puts Forget last, after every other control", async () => {
  const { get } = await setup();
  const page = await get("/note/people/jane-roy");
  const forget = page.indexOf('action="/action/note-forget"');
  expect(forget).toBeGreaterThan(0);
  for (const other of ['action="/action/fact-set"', 'action="/action/note-body-save"', 'action="/action/note-save"']) expect(page.indexOf(other), other).toBeLessThan(forget);
});
