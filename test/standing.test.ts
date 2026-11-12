// SPDX-License-Identifier: AGPL-3.0-only
// Standing (docs/standing.md): who matters to the owner, as the owner's word in rules/standing.yaml.
// It changes how assistants weigh an ask, never what they may see, and never relaxes a check.
import { test, expect, afterEach } from "bun:test";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import * as core from "../src/core";
import { useCells, buildCells, cellDir } from "../src/cell";
import { restoreCells } from "./cells";
import { write } from "../src/write";
import { loadStanding, setStanding, recordInteraction, suggestStanding, approveSuggestion, orphanStanding, STANDING_READERS } from "../src/standing";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { digest } from "../src/digest";
import { pullSource } from "../src/pull";
import { SAM, brain, traffic } from "./standing-fixture";

afterEach(restoreCells);

const setSlice = (root: string, name: string, s: Record<string, unknown>) => {
  const f = join(root, "rules", "slices.yaml");
  const y = YAML.parse(readFileSync(f, "utf8"));
  y.slices[name] = s;
  writeFileSync(f, YAML.stringify(y));
};
const setAgent = (root: string, agent: string, patch: Record<string, unknown>) => {
  const f = join(root, "rules", "policy.yaml");
  const y = YAML.parse(readFileSync(f, "utf8"));
  y.agents[agent] = { ...y.agents[agent], ...patch };
  writeFileSync(f, YAML.stringify(y));
};
const both = <T>(fn: () => T): [T, T] => {
  useCells(false); const hub = fn();
  useCells(true); const cell = fn();
  restoreCells();
  return [hub, cell];
};

// ---------- what an assistant sees ----------

test("an assistant that sees a person sees their standing, never the reasons", () => {
  const root = brain();
  const sam = core.readNote(root, "steward", "people/sam-roy");
  expect(sam.markdown).toContain("standing: inner");
  expect(sam.standing).toEqual({ tier: "inner" });
  const jane = core.readNote(root, "steward", "people/jane-roy");
  expect(jane.markdown).toContain("standing: known · the owner holds authority");
  expect(jane.standing).toEqual({ tier: "known", authority: "owner" });
  const pack = core.contextPack(root, "steward");
  expect(pack).toContain("standing: inner");
  expect(pack).not.toContain("robin@example.com"); // the owner's own addresses never go out
  expect(pack).not.toContain("addresses");
});

test("standing follows the slice: only_attributes must list it, exclusions hold it back", () => {
  const root = brain();
  // Helper sees Sam (personal area) only through contacts-basic (org and role): no standing.
  const r = core.readNote(root, "helper", "people/sam-roy");
  expect(r.markdown).not.toContain("standing:");
  expect(r.standing).toBeUndefined();
  // Jane is in Helper's work area, where it sees every attribute: standing too.
  expect(core.readNote(root, "helper", "people/jane-roy").markdown).toContain("standing: known");
  setSlice(root, "contacts-basic", { types: ["people", "orgs"], only_attributes: ["org", "role", "standing"], exclude_tags: ["finance"], max_sensitivity: "personal" });
  expect(core.readNote(root, "helper", "people/sam-roy").markdown).toContain("standing: inner");
  setAgent(root, "helper", { exclude: ["people/sam-roy#standing"] });
  expect(core.readNote(root, "helper", "people/sam-roy").markdown).not.toContain("standing:");
  setSlice(root, "contacts-basic", { types: ["people", "orgs"], only_attributes: ["org", "role"], exclude_attributes: ["standing"] });
  setAgent(root, "helper", { exclude: [] });
  expect(core.readNote(root, "helper", "people/sam-roy").markdown).not.toContain("standing:");
  // An agent whose ceiling is below personal never sees it, even on a public note.
  setAgent(root, "helper", { max_sensitivity: "public" });
  writeFileSync(join(root, "people", "jane-roy.md"), readFileSync(join(root, "people", "jane-roy.md"), "utf8").replace("sensitivity: personal", "sensitivity: public"));
  const j = core.readNote(root, "helper", "people/jane-roy");
  expect(j.markdown).not.toContain("standing:");
});

