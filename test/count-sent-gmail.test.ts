// SPDX-License-Identifier: AGPL-3.0-only
// count_sent against a fake Gmail (G829; code review of PR 193): the sent-mail count asks for the
// SENT label and for To, Cc and Date only, never a body; it starts from the oldest mail in the
// window however many there are; and a state file with no id list does not stop it for good.
import { test, expect, afterAll, beforeEach } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { useHttp, fetchSentHeaders, GMAIL_SCOPE } from "../src/google";
import { pullSource } from "../src/pull";
import { git } from "../src/git";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const asked: URL[] = [];
let ids: string[] = []; // newest first, as Gmail lists them
const T0 = Date.UTC(2026, 8, 1);
const when = (id: string) => T0 + Number(id.slice(1)) * 60_000;
beforeEach(() => {
  asked.length = 0;
  process.env.GOOGLE_CLIENT_ID = "cid"; process.env.GOOGLE_CLIENT_SECRET = "cs"; process.env.GMAIL_REFRESH_TOKEN = `m-${Math.random()}`;
  useHttp(async (url) => {
    const u = new URL(url);
    if (u.host === "oauth2.googleapis.com") return json({ access_token: "at", expires_in: 3600, scope: GMAIL_SCOPE });
    asked.push(u);
    if (u.pathname.endsWith("/messages")) {
      const from = Number(u.searchParams.get("pageToken") ?? 0), page = ids.slice(from, from + 500);
      return json({ messages: page.map((id) => ({ id })), ...(from + 500 < ids.length ? { nextPageToken: String(from + 500) } : {}) });
    }
    const id = u.pathname.split("/").pop()!;
    return json({ id, internalDate: String(when(id)), payload: { headers: [{ name: "To", value: "Ivo Brandt <ivo@brandt.example>" }, { name: "Cc", value: "una@keller.example" }, { name: "Date", value: "x" }] } });
  });
});
afterAll(() => useHttp((u, i) => fetch(u, i)));

test("the sent-mail read asks for the SENT label and three headers, never a body, and starts from the oldest mail however many there are", async () => {
  ids = Array.from({ length: 5200 }, (_, i) => `m${5199 - i}`);
  const rows = await fetchSentHeaders({ kind: "gmail" } as never, undefined, 90, 3);
  expect(rows.map((r) => r.id)).toEqual(["m0", "m1", "m2"]);
  expect(rows[0]).toEqual({ id: "m0", to: "Ivo Brandt <ivo@brandt.example>, una@keller.example", at: new Date(T0).toISOString() });
  const lists = asked.filter((u) => u.pathname.endsWith("/messages")), gets = asked.filter((u) => !u.pathname.endsWith("/messages"));
  expect(lists.every((u) => u.searchParams.get("labelIds") === "SENT" && u.searchParams.get("q") === "newer_than:90d")).toBe(true);
  expect(gets.length).toBe(3);
  expect(gets.every((u) => u.searchParams.get("format") === "metadata" && u.searchParams.getAll("metadataHeaders").join() === "To,Cc,Date")).toBe(true);
  asked.length = 0;
  await fetchSentHeaders({ kind: "gmail" } as never, "2026-09-01T00:02:00.000Z", 90, 3);
  expect(asked[0]!.searchParams.get("q")).toBe(`after:${Math.floor(Date.parse("2026-09-01T00:02:00.000Z") / 1000)}`);
});

test("a state file with no id list is started over, not a reason to stop counting", async () => {
  const { root } = await makeDemoBrain();
  const f = join(root, "rules", "sources.yaml");
  writeFileSync(f, readFileSync(f, "utf8").replace(/kind: gmail/, "kind: gmail\n    where: [INBOX]\n    count_sent: 30"));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "owner: count sent"], "owner");
  mkdirSync(join(root, "log", "standing"), { recursive: true });
  writeFileSync(join(root, "log", "standing", "sent-mail.json"), "{}\n");
  await pullSource(root, "mail", { fetch: () => ({ items: [], cursor: "1" }), sent: () => [{ id: "s1", to: "Ivo Brandt <ivo@brandt.example>", at: "2026-10-01T09:00:00Z" }], model: null });
  expect(JSON.parse(readFileSync(join(root, "log", "standing", "contacts.json"), "utf8"))["ivo@brandt.example"]).toMatchObject({ out: 1 });
  expect(JSON.parse(readFileSync(join(root, "log", "standing", "sent-mail.json"), "utf8"))).toEqual({ ids: ["s1"], cursor: "2026-10-01T09:00:00Z" });
});
