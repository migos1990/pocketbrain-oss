// SPDX-License-Identifier: AGPL-3.0-only
// Owner, 2026-11-07, on a person page on his phone: "submit doesnt work". The box had saved his
// sentence as his word, but its reply was drawn at the foot of the page, behind the pinned box, and
// the page came back at its top, so nothing seemed to happen; he tapped six times and the hub read
// the sentence six times (G727, G728). The reply now sits with the box, the page says he edited it,
// and the same sentence sent again on the same page is read once.
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler } from "../src/dashboard/server";
import { git } from "../src/git";
import { editedOn } from "../src/page-notes";
import type { Note } from "../src/brain";
import { makeModel, type Model } from "../src/model";

const ID = "people/antoine-lavoie", P = `/p/${ID}`;
const H = "127.0.0.1:8795";
async function setup(boxModel?: Model) {
  const { root } = await makeDemoBrain();
  const d = dashboardHandler(root, { port: 8795, loginKey: "k".repeat(32), now: () => new Date(DEMO_NOW), ...(boxModel ? { boxModel } : {}) });
  const login = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const req = async (method: string, path: string, fields?: Record<string, string>) => {
    const body = fields ? new URLSearchParams(fields) : undefined;
    const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}${P}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
    return { status: r.status, text: await r.text() };
  };
  const csrf = async () => (await req("GET", P)).text.match(/name="csrf" value="([^"]+)"/)![1]!;
  return { root, req, csrf };
}
// The owner's own commits (the hub's page-text rewrite after a write is its own, and expected).
const commits = (root: string) => git(root, ["log", "--format=%s"]).split("\n").filter((l) => /^owner: /.test(l)).length;

test("G727 a sentence on a page answers beside the box, and the page shows it at once, edited by you", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const s = await setup();
    const r = await s.req("POST", "/say", { csrf: await s.csrf(), page: ID, q: "Antoine is the DG of Lakeshore College" });
    // The reply is inside the pinned box's area, where the owner is looking, not at the page's foot.
    const pinned = r.text.slice(r.text.indexOf('<div class="pinned">'));
    expect(pinned).toContain('role="status"');
    expect(pinned).toContain("DG of Lakeshore College");
    // The page under it already says it: the line under the name, and that the owner changed it.
    const head = r.text.slice(0, r.text.indexOf("</header>"));
    expect(head).toContain("DG of Lakeshore College");
    expect(r.text).toContain("Edited by you on 8 Oct.");
    expect((await s.req("GET", P)).text).toContain("Edited by you on 8 Oct.");
  } finally { delete process.env.PB_NOW; }
}, 90_000);

test("G728 the same sentence sent again on the same page is read once: one commit, the same answer", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    // A model reads a sentence a little differently each time, as the owner's did: each reading
    // would be its own write.
    let n = 0;
    const words = ["DG of Lakeshore College", "DG of Lakeshore college", "DG at Lakeshore College"];
    const s = await setup(makeModel({ provider: "fake", model: "fake-reader" }, { fake: () => JSON.stringify({ kind: "tell", facts: [{ name: "Antoine", attribute: "role", value: words[n++ % 3] }] }) }));
    const csrf = await s.csrf();
    const before = commits(s.root);
    const say = () => s.req("POST", "/say", { csrf, page: ID, q: "Antoine is the DG of Lakeshore College" });
    const [a, b] = await Promise.all([say(), say()]);
    const c = await say();
    expect(commits(s.root) - before).toBe(1);
    for (const x of [a, b, c]) expect(x.text).toContain("DG of Lakeshore College");
    expect(n).toBe(1);
    // A sentence the model read cites owner:<day>/home/read; it is the owner's edit all the same (G735).
    expect(c.text).toContain("Edited by you on 8 Oct.");
    // The box's arrow sends once: a second tap while it is sending does nothing.
    expect(a.text).toContain("if(f.classList.contains('sending')){e.preventDefault();return}");
  } finally { delete process.env.PB_NOW; }
}, 90_000);

// Review of #132: a value the owner typed in the box and that has since ended doesn't make the page
// say Edited by you; and the arrow comes back when the browser shows the page again from its cache.
test("G734 only a live fact the owner typed counts as edited by you; the arrow unlocks on pageshow", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const s = await setup();
    const rec = (extra: Record<string, unknown>) => ({ fm: { id: ID, facts: { role: { value: "DG", sources: ["owner:2026-10-01/home"], ...extra } } } }) as unknown as Note;
    expect(editedOn(s.root, ID, rec({}))).toBe("2026-10-01");
    // The box's other channels: a sentence the model read, a chip the owner tapped (G735).
    for (const ref of ["owner:2026-10-01/home/read", "owner:2026-10-01/home/chip"]) {
      const n2 = { fm: { id: ID, facts: { role: { value: "DG", sources: [ref] } } } } as unknown as Note;
      expect(editedOn(s.root, ID, n2)).toBe("2026-10-01");
    }
    // Not the owner's notes import or a settle pick.
    for (const ref of ["owner:2026-10-01/notes", "owner:2026-10-01/settle-x", "owner:2026-10-01/homework"]) {
      const n3 = { fm: { id: ID, facts: { role: { value: "DG", sources: [ref] } } } } as unknown as Note;
      expect(editedOn(s.root, ID, n3)).toBeUndefined();
    }
    expect(editedOn(s.root, ID, rec({ valid_to: "2026-10-05" }))).toBeUndefined();
    expect(editedOn(s.root, ID, rec({ retired: "2026-10-05" }))).toBeUndefined();
    expect((await s.req("GET", P)).text).toContain("addEventListener('pageshow'");
  } finally { delete process.env.PB_NOW; }
}, 90_000);