// ---------- who_is ----------

test("who_is matches the address, never the display name", () => {
  const root = brain();
  const hit = core.whoIs(root, "steward", "Sam <sam@example.com>");
  expect(hit.person).toBe("people/sam-roy");
  expect(hit.standing).toEqual({ tier: "inner" });
  const forged = core.whoIs(root, "steward", "Sam Roy <sam.roy@evil.example>");
  expect(forged.person).toBeUndefined();
  expect(forged.standing).toEqual({ tier: "unknown" });
  expect(forged.guidance).toMatch(/don't act quickly/i);
  // A bare name is not an address.
  expect(core.whoIs(root, "steward", "Sam Roy").person).toBeUndefined();
});

test("who_is: an address not pinned by the owner counts as known at most; a self-reported one not at all", () => {
  const root = brain();
  const later = core.whoIs(root, "steward", "sam.new@example.com");
  expect(later.person).toBe("people/sam-roy");
  expect(later.standing).toEqual({ tier: "known" });
  expect(later.guidance).toMatch(/not confirmed/i);
  expect(core.whoIs(root, "steward", "sam.claimed@example.com").person).toBeUndefined();
});

test("who_is: a person outside the assistant's view answers exactly like nobody", () => {
  const root = brain();
  setSlice(root, "contacts-basic", { types: ["people", "orgs"], only_attributes: ["org", "role", "emails", "standing"], exclude_tags: ["finance"], max_sensitivity: "personal" });
  expect(core.whoIs(root, "helper", "sam@example.com").person).toBe("people/sam-roy"); // visible first
  // Helper sees Sam through contacts-basic; leave Sam out of its view by name.
  setAgent(root, "helper", { exclude: ["people/sam-roy"] });
  const hidden = core.whoIs(root, "helper", "sam@example.com");
  const nobody = core.whoIs(root, "helper", "zz@nowhere.example");
  expect(hidden).toEqual({ ...nobody, address: hidden.address });
  // Jane's address is visible to Helper now, so it matches.
  expect(core.whoIs(root, "helper", "jane@northfield.example").standing).toEqual({ tier: "known", authority: "owner" });
  // Without the address fact in view, no address matches for that agent.
  setAgent(root, "helper", { exclude: ["people/sam-roy", "people/jane-roy#emails"] });
  expect(core.whoIs(root, "helper", "jane@northfield.example").person).toBeUndefined();
});

test("standing and who_is answer the same through cells, and a cell holds only its own people", () => {
  const root = brain();
  for (const agent of ["steward", "planner", "helper"]) {
    for (const addr of ["sam@example.com", "sam.new@example.com", "jane@northfield.example", "x@y.example"]) {
      const [h, c] = both(() => core.whoIs(root, agent, addr));
      expect(c, `${agent} ${addr}`).toEqual(h);
    }
    for (const id of ["people/sam-roy", "people/jane-roy"]) {
      const [h, c] = both(() => { try { return core.readNote(root, agent, id).markdown; } catch (e) { return (e as Error).message; } });
      expect(c, `${agent} ${id}`).toBe(h);
    }
  }
  buildCells(root);
  const helperRules = join(cellDir(root, "helper"), "rules", "standing.yaml");
  const text = readFileSync(helperRules, "utf8");
  expect(text).toContain("people/jane-roy");
  expect(text).not.toContain("sam");
  expect(text).not.toContain("robin@example.com");
  expect(readFileSync(join(cellDir(root, "steward"), "rules", "standing.yaml"), "utf8")).not.toContain("robin@example.com");
});

// ---------- agents can't raise anyone ----------

test("no assistant can write standing: rules/ is the owner's, and a fact named standing is refused", () => {
  const root = brain();
  const r1 = write(root, { agent: "steward", id: "people/jane-roy", attribute: "standing", value: "inner", as_of: "2026-10-08", sources: ["gmail:f000000000000006"], verification: "verified-by-source" });
  expect(r1.outcome).toBe("refused");
  expect(JSON.stringify(r1)).toContain("reserved_attribute");
  const r2 = write(root, { agent: "steward", id: "rules/standing", attribute: "tier", value: "inner", as_of: "2026-10-08", sources: ["gmail:f000000000000006"], verification: "verified-by-source" });
  expect(r2.outcome).toBe("refused");
  expect(loadStanding(root).people["people/jane-roy"].tier).toBe("known");
});

test("nothing that decides a check reads standing", () => {
  // Standing changes priority only. The relay, captures, pulls, checks and the write path must
  // never import it, so a message from the owner's mother is held exactly like a stranger's.
  const src = join(import.meta.dir, "..", "src");
  // Imports (static, with or without .ts, dynamic), reads of rules.standing in any spelling, and the
  // file itself. Comments don't count.
  const reads = /(from|import\()\s*"\.{1,2}\/(\.\.\/)?standing(\.ts)?"|\b\w*[rR]ules\w*\??\.standing\b|[\w)\]]\[\s*"standing"\s*\]|\{[^}]*\bstanding\b[^}]*\}\s*=\s*[\w.()]*[rR]ules|standing\.yaml/;
  const importers = readdirSync(src, { recursive: true }).map(String).filter((f) => f.endsWith(".ts") && !f.endsWith("standing.ts"))
    .filter((f) => reads.test(readFileSync(join(src, f), "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")))
    .map((f) => f.split("/").pop()!).sort();
  expect(importers).toEqual([...STANDING_READERS].sort());
});

