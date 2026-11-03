// SPDX-License-Identifier: AGPL-3.0-only
// Audit v11 Medium (G647): the phone app paired with any pocketbrain:// link, or a pasted one, at
// once: a link from anyone could pair the app with their hub (its pages then fill the app) or replace
// the owner's own pairing, with nothing asked. Now the app asks first, naming the hub, and says when
// the link would replace the hub it is paired with.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as pairMod from "../mobile/src/pair";

const pairQuestion = (pairMod as Record<string, unknown>).pairQuestion as ((hub: string, current: string | null) => { title: string; body: string }) | undefined;
const MINE = "https://mini.tail1234.ts.net:8443", OTHER = "https://hub.tail9999.ts.net:8443";

test("the app asks before it pairs, naming the hub the link is for", () => {
  expect(typeof pairQuestion).toBe("function");
  const q = pairQuestion!(MINE, null);
  expect(q.title).toBe("Pair with mini.tail1234.ts.net?");
  expect(q.body).toContain("your own hub");
});

test("a link for another hub says it replaces the one the app is paired with", () => {
  const q = pairQuestion!(OTHER, MINE);
  expect(q.title).toBe("Pair with hub.tail9999.ts.net?");
  expect(q.body).toContain("This replaces your pairing with mini.tail1234.ts.net");
  expect(pairQuestion!(MINE, MINE).body).not.toContain("replaces");
});

test("every way to pair goes through the question before the hub is called", () => {
  const app = readFileSync(join(import.meta.dir, "..", "mobile", "App.tsx"), "utf8");
  const body = app.slice(app.indexOf("const doPair"), app.indexOf("const url = Linking.useURL()"));
  expect(body.indexOf("await confirmPair(")).toBeGreaterThan(-1);
  expect(body.indexOf("await confirmPair(")).toBeLessThan(body.indexOf("await pair("));
});
