// SPDX-License-Identifier: AGPL-3.0-only
// The Memory Passport conformance suite (docs/spec/memory-passport.md). Black box: it only sends
// HTTP requests to the server under test, loaded with conformance/fixture.json, as two agents.
// Reads run before writes, so the writes can't change what the reads see.

export type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;
export interface Agent { name: string; token: string }
export interface Fixture {
  agents: { full: { name: string }; limited: { name: string } };
  probes: {
    visible_note: string; visible_fact: { attribute: string; value: string };
    hidden_note: string; missing_note: string; partly_hidden_note: string; hidden_attribute: string; missing_attribute: string;
    hidden_values: string[]; redacted_note: string; full_write_note: string;
    search_visible: { q: string; expect: string }; search_hidden: { q: string; expect_full: string };
    write: { attribute: string; value: string; as_of: string; sources: string[] };
  };
}
export interface Result { id: string; level: "MUST" | "SHOULD"; title: string; ok: boolean; detail?: string; skipped?: true }
// Credentials a server may not have: a route-limited one for the full agent (a resolver credential)
// and one for a sign-in the owner hasn't approved yet. Without them, their checks are skipped.
export interface Extra { resolver?: string; waiting?: string }

interface Got { status: number; text: string; json: any; headers: Record<string, string> }
const WRITE_OUTCOMES = ["committed", "inbox", "noop"];
// Headers that differ between any two answers (when, how long), so comparing them says nothing.
const VOLATILE_HEADERS = ["date", "content-length", "etag", "x-request-id"];
// Flags a client might add hoping to see or write more. The spec defines none of them; a server
// may honour a flag only to narrow an answer, so with these the answer must be no wider (F1 to F5).
const WIDEN_QUERY = "include_hidden=true&all=true&scope=all&raw=true&unredacted=true&reveal=true&sensitivity=secret&owner=true";
const WIDEN_BODY = { verification: "confirmed-by-owner", source_type: "owner_message", sensitivity: "public", share_with: ["*"], direct: true, force: true, outcome: "committed", writes: "direct" };
// The more an outcome lets through, the higher.
const REACH: Record<string, number> = { refused: 0, noop: 1, inbox: 1, committed: 2 };