// ---------- the owner sets it ----------

test("standing set is the owner's commit; inner and close pin the person's trusted addresses", () => {
  const root = brain({ me: ["robin@example.com"], people: {} });
  setStanding(root, "people/sam-roy", "inner");
  const s = loadStanding(root);
  // Only the address the owner confirmed is pinned; a source-verified one needs --pin (it could come from a forged mail).
  expect(s.people["people/sam-roy"]).toEqual({ tier: "inner", addresses: ["sam@example.com"], note_created: "2026-10-01" });
  setStanding(root, "people/sam-roy", "inner", { pin: ["sam.new@example.com"], authority: "them" });
  setStanding(root, "people/sam-roy", "close");
  // Re-running keeps earlier pins and the authority unless told otherwise.
  expect(loadStanding(root).people["people/sam-roy"]).toEqual({ tier: "close", authority: "them", addresses: ["sam.new@example.com", "sam@example.com"], note_created: "2026-10-01" });
  setStanding(root, "people/sam-roy", "inner", { authority: "none" });
  expect(loadStanding(root).people["people/sam-roy"].authority).toBeUndefined();
  expect(() => setStanding(root, "people/sam-roy", "inner", { pin: ["sam.claimed@example.com"] })).toThrow(/not a confirmed or source-verified address/);
  const author = Bun.spawnSync(["git", "log", "-1", "--format=%an", "--", "rules/standing.yaml"], { cwd: root }).stdout.toString().trim();
  expect(["owner", "louis", "Robin"]).toContain(author); // git() writes the owner's name
  setStanding(root, "people/jane-roy", "known", { authority: "owner" });
  expect(loadStanding(root).people["people/jane-roy"]).toEqual({ tier: "known", authority: "owner", note_created: "2026-10-01" });
  setStanding(root, "people/jane-roy", "none");
  expect(loadStanding(root).people["people/jane-roy"]).toBeUndefined();
  expect(() => setStanding(root, "people/nobody", "close")).toThrow(/no person/);
  expect(() => setStanding(root, "people/jane-roy", "boss" as never)).toThrow(/tier/);
});

// ---------- suggestions from the owner's traffic ----------


