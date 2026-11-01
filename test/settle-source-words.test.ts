// SPDX-License-Identifier: AGPL-3.0-only
// Audit v8 UX list, unchanged through v10 (G619): each side on the settle screen said only where it
// came from ("From an email, 7 Oct"), so the owner had to pick without the evidence. Each side now
// shows the source's own kept words (src/quotes.ts) when they hold its value, short enough for a
// phone, behind the page's rule: on the 30-day sign-in, words from an item that a private, held,
// money, health or legal fact on that page also cites stay shut (html-page.ts shutItems).
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler } from "../src/dashboard/server";

const H = "127.0.0.1:8792";
const A = "Grace Liu is now the customer success director for Atlas", B = "Grace Liu is now the head of customer experience for Atlas";

async function screen(edit?: (root: string) => void) {
  const { root } = await makeDemoBrain();
  edit?.(root);
  const t = Date.parse(DEMO_NOW);
  let at = t;
  const d = dashboardHandler(root, { port: 8792, loginKey: "k".repeat(32), now: () => new Date(at) });
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const get = async () => (await d.handle(new Request(`http://${H}/settle/c-0002`, { headers: { host: H, cookie } }))).text();
  const fresh = await get();
  at = t + 11 * 60_000;
  return { fresh, stale: await get() };
}

test("each side of a conflict shows the source's own words (G619)", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { fresh, stale } = await screen();
    for (const html of [fresh, stale]) { expect(html).toContain(A); expect(html).toContain(B); }
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("on the 30-day sign-in, words from a mail a private fact on the page also cites stay shut (G619)", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { fresh, stale } = await screen((root) => {
      const f = join(root, "people/grace-liu.md");
      const text = readFileSync(f, "utf8");
      const next = text.replace(/^facts:\n/m, `facts:\n  salary: { value: "120000", as_of: 2026-10-07, sources: ["gmail:000000000000e1f9"], verification: verified-by-source, by: steward, recorded: 2026-10-07, sensitivity: private }\n`);
      expect(next).not.toBe(text);
      writeFileSync(f, next);
    });
    expect(fresh).toContain(A);
    expect(stale).not.toContain(A);
    // The other side's mail carries nothing private: its words still show.
    expect(stale).toContain(B);
  } finally { delete process.env.PB_NOW; }
}, 60_000);
