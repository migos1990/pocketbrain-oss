// SPDX-License-Identifier: AGPL-3.0-only
// The only serving hold (phone UI spec §7, owner 2026-10-26): an assistant's private, money-, health-
// or legal-shaped fact is saved at once but no agent gets it until the owner has seen it. Everything
// else serves at once; the owner's own word is never held.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { readNote, search } from "../src/core";
import { ownerSay } from "../src/owner-say";
import { markSeen } from "../src/seen";
import { loadBrain, type FactRecord } from "../src/brain";
import { readDiary } from "../src/diary";
import { APP_COPY } from "../src/dashboard/html-app";

const W = (root: string, agent: string, attribute: string, value: string, extra: Record<string, unknown> = {}) =>
  write(root, { agent, id: "people/jane-roy", attribute, value, as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source", ...extra } as never);
const sees = (root: string, agent: string, needle: string) => JSON.stringify(readNote(root, agent, "people/jane-roy")).includes(needle);
const rec = (root: string, attr: string) => loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts![attr] as FactRecord & { unseen?: boolean };

test("a private assistant fact is saved but served to nobody until the owner has seen it", () => {
  const root = makeBrain();
  expect(W(root, "planner", "home_town", "Rimouski-Est", { sensitivity: "private" }).outcome).toBe("committed");
  expect(rec(root, "home_town").unseen).toBe(true);
  expect(sees(root, "planner", "Rimouski-Est")).toBe(false);
  expect(JSON.stringify(search(root, "planner", "Rimouski-Est"))).not.toContain("Rimouski-Est");
  expect(markSeen(root, "people/jane-roy#home_town").outcome).toBe("seen");
  expect(rec(root, "home_town").unseen).toBeUndefined();
  expect(sees(root, "planner", "Rimouski-Est")).toBe(true);
  expect(readDiary(root).at(-1)).toMatchObject({ kind: "seen", fact_key: "people/jane-roy#home_town" });
});

test("a money-shaped fact is held; an everyday one serves at once", () => {
  const root = makeBrain();
  W(root, "planner", "fee", "1200 dollars a year");
  expect(sees(root, "planner", "1200 dollars")).toBe(false);
  W(root, "planner", "favourite_colour", "green");
  expect(rec(root, "favourite_colour").unseen).toBeUndefined();
  expect(sees(root, "planner", "green")).toBe(true);
});

test("the owner's own word is never held, and a request can't clear the hold itself", () => {
  const root = makeBrain();
  expect(ownerSay(root, "Jane Roy's fee is 900 dollars").kind).toBe("say.noted");
  expect(rec(root, "fee").unseen).toBeUndefined();
  W(root, "planner", "health_note", "sees a therapist", { unseen: false });
  expect(rec(root, "health_note").unseen).toBe(true);
});

test("home lists what waits for the owner's eyes, and Show releases it", async () => {
  const { dashboardHandler, flashOf } = await import("../src/dashboard/server");
  const H = "127.0.0.1:8794";
  const root = makeBrain();
  W(root, "planner", "fee", "1200 dollars a year");
  const d = dashboardHandler(root, { port: 8794, loginKey: "k".repeat(32) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
  const req = async (method: string, path: string, fields?: Record<string, string>) => {
    const body = fields ? new URLSearchParams(fields) : undefined;
    const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/home`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
    return { status: r.status, text: await r.text(), loc: r.headers.get("location") ?? "" };
  };
  const home = await req("GET", "/home");
  expect(home.text).toContain("Something new about Jane Roy");
  expect(home.text).toContain(APP_COPY.onlyYou);
  expect(home.text).not.toContain("1200 dollars");
  const csrf = home.text.match(/name="csrf" value="([^"]+)"/)![1]!;
  const shown = await req("POST", "/action/diary-seen", { csrf, key: "people/jane-roy#fee" });
  expect(shown.status).toBe(303);
  expect(shown.loc).not.toContain("1200");
  expect(flashOf(shown.loc).ok).toContain("Jane Roy: fee is 1200 dollars a year");
  expect(sees(root, "planner", "1200 dollars")).toBe(true);
});