test("suggestions: close for people the owner writes to and answers fast, known for some traffic, never inner", () => {
  const root = brain({ me: ["robin@example.com"], people: {} });
  traffic(root, "Sam <sam@example.com>", 20, 20, 10);
  traffic(root, "jane@northfield.example", 3, 2, 600);
  traffic(root, "stranger@spam.example", 30, 0);
  const s = suggestStanding(root);
  expect(s.find((x) => x.person === "people/sam-roy")?.tier).toBe("close");
  expect(s.find((x) => x.person === "people/jane-roy")?.tier).toBe("known");
  expect(s.some((x) => x.tier === ("inner" as string))).toBe(false);
  expect(s.map((x) => x.person).sort()).toEqual(["people/jane-roy", "people/sam-roy"]); // the unmatched stranger is never suggested
  // Nothing applies on its own.
  expect(loadStanding(root).people).toEqual({});
  approveSuggestion(root, "people/jane-roy");
  expect(loadStanding(root).people["people/jane-roy"]).toMatchObject({ tier: "known" });
  // Someone the owner already placed is never re-suggested.
  expect(suggestStanding(root).map((x) => x.person)).not.toContain("people/jane-roy");
  // The log keeps addresses and counts, never text.
  const log = readFileSync(join(root, "log", "standing", "contacts.json"), "utf8");
  expect(log).toContain("sam@example.com");
  expect(log).not.toMatch(/subject|text/);
  expect(Bun.spawnSync(["git", "status", "--porcelain", "log"], { cwd: root }).stdout.toString()).toBe(""); // never committed
});

test("a self-reported address never earns a suggestion", () => {
  const root = brain({ me: ["robin@example.com"], people: {} });
  traffic(root, "sam.claimed@example.com", 20, 20, 10);
  expect(suggestStanding(root).map((x) => x.person)).not.toContain("people/sam-roy");
});

test("a source pull records who wrote and who the owner answered, even with no model", async () => {
  const root = brain();
  mkdirSync(join(root, "fixtures"), { recursive: true });
  const msg = (id: string, from: string, to: string, ms: number) => ({ id, internalDate: String(ms), payload: { headers: [{ name: "From", value: from }, { name: "To", value: to }, { name: "Subject", value: "hello" }] }, text: "Can we move the session to Thursday at noon please", labelIds: ["INBOX"] });
  writeFileSync(join(root, "fixtures", "mail.json"), JSON.stringify([
    msg("m1", "Jane Roy <jane@northfield.example>", "robin@example.com", Date.parse("2026-10-01T10:00:00Z")),
    { ...msg("m2", "Robin <robin@example.com>", "jane@northfield.example", Date.parse("2026-10-01T10:20:00Z")), labelIds: ["SENT"] },
  ].reverse())); // newest first, as Gmail lists them
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { mail: { kind: "gmail", fixture: join(root, "fixtures", "mail.json") } } }));
  await pullSource(root, "mail", { model: null });
  await pullSource(root, "mail", { model: null }); // a second pass doesn't count the same message twice
  const c = JSON.parse(readFileSync(join(root, "log", "standing", "contacts.json"), "utf8"));
  expect(c["jane@northfield.example"]).toMatchObject({ in: 1, out: 1 });
  expect(c["jane@northfield.example"].reply_minutes).toEqual([20]);
});

// ---------- found by the slice audit (2026-10-15) ----------

test("retire can't touch standing either", () => {
  const root = brain();
  const r = core.retire(root, "steward", { id: "people/jane-roy", attribute: "standing", value: "known", as_of: "2026-10-08", sources: ["gmail:f000000000000006"], verification: "verified-by-source" });
  expect(r.outcome).toBe("refused");
});

test("a standing the agent can't see stays out of its cell, and who_is says unlisted", () => {
  const root = brain();
  setAgent(root, "steward", { exclude: ["people/sam-roy#standing"] });
  const [h, c] = both(() => [core.readNote(root, "steward", "people/sam-roy").markdown, core.whoIs(root, "steward", "sam@example.com")]);
  expect(c).toEqual(h);
  expect(h[0]).not.toContain("standing:");
  expect((h[1] as { standing: { tier: string } }).standing.tier).toBe("unlisted");
  buildCells(root);
  expect(readFileSync(join(cellDir(root, "steward"), "rules", "standing.yaml"), "utf8")).not.toContain("sam");
});

