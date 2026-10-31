// SPDX-License-Identifier: AGPL-3.0-only
// Re-audit 2026-10-30 (first audit's high finding, still reproduced on 6e15f79): the Python
// reference passport server (and the TypeScript one it was written from) let an agent that writes
// directly replace a fact hidden from it, withheld a hidden value only in its exact case, and never
// withheld one from a visible note's title or aliases, so search and reads named it. The spec's one
// rule (docs/spec/memory-passport.md): what an agent may not see answers like what doesn't exist (G530).
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixture, referenceServer } from "../conformance/reference-server";

const HIDDEN = "Maple Trust Bank";
function fixture() {
  const fx = loadFixture() as any;
  // The limited agent writes directly, and sees a note whose title, alias and text name a hidden value in other cases.
  fx.agents.limited.writes = "direct";
  fx.agents.limited.sees.push("orgs/liaison");
  fx.notes.push({ id: "orgs/liaison", type: "org", title: "maple trust bank liaison", aliases: ["MAPLE TRUST BANK desk"], area: "work", facts: {}, body: "Our contact at MAPLE trust BANK." });
  return fx;
}
const procs: { kill(): void }[] = [];
afterAll(() => { for (const p of procs) p.kill(); });

type Call = (method: string, path: string, token: string, body?: unknown) => Promise<{ status: number; text: string; json: any }>;
async function python(): Promise<{ call: Call; full: string; limited: string }> {
  const dir = mkdtempSync(join(tmpdir(), "pb-fx-"));
  writeFileSync(join(dir, "fixture.json"), JSON.stringify(fixture()));
  const p = Bun.spawn(["python3", "-I", join(import.meta.dir, "..", "conformance", "reference_server.py"), "0", join(dir, "fixture.json")], { stdout: "pipe", stderr: "inherit" });
  procs.push(p);
  const reader = p.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) { const { value, done } = await reader.read(); if (done) throw new Error("the Python server exited"); text += new TextDecoder().decode(value); }
  const s = JSON.parse(text.split("\n")[0]!);
  return { full: s.full, limited: s.limited, call: async (method, path, token, body) => { const r = await fetch(`${s.url}${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = undefined; } return { status: r.status, text: t, json: j }; } };
}
function typescript(): { call: Call; full: string; limited: string } {
  const srv = referenceServer(fixture());
  return { full: srv.issue("full"), limited: srv.issue("limited"), call: async (method, path, token, body) => { const r = await srv.handle(new Request(`http://ref${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) })); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = undefined; } return { status: r.status, text: t, json: j }; } };
}

for (const [lang, make] of [["Python", python], ["TypeScript", typescript]] as const) {
  test(`${lang} reference server: a hidden value is withheld in any case, from titles and aliases too`, async () => {
    const { call, limited } = await make();
    const leaks = (t: string) => t.toLowerCase().includes(HIDDEN.toLowerCase());
    const n = await call("GET", "/v1/notes/orgs%2Fliaison", limited);
    expect(n.status).toBe(200);
    expect(leaks(n.text)).toBe(false);
    const s = await call("GET", "/v1/search?q=liaison", limited);
    expect(s.json.map((h: { id: string }) => h.id)).toContain("orgs/liaison");
    expect(leaks(s.text)).toBe(false);
    // Searching for the hidden value finds nothing it could only have matched on.
    expect((await call("GET", "/v1/search?q=maple", limited)).json).toEqual([]);
  }, 30_000);

  test(`${lang} reference server: a direct writer's write to a hidden fact answers like a new one and changes nothing`, async () => {
    const { call, limited, full } = await make();
    const w = { as_of: "2026-10-01", sources: ["gmail:f000000000000009"], value: "+15145550000" };
    const before = (await call("GET", "/v1/notes/people%2Fsam-lee", full)).json.facts.phones;
    const hidden = await call("POST", "/v1/remember", limited, { ...w, id: "people/sam-lee", attribute: "phones" });
    const missing = await call("POST", "/v1/remember", limited, { ...w, id: "people/sam-lee", attribute: "pager" });
    expect(hidden.status).toBe(missing.status);
    expect(hidden.json.outcome).toBe(missing.json.outcome);
    expect(hidden.text.replace("phones", "X")).toBe(missing.text.replace("pager", "X"));
    expect((await call("GET", "/v1/notes/people%2Fsam-lee", full)).json.facts.phones).toEqual(before);
  }, 30_000);
}
