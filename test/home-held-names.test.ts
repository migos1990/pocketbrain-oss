// SPDX-License-Identifier: AGPL-3.0-only
// The owner's phone, 2026-10-31 (Mac live 1e475d81): On your mind showed two identical cards
// "Something new about Apple Services payment" and one "Something new about Louis Manulife group
// benefits claim", all from addresses the pages don't hold. A held value's card never names a page
// whose name comes from a stranger's mail, a money page or a page named like money, health or legal:
// it says "Something new only you can see". Cards that would read the same are one card, which
// counts them and whose Read it shows each of them.
import { test, expect } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { homeView, waitingCount } from "../src/dashboard/home";
import { loadRules } from "../src/rules";
import { loadBrain } from "../src/brain";
import { unseenFacts } from "../src/seen";
import { dashboardHandler } from "../src/dashboard/server";

const fact = (src: string, sender: string) => `{ value: "x", as_of: 2026-10-28, sources: ["gmail:${src}"], verification: verified-by-source, by: steward, recorded: 2026-10-28, unseen: true, sender: ${sender} }`;
function page(root: string, id: string, type: string, title: string, sens: string, facts: Record<string, string>) {
  mkdirSync(join(root, id.split("/")[0]!), { recursive: true });
  writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntype: ${type}\ntitle: ${title}\narea: personal\nsensitivity: ${sens}\nstatus: active\ncreated: 2026-10-28\nupdated: 2026-10-28\nby: steward\nfacts:\n${Object.entries(facts).map(([k, v]) => `  ${k}: ${v}`).join("\n")}\n---\n`);
}
function brain() {
  const root = makeBrain();
  page(root, "money/apple-payment-1", "money", "Apple Services payment", "private", { amount: fact("f000000000000021", "unknown") });
  page(root, "money/apple-payment-2", "money", "Apple Services payment", "private", { amount: fact("f000000000000022", "unknown") });
  page(root, "notes/louis-manulife-group-benefits-claim", "note", "Louis Manulife group benefits claim", "personal", { status: fact("f000000000000023", "unknown") });
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=steward", "-c", "user.email=s@x", "commit", "-qm", "steward: held"], { cwd: root });
  return root;
}
const NOW = new Date("2026-10-29T23:00:00Z");

test("held cards never name a stranger's subject or a money page, and the same card shows once", () => {
  const root = brain();
  expect(unseenFacts(root)).toHaveLength(3);
  const v = homeView(root, loadRules(root), loadBrain(root), NOW);
  const held = v.waiting.filter((w) => w.seen);
  expect(held.map((w) => w.what)).toEqual(["3 new things only you can see."]);
  expect(held[0]!.stranger).toBe(true);
  expect(held[0]!.seen!.split("\n").sort()).toEqual(["money/apple-payment-1#amount", "money/apple-payment-2#amount", "notes/louis-manulife-group-benefits-claim#status"]);
  const words = JSON.stringify([...v.waiting, ...v.since, ...v.earlier.flatMap((d) => d.lines)].map((l) => l.what));
  expect(words).not.toMatch(/Apple|payment|Manulife|benefits/);
  expect(waitingCount(root, NOW)).toBe(3); // one card, three things (G625)
});

test("Read it on a grouped card shows each of its values", async () => {
  const root = brain();
  const H = "127.0.0.1:8794";
  const d = dashboardHandler(root, { port: 8794, loginKey: "k".repeat(32), now: () => NOW });
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const home = await (await d.handle(new Request(`http://${H}/home`, { headers: { host: H, cookie } }))).text();
  const m = home.match(/action="\/action\/diary-seen"><input type="hidden" name="csrf" value="([^"]*)"><input type="hidden" name="key" value="([^"]+)"/)!;
  expect(m).not.toBeNull();
  const key = m[2]!.replace(/&#10;/g, "\n");
  const r = await d.handle(new Request(`http://${H}/action/diary-seen`, { method: "POST", headers: { host: H, cookie, "content-type": "application/x-www-form-urlencoded", origin: `http://${H}` }, body: new URLSearchParams({ csrf: m[1]!, key }).toString() }));
  expect(r.status).toBe(303);
  expect(unseenFacts(root)).toHaveLength(0);
});

test("a held value on a page with a plain name from a known sender still names its page", () => {
  const root = makeBrain();
  page(root, "people/jane-roy-2", "person", "Jane Roy", "personal", { prefers: fact("f000000000000031", "known") });
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=steward", "-c", "user.email=s@x", "commit", "-qm", "steward: held"], { cwd: root });
  const v = homeView(root, loadRules(root), loadBrain(root), NOW);
  expect(v.waiting.filter((w) => w.seen).map((w) => w.what)).toEqual(["Something new about Jane Roy."]);
});
