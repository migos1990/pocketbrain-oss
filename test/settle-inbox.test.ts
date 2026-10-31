// SPDX-License-Identifier: AGPL-3.0-only
// A contradiction the write path hands to the owner as a proposal (a page holding a private record,
// a value the owner confirmed) is a conflict too (review thread, audit v4): it waits on the home in
// the owner's words and settles on the same screen, never only on the old pages.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { loadBrain, type FactRecord } from "../src/brain";
import { inboxConflicts } from "../src/settle-inbox";
import { homeView } from "../src/dashboard/home";
import { loadRules } from "../src/rules";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const inbox = (root: string) => existsSync(join(root, "inbox")) ? readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml")) : [];
const W = (root: string, agent: string, attribute: string, value: string, extra: Record<string, unknown> = {}) =>
  write(root, { agent, id: "people/jane-roy", attribute, value, as_of: "2026-10-07", sources: ["gmail:f000000000000005"], verification: "verified-by-source", ...extra } as never);

function conflictOnPrivatePage() {
  const root = makeBrain();
  // The owner's private fact on the page, then an outside writer's different role: a proposal.
  write(root, { agent: "owner", id: "people/jane-roy", attribute: "health_note", value: "x", as_of: "2026-10-07", sources: ["owner:2026-10-07/home"], verification: "confirmed-by-owner", sensitivity: "private" } as never, { owner: true });
  const role0 = (loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts!.role as FactRecord).value;
  const r = W(root, "steward", "role", "Dean of studies");
  expect(r.outcome).toBe("inbox");
  return { root, role0 };
}

test("a proposal that contradicts a live value waits on the home and settles; one that doesn't, doesn't", async () => {
  const { root, role0 } = conflictOnPrivatePage();
  const cs = inboxConflicts(root);
  expect(cs).toHaveLength(1);
  expect(cs[0]!.sides.map((s) => s.value)).toEqual([role0, "Dean of studies"]);
  const v = homeView(root, loadRules(root), loadBrain(root), new Date("2026-10-08T15:00:00Z"));
  const w = v.waiting.find((x) => x.href === `/settle/${cs[0]!.id}`)!;
  expect(w.what).toBe("Two sources disagree on Jane Roy's role");
  const { dashboardHandler } = await import("../src/dashboard/server");
  const H = "127.0.0.1:8799";
  const d = dashboardHandler(root, { port: 8799, loginKey: "k".repeat(32) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
  const req = async (method: string, path: string, fields?: Record<string, string>) => {
    const body = fields ? new URLSearchParams(fields) : undefined;
    const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
    return { status: r.status, text: await r.text(), loc: r.headers.get("location") ?? "" };
  };
  const pg = await req("GET", `/settle/${cs[0]!.id}`);
  expect(pg.text).toContain("Dean of studies");
  const csrf = pg.text.match(/name="csrf" value="([^"]+)"/)![1]!;
  const picked = await req("POST", "/action/settle-pick", { csrf, id: cs[0]!.id, n: "2" });
  expect(picked.status).toBe(303);
  expect((loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts!.role as FactRecord).value).toBe("Dean of studies");
  expect(inboxConflicts(root)).toHaveLength(0);
  expect(inbox(root)).toHaveLength(0);
});

test("keep yours drops the proposal and keeps the live value", async () => {
  const { root, role0 } = conflictOnPrivatePage();
  const { settleInbox } = await import("../src/settle-inbox");
  const id = inboxConflicts(root)[0]!.id;
  settleInbox(root, id, { n: 1 });
  expect((loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts!.role as FactRecord).value).toBe(role0);
  expect(inboxConflicts(root)).toHaveLength(0);
});

test("a private conflict shows its values only after a fresh sign-in", async () => {
  const { settlePage } = await import("../src/dashboard/html-settle");
  const c = { id: "c-0001", fact_key: "people/jane-roy#fee", page: "people/jane-roy", title: "Jane Roy", attr: "fee", sides: [{ n: 1, value: "900 dollars", source_word: "you", by: "owner", sources: 1 }, { n: 2, value: "1200 dollars", source_word: "email", by: "planner", sources: 1 }], private: true };
  const root = makeBrain();
  const shut = settlePage(c, "x", loadRules(root));
  expect(shut).not.toContain("900 dollars");
  expect(shut).toContain(`action="/action/sign-in-again"`);
  expect(settlePage(c, "x", loadRules(root), undefined, { fresh: true })).toContain("900 dollars");
});