test("a cell never holds a pinned address the agent can't see", () => {
  const root = brain();
  setSlice(root, "contacts-basic", { types: ["people", "orgs"], only_attributes: ["org", "role", "standing"], exclude_tags: ["finance"], max_sensitivity: "personal" });
  expect(core.readNote(root, "helper", "people/sam-roy").markdown).toContain("standing: inner");
  buildCells(root);
  expect(readFileSync(join(cellDir(root, "helper"), "rules", "standing.yaml"), "utf8")).not.toContain("sam@example.com");
  const [h, c] = both(() => core.whoIs(root, "helper", "sam@example.com"));
  expect(c).toEqual(h);
  expect(h.standing.tier).toBe("unknown");
});

test("an unknown tier in the file counts as no standing", () => {
  const root = brain({ people: { "people/jane-roy": { tier: "boss" } } });
  expect(core.readNote(root, "steward", "people/jane-roy").markdown).not.toContain("standing:");
  expect(core.whoIs(root, "steward", "jane@northfield.example").standing.tier).toBe("unlisted");
});

test("a deleted person recreated under the same id doesn't inherit their standing", () => {
  const root = brain({ me: [], people: {} });
  setStanding(root, "people/sam-roy", "inner");
  // The owner deletes Sam's note; an agent later writes a new "Sam Roy" with Sam's pinned address.
  const recreated = SAM.replace("created: 2026-10-01", "created: 2026-10-08");
  writeFileSync(join(root, "people", "sam-roy.md"), recreated);
  expect(core.readNote(root, "steward", "people/sam-roy").markdown).not.toContain("standing:");
  expect(core.whoIs(root, "steward", "sam@example.com").standing.tier).toBe("unlisted");
  expect(orphanStanding(root)).toEqual(["people/sam-roy"]);
  expect(digest(root).text).toContain("people/sam-roy: the note is gone or was replaced");
});

test("an address pinned to someone can't be moved to another person by planting it", () => {
  const root = brain();
  const eve = SAM.replace("people/sam-roy", "people/eve-stranger").replace("title: Sam Roy", "title: Eve Stranger").replace("Partner.", "Met once.");
  writeFileSync(join(root, "people", "eve-stranger.md"), eve);
  const w = core.whoIs(root, "steward", "sam@example.com");
  expect(w.person).toBe("people/sam-roy");
  expect(w.standing.tier).toBe("inner");
});

test("mail that claims the owner's address but wasn't sent by him counts for nothing", () => {
  const root = brain({ me: ["robin@example.com"], people: {} });
  for (let i = 0; i < 3; i++) recordInteraction(root, { kind: "gmail", from: "jane@northfield.example", to: "robin@example.com", at: `2026-09-0${i + 1}T10:00:00Z`, sent: false });
  recordInteraction(root, { kind: "gmail", from: "Robin <robin@example.com>", to: "jane@northfield.example", at: "2026-09-05T10:00:00Z", sent: false });
  expect(suggestStanding(root)).toEqual([]);
  recordInteraction(root, { kind: "gmail", from: "Robin <robin@example.com>", to: "jane@northfield.example", at: "2026-09-06T10:00:00Z", sent: true });
  expect(suggestStanding(root).map((x) => x.person)).toEqual(["people/jane-roy"]);
});