// Requests the budget check (B1) sends before it decides the server has no budget.
export const BUDGET_PROBE = 400;
const RETRY_AFTER = /^(\d+|[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT)$/;

export async function runConformance(fetcher: Fetcher, fx: Fixture, full: Agent, limited: Agent, extra: Extra = {}): Promise<Result[]> {
  const p = fx.probes;
  const call = async (who: Agent | null | string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Got> => {
    const token = typeof who === "string" ? who : who?.token;
    const r = await fetcher(path, { method, headers: { ...extra, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => { if (!VOLATILE_HEADERS.includes(k)) headers[k] = v; });
    return { status: r.status, text, json, headers };
  };
  const note = (who: Agent, id: string, query = "") => call(who, "GET", `/v1/notes/${encodeURIComponent(id)}${query}`);
  const leaks = (text: string) => p.hidden_values.filter((v) => text.toLowerCase().includes(v.toLowerCase()));
  // Two answers are alike when they match once each one's own id is taken out.
  const alike = (a: Got, idA: string, b: Got, idB: string) => a.status === b.status && a.text.split(idA).join("<id>") === b.text.split(idB).join("<id>");
  // Alike down to the headers: a header can say "it's there" as well as a status can.
  const twins = (a: Got, idA: string, b: Got, idB: string) => alike(a, idA, b, idB) && JSON.stringify(a.headers).split(idA).join("<id>") === JSON.stringify(b.headers).split(idB).join("<id>");
  const differ = (what: string, h: Got, m: Got) => `${what}: hidden ${h.status} ${JSON.stringify(h.headers)} ${h.text.slice(0, 100)} / missing ${m.status} ${JSON.stringify(m.headers)} ${m.text.slice(0, 100)}`;
  const fullName = fx.agents.full.name;
  // Every way a client might claim to be the full agent without its credential.
  const claimFull = (fullToken: string) => ({ headers: { "x-agent": fullName, "x-forwarded-user": fullName, "x-on-behalf-of": fullName, "x-memory-passport-agent": fullName }, query: `agent=${fullName}&as=${fullName}&on_behalf_of=${fullName}&access_token=${fullToken}&token=${fullToken}` });
  const out: Result[] = [];
  const skip = (id: string, level: Result["level"], title: string, why: string) => { out.push({ id, level, title, ok: true, skipped: true, detail: why }); };
  const check = async (id: string, level: Result["level"], title: string, fn: () => Promise<string | undefined>) => {
    try { const problem = await fn(); out.push({ id, level, title, ok: !problem, ...(problem ? { detail: problem } : {}) }); }
    catch (e) { out.push({ id, level, title, ok: false, detail: `threw: ${(e as Error).message}` }); }
  };

  await check("D1", "MUST", "discovery answers without a credential and names the API door", async () => {
    const d = await call(null, "GET", "/.well-known/memory-passport");
    if (d.status !== 200 || !d.json) return `status ${d.status}`;
    if (typeof d.json.memory_passport !== "string") return "no memory_passport version";
    if (typeof d.json.doors?.api?.url !== "string") return "no doors.api.url";
  });
  await check("D2", "MUST", "discovery reveals nothing about the memory", async () => {
    const d = await call(null, "GET", "/.well-known/memory-passport");
    const l = leaks(d.text);
    return l.length ? `shows ${l.join(", ")}` : undefined;
  });
  await check("A1", "MUST", "no credential gets 401 on every route", async () => {
    for (const [m, path] of [["GET", "/v1/orientation"], ["GET", `/v1/search?q=${p.search_visible.q}`], ["GET", `/v1/notes/${encodeURIComponent(p.visible_note)}`], ["POST", "/v1/remember"]] as const) {
      const r = await call(null, m, path, m === "POST" ? { id: p.visible_note, ...p.write } : undefined);
      if (r.status !== 401) return `${m} ${path}: ${r.status}`;
      if (leaks(r.text).length) return `${m} ${path} shows memory`;
    }
  });
  await check("A2", "MUST", "an unknown credential gets 401", async () => {
    const r = await call("mp_not_a_real_token_0000000000", "GET", `/v1/notes/${encodeURIComponent(p.visible_note)}`);
    return r.status === 401 ? undefined : `status ${r.status}`;
  });
  await check("O1", "MUST", "orientation answers and names no other agent", async () => {
    const r = await call(limited, "GET", "/v1/orientation");
    if (r.status !== 200 || !r.text.trim()) return `status ${r.status}`;
    if (new RegExp(`\\b${fx.agents.full.name}\\b`, "i").test(r.text)) return `names ${fx.agents.full.name}`;
    const l = leaks(r.text);
    return l.length ? `shows ${l.join(", ")}` : undefined;
  });
  await check("R1", "MUST", "a visible note reads with its facts", async () => {
    const r = await note(limited, p.visible_note);
    if (r.status !== 200) return `status ${r.status}`;
    const v = r.json?.facts?.[p.visible_fact.attribute]?.value;
    return v === p.visible_fact.value ? undefined : `facts.${p.visible_fact.attribute}.value is ${JSON.stringify(v)}`;
  });
  await check("R2", "MUST", "a hidden note answers exactly like a missing one (404)", async () => {
    const h = await note(limited, p.hidden_note), m = await note(limited, p.missing_note);
    if (h.status !== 404) return `hidden note: status ${h.status}`;
    return alike(h, p.hidden_note, m, p.missing_note) ? undefined : `hidden: ${h.text.slice(0, 120)} / missing: ${m.text.slice(0, 120)}`;
  });
  await check("R3", "MUST", "a hidden attribute is left out of a visible note", async () => {
    const r = await note(limited, p.partly_hidden_note);
    if (r.status !== 200) return `status ${r.status}`;
    if (r.json?.facts && p.hidden_attribute in r.json.facts) return `facts.${p.hidden_attribute} is present`;
    const l = leaks(r.text);
    return l.length ? `shows ${l.join(", ")}` : undefined;
  });
  await check("R4", "MUST", "a hidden value is withheld from a visible note's text", async () => {
    const r = await note(limited, p.redacted_note);
    if (r.status !== 200) return `status ${r.status}`;
    const l = leaks(r.text);
    return l.length ? `shows ${l.join(", ")}` : undefined;
  });
  await check("S1", "MUST", "search finds visible notes", async () => {
    const r = await call(limited, "GET", `/v1/search?q=${encodeURIComponent(p.search_visible.q)}`);
    if (r.status !== 200 || !Array.isArray(r.json)) return `status ${r.status}, not a list`;
    return r.json.some((h: { id?: string }) => h.id === p.search_visible.expect) ? undefined : `no hit ${p.search_visible.expect}`;
  });
  await check("S2", "MUST", "search never returns or shows what is hidden", async () => {
    const r = await call(limited, "GET", `/v1/search?q=${encodeURIComponent(p.search_hidden.q)}`);
    if (r.status !== 200 || !Array.isArray(r.json)) return `status ${r.status}, not a list`;
    if (r.json.some((h: { id?: string }) => h.id === p.hidden_note)) return `hit ${p.hidden_note}`;
    const l = leaks(r.text);
    return l.length ? `shows ${l.join(", ")}` : undefined;
  });
  await check("S3", "MUST", "the full agent's search does find it (the slice, not the search, hid it)", async () => {
    const r = await call(full, "GET", `/v1/search?q=${encodeURIComponent(p.search_hidden.q)}`);
    if (r.status !== 200 || !Array.isArray(r.json)) return `status ${r.status}, not a list`;
    return r.json.some((h: { id?: string }) => h.id === p.search_hidden.expect_full) ? undefined : `no hit ${p.search_hidden.expect_full}`;
  });
  await check("R5", "MUST", "a hidden note answers like a missing one however its address is written", async () => {
    const forms: [string, (id: string) => string][] = [
      ["encoded", (id) => encodeURIComponent(id)], ["plain slash", (id) => id], ["trailing slash", (id) => `${encodeURIComponent(id)}/`],
      ["upper case", (id) => encodeURIComponent(id.toUpperCase())], ["with .md", (id) => encodeURIComponent(`${id}.md`)], ["dot segment", (id) => id.replace("/", "/./")],
    ];
    for (const [form, f] of forms) {
      const h = await call(limited, "GET", `/v1/notes/${f(p.hidden_note)}`), m = await call(limited, "GET", `/v1/notes/${f(p.missing_note)}`);
      if (h.status === 200 || leaks(h.text).length) return `${form}: the hidden note answered ${h.status}`;
      if (!twins(h, f(p.hidden_note), m, f(p.missing_note)) && !twins(h, p.hidden_note.toUpperCase(), m, p.missing_note.toUpperCase()) && !twins(h, p.hidden_note, m, p.missing_note)) return differ(form, h, m);
    }
  });
  await check("R6", "MUST", "searching for a hidden note by its id answers like searching for a missing one", async () => {
    // The missing twin keeps the hidden id's folder, so the only difference is whether the note exists.
    const twin = p.hidden_note.replace(/[^/]+$/, "no-such-note");
    for (const [h0, m0] of [[p.hidden_note, twin], [p.hidden_note.split("/").pop()!, "no-such-note"]]) {
      const h = await call(limited, "GET", `/v1/search?q=${encodeURIComponent(h0)}`), m = await call(limited, "GET", `/v1/search?q=${encodeURIComponent(m0)}`);
      if (!twins(h, h0, m, m0)) return differ(`q=${h0}`, h, m);
    }
  });
  await check("F1", "MUST", "flags in the query never widen a read: a hidden note still answers like a missing one", async () => {
    const h = await note(limited, p.hidden_note, `?${WIDEN_QUERY}`), m = await note(limited, p.missing_note, `?${WIDEN_QUERY}`);
    if (h.status === 200 || leaks(h.text).length) return `the hidden note answered ${h.status}`;
    return twins(h, p.hidden_note, m, p.missing_note) ? undefined : differ("with flags", h, m);
  });
  await check("F2", "MUST", "flags in the query never bring back a hidden fact or value", async () => {
    for (const id of [p.partly_hidden_note, p.redacted_note]) {
      const r = await note(limited, id, `?${WIDEN_QUERY}`);
      if (r.status !== 200) return `${id}: status ${r.status}`;
      if (id === p.partly_hidden_note && r.json?.facts && p.hidden_attribute in r.json.facts) return `${id}: facts.${p.hidden_attribute} is present`;
      const l = leaks(r.text);
      if (l.length) return `${id} shows ${l.join(", ")}`;
    }
  });
  await check("F3", "MUST", "flags in the query never widen a search or orientation", async () => {
    const s = await call(limited, "GET", `/v1/search?q=${encodeURIComponent(p.search_hidden.q)}&${WIDEN_QUERY}`);
    if (Array.isArray(s.json) && s.json.some((h: { id?: string }) => h.id === p.hidden_note)) return `search hit ${p.hidden_note}`;
    if (leaks(s.text).length) return `search shows ${leaks(s.text).join(", ")}`;
    const o = await call(limited, "GET", `/v1/orientation?${WIDEN_QUERY}`);
    if (new RegExp(`\\b${fullName}\\b`, "i").test(o.text)) return `orientation names ${fullName}`;
    return leaks(o.text).length ? `orientation shows ${leaks(o.text).join(", ")}` : undefined;
  });
  await check("I1", "MUST", "identity comes from the credential: naming the full agent in a header or the query changes nothing", async () => {
    const c = claimFull(full.token);
    const h = await call(limited, "GET", `/v1/notes/${encodeURIComponent(p.hidden_note)}?${c.query}`, undefined, c.headers);
    const m = await call(limited, "GET", `/v1/notes/${encodeURIComponent(p.missing_note)}?${c.query}`, undefined, c.headers);
    if (h.status === 200 || leaks(h.text).length) return `the hidden note answered ${h.status}`;
    if (!twins(h, p.hidden_note, m, p.missing_note)) return differ("claiming the full agent", h, m);
    const plain = await call(limited, "GET", "/v1/orientation"), claimed = await call(limited, "GET", `/v1/orientation?${c.query}`, undefined, c.headers);
    if (claimed.text !== plain.text) return `orientation changed when the request claimed to be ${fullName}`;
  });
  await check("I2", "MUST", "a credential anywhere but the Authorization header counts as none (401)", async () => {
    const q = encodeURIComponent(full.token);
    for (const path of [`/v1/notes/${encodeURIComponent(p.visible_note)}?access_token=${q}`, `/v1/notes/${encodeURIComponent(p.visible_note)}?token=${q}`, `/v1/orientation?access_token=${q}`]) {
      const r = await call(null, "GET", path);
      if (r.status !== 401) return `${path.replace(q, "<token>")}: ${r.status}`;
    }
    for (const extra of [{ cookie: `token=${full.token}; session=${full.token}` }, { "x-api-key": full.token }] as Record<string, string>[]) {
      const r = await call(null, "GET", `/v1/notes/${encodeURIComponent(p.visible_note)}`, undefined, extra);
      if (r.status !== 401) return `${Object.keys(extra)[0]}: ${r.status}`;
    }
  });
  await check("W1", "MUST", "a write without a source is refused", async () => {
    const { sources: _s, ...rest } = p.write;
    const r = await call(limited, "POST", "/v1/remember", { id: p.visible_note, ...rest });
    if (r.status < 400 || r.status >= 500) return `status ${r.status}`;
    return r.json?.outcome === "refused" ? undefined : `outcome ${r.json?.outcome}`;
  });
  await check("W2", "MUST", "a sourced write to a visible note is taken (committed or held for the owner)", async () => {
    const r = await call(limited, "POST", "/v1/remember", { id: p.visible_note, ...p.write });
    if (r.status !== 200) return `status ${r.status}: ${r.text.slice(0, 120)}`;
    return WRITE_OUTCOMES.includes(r.json?.outcome) ? undefined : `outcome ${r.json?.outcome}`;
  });
  await check("W3", "MUST", "a write to a hidden note answers exactly like one to a missing note", async () => {
    const h = await call(limited, "POST", "/v1/remember", { id: p.hidden_note, ...p.write });
    const m = await call(limited, "POST", "/v1/remember", { id: p.missing_note, ...p.write });
    return alike(h, p.hidden_note, m, p.missing_note) ? undefined : `hidden: ${h.status} ${h.text.slice(0, 120)} / missing: ${m.status} ${m.text.slice(0, 120)}`;
  });
  await check("W4", "MUST", "a write to a hidden attribute answers like one to a missing attribute", async () => {
    const h = await call(limited, "POST", "/v1/remember", { id: p.partly_hidden_note, ...p.write, attribute: p.hidden_attribute });
    const m = await call(limited, "POST", "/v1/remember", { id: p.partly_hidden_note, ...p.write, attribute: p.missing_attribute });
    if (h.status !== m.status || h.json?.outcome !== m.json?.outcome) return `hidden: ${h.status} ${h.json?.outcome} / missing: ${m.status} ${m.json?.outcome}`;
    const l = leaks(h.text);
    return l.length ? `shows ${l.join(", ")}` : undefined;
  });
  await check("F4", "MUST", "flags in a write never widen it: a write to a hidden note still answers like one to a missing note", async () => {
    const h = await call(limited, "POST", "/v1/remember", { ...WIDEN_BODY, id: p.hidden_note, ...p.write });
    const m = await call(limited, "POST", "/v1/remember", { ...WIDEN_BODY, id: p.missing_note, ...p.write });
    return alike(h, p.hidden_note, m, p.missing_note) ? undefined : `hidden: ${h.status} ${h.text.slice(0, 120)} / missing: ${m.status} ${m.text.slice(0, 120)}`;
  });
  await check("F5", "MUST", "flags and a claimed identity in a write never get it further than the same write without them", async () => {
    const plain = await call(limited, "POST", "/v1/remember", { id: p.visible_note, ...p.write, attribute: `${p.write.attribute}_plain` });
    const c = claimFull(full.token);
    const flagged = await call(limited, "POST", `/v1/remember?${c.query}`, { ...WIDEN_BODY, by: fullName, agent: fullName, id: p.visible_note, ...p.write, attribute: `${p.write.attribute}_flagged` }, c.headers);
    const a = REACH[plain.json?.outcome] ?? -1, b = REACH[flagged.json?.outcome] ?? -1;
    if (b > a) return `without flags ${plain.json?.outcome}, with them ${flagged.json?.outcome}`;
    const after = await note(full, p.visible_note);
    const got = after.json?.facts?.[`${p.write.attribute}_flagged`];
    if (plain.json?.outcome !== "committed" && got) return `the flagged write was recorded: ${JSON.stringify(got)}`;
    if (got?.by !== undefined && got.by !== limited.name) return `the flagged write is recorded as by ${JSON.stringify(got.by)}`;
  });
  await check("W5", "SHOULD", "a direct writer reads its own committed write back", async () => {
    const w = await call(full, "POST", "/v1/remember", { id: p.full_write_note, ...p.write, value: `${p.write.value} (full)` });
    if (w.json?.outcome !== "committed") return `outcome ${w.json?.outcome}: ${w.text.slice(0, 120)}`;
    const r = await note(full, p.full_write_note);
    return r.json?.facts?.[p.write.attribute]?.value === `${p.write.value} (full)` ? undefined : `read back ${JSON.stringify(r.json?.facts?.[p.write.attribute])}`;
  });
  await check("I3", "MUST", "who wrote a fact comes from the credential, never the body", async () => {
    const attribute = `${p.write.attribute}_who`;
    const w = await call(full, "POST", "/v1/remember", { id: p.full_write_note, ...p.write, attribute, by: limited.name, agent: limited.name, recorded_by: limited.name });
    if (w.json?.outcome !== "committed") return `outcome ${w.json?.outcome}: ${w.text.slice(0, 120)}`;
    const r = await note(full, p.full_write_note);
    const f = r.json?.facts?.[attribute];
    if (!f) return "the write did not read back";
    if (f.by !== undefined && f.by !== full.name) return `recorded as by ${JSON.stringify(f.by)}`;
    return JSON.stringify(f).includes(`"${limited.name}"`) ? `the fact carries ${limited.name}: ${JSON.stringify(f)}` : undefined;
  });
  // Handoffs (0.2): one agent hands a task to another. The sender learns nothing about what the
  // recipient may see; the recipient never gets a value outside its slice, nor the sender's name.
  const handoff = (task: string) => call(full, "POST", "/v1/handoffs", { to: fx.agents.limited.name, task, next_step: "Confirm the room with the coordinator" });
  const plainTask = "Book a room for the course review", hiddenTask = `Pay the room through ${p.hidden_values[0]}`;
  await check("H1", "MUST", "a handoff's answer to its sender is the same whether it was delivered or held", async () => {
    const a = await handoff(plainTask), b = await handoff(hiddenTask);
    if (a.status !== 200 || typeof a.json?.id !== "string") return `status ${a.status}: ${a.text.slice(0, 120)}`;
    return alike(a, a.json.id, b, String(b.json?.id)) ? undefined : `delivered: ${a.status} ${a.text.slice(0, 120)} / held: ${b.status} ${b.text.slice(0, 120)}`;
  });
  await check("H2", "MUST", "the recipient's handoffs never carry what it may not see, nor who sent them", async () => {
    const r = await call(limited, "GET", "/v1/changes");
    if (r.status !== 200 || !r.json) return `status ${r.status}`;
    const h = JSON.stringify(r.json.handoffs ?? []);
    if (leaks(h).length) return `shows ${leaks(h).join(", ")}`;
    return new RegExp(`\\b${fullName}\\b`, "i").test(h) ? `names ${fullName}` : undefined;
  });
  await check("H3", "SHOULD", "a handoff that carries nothing hidden reaches its recipient", async () => {
    const r = await call(limited, "GET", "/v1/changes");
    const got = (r.json?.handoffs ?? []).find((x: { task?: string }) => x.task === plainTask);
    if (!got) return `no handoff with the task "${plainTask}" in /v1/changes`;
    const done = await call(limited, "POST", "/v1/handoffs/done", { id: got.id });
    return done.status === 200 ? undefined : `handoffs/done: status ${done.status}`;
  });
  // Route-limited credentials (0.2): a resolver credential works on the owner's routes only.
  const P = "a route-limited credential gets nothing from the memory routes";
  if (!extra.resolver) { skip("P1", "MUST", P, "no --resolver credential"); skip("P2", "MUST", "a route-limited credential's refusal says nothing about what exists", "no --resolver credential"); }
  else {
    const res = extra.resolver;
    await check("P1", "MUST", P, async () => {
      for (const [m, path] of [["GET", "/v1/orientation"], ["GET", `/v1/search?q=${encodeURIComponent(p.search_hidden.q)}`], ["GET", `/v1/notes/${encodeURIComponent(p.full_write_note)}`], ["GET", "/v1/changes"], ["POST", "/v1/remember"], ["POST", "/v1/handoffs"]] as const) {
        const body = path === "/v1/remember" ? { id: p.full_write_note, ...p.write, attribute: `${p.write.attribute}_resolver` } : path === "/v1/handoffs" ? { to: fx.agents.limited.name, task: plainTask, next_step: "x" } : undefined;
        const r = await call(res, m, path, body);
        if (r.status < 400 || r.status >= 500) return `${m} ${path}: ${r.status}`;
        if (leaks(r.text).length) return `${m} ${path} shows ${leaks(r.text).join(", ")}`;
      }
      const after = await note(full, p.full_write_note);
      return after.json?.facts?.[`${p.write.attribute}_resolver`] ? "its write was recorded" : undefined;
    });
    await check("P2", "MUST", "a route-limited credential's refusal says nothing about what exists", async () => {
      const v = await note({ name: "resolver", token: res }, p.visible_note), m = await note({ name: "resolver", token: res }, p.missing_note);
      return twins(v, p.visible_note, m, p.missing_note) ? undefined : differ("visible vs missing", v, m);
    });
  }
  // Waiting sign-ins (0.2): a credential the owner hasn't approved gets nothing from the memory.
  const Q = "a sign-in the owner hasn't approved gets 401 and nothing from the memory, like an unknown credential";
  if (!extra.waiting) skip("Q1", "MUST", Q, "no --waiting credential");
  else await check("Q1", "MUST", Q, async () => {
    for (const [m, path] of [["GET", "/v1/orientation"], ["GET", `/v1/search?q=${encodeURIComponent(p.search_visible.q)}`], ["GET", `/v1/notes/${encodeURIComponent(p.visible_note)}`], ["GET", "/v1/changes"], ["POST", "/v1/remember"]] as const) {
      const body = m === "POST" ? { id: p.visible_note, ...p.write } : undefined;
      const w = await call(extra.waiting!, m, path, body), u = await call("mp_not_a_real_token_0000000000", m, path, body);
      if (w.status !== 401) return `${m} ${path}: ${w.status}`;
      if (leaks(w.text).length || w.text.includes(p.visible_fact.value)) return `${m} ${path} shows memory`;
      if (!twins(w, "\u0000", u, "\u0000")) return differ(`${m} ${path} waiting vs unknown`, w, u);
    }
  });
  // Request budget (0.2, optional): run last, since it may use up the limited agent's budget.
  await check("B1", "MUST", "a request budget, when a server has one, answers 429 with Retry-After, counts requests not content, and leaves other agents alone", async () => {
    let first: Got | undefined;
    for (let i = 0; i < BUDGET_PROBE && !first; i++) { const r = await note(limited, p.visible_note); if (r.status === 429) first = r; }
    if (!first) return undefined;
    if (!RETRY_AFTER.test(first.headers["retry-after"] ?? "")) return `429 without a Retry-After (seconds or a date): ${JSON.stringify(first.headers)}`;
    if (leaks(first.text).length) return `429 shows ${leaks(first.text).join(", ")}`;
    const h = await note(limited, p.hidden_note), m = await note(limited, p.missing_note), v = await note(limited, p.visible_note);
    if (h.status !== 429 || m.status !== 429 || v.status !== 429) return `over the budget: hidden ${h.status}, missing ${m.status}, visible ${v.status}`;
    if (!twins(h, p.hidden_note, m, p.missing_note)) return differ("over the budget", h, m);
    const other = await note(full, p.visible_note);
    return other.status === 200 ? undefined : `${fullName} answered ${other.status} while ${fx.agents.limited.name} was over its budget`;
  });
  return out;
}

export function report(results: Result[]): string {
  const lines = results.map((r) => `${r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL"} ${r.id} ${r.level.padEnd(6)} ${r.title}${r.detail ? `\n       ${r.detail}` : ""}`);
  const ran = results.filter((r) => !r.skipped), must = ran.filter((r) => r.level === "MUST"), skipped = results.length - ran.length;
  lines.push("", `${must.filter((r) => r.ok).length}/${must.length} MUST, ${ran.filter((r) => r.level === "SHOULD" && r.ok).length}/${ran.filter((r) => r.level === "SHOULD").length} SHOULD${skipped ? `, ${skipped} skipped` : ""}`);
  return lines.join("\n");
}