test("who_is over MCP and the JSON API: hidden and missing answer alike, paused agents get nothing", async () => {
  const root = brain();
  setAgent(root, "helper", { exclude: ["people/sam-roy"] });
  const tok = issueToken(root, "helper");
  const call = async (path: string, body?: unknown) => {
    const r = await handle(root, new Request(`http://pb${path}`, { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined, headers: { authorization: `Bearer ${tok}` } }));
    return { status: r.status, text: await r.text() };
  };
  const strip = (t: string) => t.replace(/"address": "[^"]*"/, "");
  const hidden = await call("/v1/who?address=sam%40example.com");
  const nobody = await call("/v1/who?address=zz%40nowhere.example");
  expect(hidden.status).toBe(200);
  expect(strip(hidden.text)).toBe(strip(nobody.text));
  const m1 = await call("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "who_is", arguments: { address: "sam@example.com" } } });
  const m2 = await call("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "who_is", arguments: { address: "zz@nowhere.example" } } });
  expect(strip(m1.text.replace(/\\"address\\": \\"[^\\]*\\"/, ""))).toBe(strip(m2.text.replace(/\\"address\\": \\"[^\\]*\\"/, "")));
  expect(m1.text).toContain("unknown");
  setAgent(root, "helper", { status: "paused" });
  expect((await call("/v1/who?address=sam%40example.com")).status).toBe(403);
});

test("orientation tells assistants to ask who_is, in their transport's words; not the gardener", () => {
  const root = brain();
  expect(core.orientation(root, "planner", "mcp").text).toContain("## Who is asking");
  expect(core.orientation(root, "planner", "mcp").text).toContain("who_is");
  expect(core.orientation(root, "planner", "api").text).toContain("GET /v1/who?address=");
  expect(core.orientation(root, "gardener", "mcp").text).not.toContain("Who is asking");
});

test("the digest says when standing suggestions wait", () => {
  const root = brain({ me: ["robin@example.com"], people: {} });
  traffic(root, "jane@northfield.example", 3, 2, 600);
  expect(digest(root).text).toContain("[standing] 1 person you write to often");
});

test("an unpinned address on someone with authority over the owner carries no authority", () => {
  const root = brain({ people: { "people/sam-roy": { tier: "close", authority: "them", addresses: ["sam@example.com"] } } });
  expect(core.whoIs(root, "steward", "sam@example.com").standing).toEqual({ tier: "close", authority: "them" });
  const w = core.whoIs(root, "steward", "sam.new@example.com");
  expect(w.standing).toEqual({ tier: "known" });
  expect(w.guidance).not.toMatch(/authority over the owner/);
});

test("standing set refuses on a replica before touching anything", () => {
  const root = brain();
  writeFileSync(join(root, "rules", "hub.yaml"), YAML.stringify({ hub: "mini", epoch: 1, replicas: { mini: {}, laptop: {} } }));
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "commit", "-q", "-m", "hub"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
  Bun.spawnSync(["git", "config", "--local", "pocketbrain.replica", "laptop"], { cwd: root });
  const before = readFileSync(join(root, "rules", "standing.yaml"), "utf8");
  expect(() => setStanding(root, "people/jane-roy", "close")).toThrow(/on the hub/);
  expect(readFileSync(join(root, "rules", "standing.yaml"), "utf8")).toBe(before);
  expect(Bun.spawnSync(["git", "status", "--porcelain"], { cwd: root }).stdout.toString().trim()).toBe("");
});

test("texts: the owner's replies in a named chat count, with their delay", async () => {
  const root = brain();
  mkdirSync(join(root, "fixtures"), { recursive: true });
  const row = (guid: string, mine: boolean, date: string) => ({ guid, text: "Are we still on for dinner on Friday at seven", date, is_from_me: mine ? 1 : 0, handle: "+15145550123", chat: "Jane Roy" });
  writeFileSync(join(root, "fixtures", "texts.json"), JSON.stringify([row("G-2", true, "2026-10-01T10:05:00Z"), row("G-1", false, "2026-10-01T10:00:00Z")]));
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { texts: { kind: "imessage", where: ["Jane Roy"], fixture: join(root, "fixtures", "texts.json") } } }));
  await pullSource(root, "texts", { model: null });
  const c = JSON.parse(readFileSync(join(root, "log", "standing", "contacts.json"), "utf8"));
  expect(c["+15145550123"]).toMatchObject({ in: 1, out: 1, reply_minutes: [5] });
});

test("addresses with mailto:, tel: or a trailing (name) still parse", () => {
  const root = brain();
  expect(core.whoIs(root, "steward", "mailto:sam@example.com").person).toBe("people/sam-roy");
  expect(core.whoIs(root, "steward", "sam@example.com (Sam)").person).toBe("people/sam-roy");
});
