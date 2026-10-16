// SPDX-License-Identifier: AGPL-3.0-only
// The owner dashboard: Louis's control panel (architecture 0). It is a separate listener from
// the agents' server and binds to loopback only, so the tunnel that exposes /mcp and /v1
// never reaches it. Auth is a local owner session: a login link printed once at start-up
// sets an HttpOnly cookie; every action also needs the session's CSRF token, and requests
// for any other Host are refused (DNS rebinding).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { buildDeck, recordSwipe } from "../deck";
import { deckPage } from "./html-deck";
import { loadRules } from "../rules";
import { loadBrain } from "../brain";
import { carve, grantFor } from "../carve";
import { renderView } from "../view";
import { CoreError, ownerWhy } from "../core";
import type { MailTransport } from "../relay";
import { loadState, latestDigest } from "./data";
import { layout, overview, agentsPage, agentPage, activityPage, upkeepPage, digestPage, esc, button, type Page } from "./html";
import { runAction } from "./actions";
import { ask, proposeEdit, defaultModelFor, type ModelFor, type EditProposal } from "./ask";
import { editableNote, noteText, saveNoteText, editorCommits } from "./edit";
import { brainPage, brainResults, askPage, notePage, whyPage, proposalPage, editorCard, oauthCard, newAgentPage } from "./html-brain";
import { previewNewAgent } from "../addagent";
import { cap, agentLabel } from "./labels";
import { audience } from "./browse";

const names = (xs: string[]) => xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
import { noteSaves, noteVersions, versionAt, revertedHashes, savesSince, brainAt } from "./history";
import { noteHistoryPage, snapshotPage, weekPage, brainOnPage } from "./html-history";
import { git } from "../git";
import { recordOwnerTime } from "../measure";
import { usagePage } from "./usage";
import { peoplePage } from "./people";
import { mapPage, mapGrid } from "./html-map";
import { fgaPage, fgaGrid } from "./html-fga";
import { loadOAuth, listPending, cleanupReplaced } from "../oauth";
import { loadKeys } from "../secrets";
import { askPolicy, pollAsks } from "../asks";
import * as consent from "../consent";
import { consentPage, type ConsentProposal } from "./html-consent";

// Requests pages make by themselves (polls, search as you type), not the owner opening a page.
const BACKGROUND = /^\/(map\/grid|fga\/grid|brain\/results)$/;

export interface DashboardOptions { port?: number; hostname?: string; loginKey?: string; transport?: () => MailTransport; modelFor?: ModelFor }

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const rand = () => randomBytes(24).toString("base64url");

export function dashboardHandler(root: string, opts: DashboardOptions & { port: number }) {
  const loginKey = opts.loginKey ?? rand();
  const sessions = new Map<string, string>(); // session id -> csrf token
  const proposals = new Map<string, EditProposal>(); // model-proposed edits waiting for Louis
  const consents = new Map<string, ConsentProposal>(); // proposed slices from a sentence (src/consent.ts)
  const modelFor = opts.modelFor ?? defaultModelFor(root);
  const allowedHosts = new Set<string>();
  // Called again with the real port after binding, so port 0 (pick a free one) works too.
  const setPort = (port: number) => { allowedHosts.clear(); for (const h of LOOPBACK) allowedHosts.add(`${h}:${port}`); };
  setPort(opts.port);

  const PAGE_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" };
  const html = (p: Page, status = 200, extra: Record<string, string> = {}) =>
    new Response(layout({ root }, p), { status, headers: { ...PAGE_HEADERS, ...extra } });
  const text = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

  function session(req: Request): string | undefined {
    const sid = req.headers.get("cookie")?.match(/(?:^|;\s*)pb_owner=([A-Za-z0-9_-]+)/)?.[1];
    return sid && sessions.has(sid) ? sid : undefined;
  }

  let lastOwnerMinute = "";
  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const host = req.headers.get("host") ?? "";
    if (!allowedHosts.has(host)) return text("This dashboard only answers on localhost.", 421);
    const flash = url.searchParams.get("ok") ? { msg: url.searchParams.get("ok")! } : url.searchParams.get("err") ? { msg: url.searchParams.get("err")!, err: true } : undefined;

    if (url.pathname === "/login") {
      const k = url.searchParams.get("key") ?? "";
      if (!same(k, loginKey)) return text("Wrong or missing login key. Use the link the dashboard printed when it started.", 403);
      const sid = rand();
      sessions.set(sid, rand());
      return new Response(null, { status: 303, headers: { location: "/", "set-cookie": `pb_owner=${sid}; HttpOnly; SameSite=Strict; Path=/`, "cache-control": "no-store" } });
    }
    const sid = session(req);
    if (!sid) return text("Not signed in. Open the login link the dashboard printed when it started.", 401);
    const csrf = sessions.get(sid)!;
    // The week's "your time" (src/measure.ts): page loads only, not the grids' 2 s polls or other
    // fetches, and one line a minute at most (minutes are counted per minute anyway).
    const minute = new Date().toISOString().slice(0, 16);
    if (req.method === "GET" && !BACKGROUND.test(url.pathname) && req.headers.get("sec-fetch-dest") !== "empty" && minute !== lastOwnerMinute) {
      lastOwnerMinute = minute;
      recordOwnerTime(root, "dashboard");
    }

    if (req.method === "POST") {
      // Same-origin only, and the form's token must match this session's.
      const origin = req.headers.get("origin");
      if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) return text("cross-origin request refused", 403);
      let fd: FormData;
      try { fd = await req.formData(); } catch { return text("send the dashboard's own form", 400); }
      const form = Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]));
      if (!form.csrf || !same(form.csrf, csrf)) return text("bad or missing CSRF token; reload the page", 403);
      // The deck sends how long a card was on screen: the owner's minutes (src/deck.ts). Counted
      // only for an answer that went through; Later isn't one.
      const swiped = (a: string) => { if (form.deck_ms && a !== "deck-later") recordSwipe(root, `${a}:${form.id ?? form.file ?? form.key ?? ""}`, Number(form.deck_ms)); };
      const ref = req.headers.get("referer");
      const refUrl = ref ? URL.parse(ref) : null;
      // Back to the page the form was on, on this host only: a path starting // or /\ is read by
      // browsers as another host (backlog #207), so it goes home instead.
      const back = refUrl?.host === host && /^\/(?![/\\])/.test(refUrl.pathname) ? refUrl.pathname : "/";
      const go = (path: string, r: { ok?: string; err?: string; undo?: string; wrong?: string }, hash = "") => new Response(null, { status: 303, headers: { location: `${path}?${r.err !== undefined ? `err=${encodeURIComponent(r.err)}` : `ok=${encodeURIComponent(r.ok ?? "")}${r.undo ? `&undo=${r.undo}` : ""}${r.wrong ? `&wrong=${encodeURIComponent(r.wrong)}` : ""}`}${hash}` } });
      const fail = (e: unknown) => { if (!(e instanceof CoreError)) console.error(e); return e instanceof Error ? e.message : String(e); };

      if (url.pathname === "/ask") return html(askPage(loadState(root), csrf, await ask(root, form.q ?? "", modelFor)));
      const pm = url.pathname.match(/^\/propose\/(.+)$/);
      if (pm) {
        const id = decodeURIComponent(pm[1]);
        try {
          const p = { ...(await proposeEdit(root, id, form.instruction ?? "", modelFor)), id: rand().slice(0, 12) };
          proposals.set(p.id, p);
          return new Response(null, { status: 303, headers: { location: `/proposal/${p.id}` } });
        } catch (e) { return go(back, { err: fail(e) }); }
      }
      const cm = url.pathname.match(/^\/consent\/([^/]+)$/);
      if (cm) {
        const agent = decodeURIComponent(cm[1]);
        let model;
        try { model = modelFor(consent.STEP); } catch { model = undefined; } // no model set up: the owner's words alone
        try {
          const p = { ...(await consent.propose(root, agent, form.intent ?? "", model)), id: rand().slice(0, 12) };
          consents.set(p.id, p);
          return new Response(null, { status: 303, headers: { location: `/consent/${p.id}` } });
        } catch (e) { return go(back, { err: fail(e) }, "#for"); }
      }
      const action = url.pathname.startsWith("/action/") ? url.pathname.slice("/action/".length) : "";
      if (action === "proposal-apply" || action === "proposal-discard") {
        const p = proposals.get(form.pid ?? "");
        if (!p) return go("/brain", { err: "that proposal is gone (the dashboard restarted, or it was already used)" });
        proposals.delete(p.id);
        if (action === "proposal-discard") return go(`/note/${p.noteId}`, { ok: "discarded; nothing changed" });
        // The note may have changed since the model read it; never overwrite that.
        if (noteText(root, p.noteId) !== p.before) return go(`/note/${p.noteId}`, { err: "the note changed since the proposal; ask again" });
        try { return go(`/note/${p.noteId}`, { ok: saveNoteText(root, p.noteId, p.after, `apply ${p.model}'s proposal ("${p.instruction.slice(0, 60)}") to`, { stamp: true }) }); }
        catch (e) { return go(`/note/${p.noteId}`, { err: fail(e) }); }
      }
      if (action === "consent-apply" || action === "consent-discard") {
        const p = consents.get(form.pid ?? "");
        if (!p) return go("/agents", { err: "that proposal is gone (the dashboard restarted, or it was already used)" });
        consents.delete(p.id);
        const page = `/agent/${encodeURIComponent(p.agent)}`;
        if (action === "consent-discard") return go(page, { ok: "discarded; nothing changed" });
        try {
          const ok = consent.applyChoice(root, p.agent, p.slices, p.exclude_types);
          return go(page, { ok: ok.replace(/^\S+/, cap(agentLabel(loadRules(root), p.agent))) + ".", undo: git(root, ["rev-parse", "HEAD"]) });
        } catch (e) { return go(page, { err: fail(e) }); }
      }
      // Louis's own edits on the Brain tab come back with a plain sentence and an Undo.
      if (action === "fact-set" || action === "note-body-save" || action === "fact-confirm") {
        const attr = form.attribute?.trim() ?? "";
        const isNew = action === "fact-set" && !!attr && !loadBrain(root).find((n) => n.fm.id === form.id?.replace(/\.md$/, ""))?.fm.facts?.[attr];
        try {
          const raw = runAction({ root, transport: opts.transport }, action, form);
          swiped(action);
          if (/: no change$/.test(raw)) return go(back, { ok: "No change." });
          const head = git(root, ["rev-parse", "HEAD"]);
          const ok = action === "note-body-save" ? "Saved the notes." : action === "fact-confirm" ? `Marked ${cap(attr)} as still true.` : isNew ? `Added ${cap(attr)}.` : `Saved ${cap(attr)}. The old value is under Earlier values.`;
          // A replaced single value can then be marked as never right: a correction, not a change.
          const replaced = action === "fact-set" && !isNew && !!loadBrain(root).find((n) => n.fm.id === form.id?.replace(/\.md$/, ""))?.fm.history?.[attr];
          return go(back, { ok, undo: head, wrong: replaced ? attr : undefined }, attr ? `#f-${encodeURIComponent(attr)}` : "");
        } catch (e) { return go(back, { err: fail(e) }); }
      }
      // Forgetting, correcting and who-can-see come back with Undo too. A forgotten note has no page.
      if (["note-forget", "note-bring-back", "fact-wrong", "note-hide", "note-show", "note-sensitivity"].includes(action)) {
        try {
          let ok = runAction({ root, transport: opts.transport }, action, form);
          const head = git(root, ["rev-parse", "HEAD"]);
          if (action === "note-sensitivity" && / now\.$/.test(ok)) {
            const seen = audience(loadState(root), form.id?.replace(/\.md$/, "") ?? "").seen;
            ok += seen.length ? ` Seen by ${names(seen.map((a) => agentLabel(loadRules(root), a)))}.` : " Only you can see it.";
          }
          const changed = / now\.$| again\.$| as it was\.$|^Forgot |^Marked /.test(ok);
          return go(action === "note-forget" ? "/brain" : back, { ok, undo: changed ? head : undefined });
        } catch (e) { return go(back, { err: fail(e) }); }
      }
      // Replaced connections deleted at the sign-in service (backlog 289): a network call, so awaited here.
      if (action === "oauth-cleanup") {
        loadKeys();
        const cut = await cleanupReplaced(root);
        if (cut.skipped && !cut.deleted.length) return go(back, { err: `nothing deleted: ${cut.skipped}` });
        return go(back, cut.failed.length ? { err: `Deleted ${cut.deleted.length} old app(s); ${cut.failed.length} failed (${cut.failed.map((f) => f.why).join(", ")}). They stay refused here.` } : { ok: `Deleted ${cut.deleted.length} old app${cut.deleted.length === 1 ? "" : "s"} at the sign-in service.` });
      }
      if (action) {
        try { const ok = runAction({ root, transport: opts.transport }, action, form); swiped(action); return go(back, { ok }); }
        catch (e) { return go(back, { err: fail(e) }); }
      }
      return text("not found", 404);
    }
    if (req.method !== "GET") return text("method not allowed", 405);

    // An approval on the phone shows up here even if the agent hasn't checked yet.
    if (askPolicy(loadRules(root))?.approver === "guardian") await pollAsks(root).catch(() => 0);
    const s = loadState(root);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const undo = url.searchParams.get("undo")?.match(/^[0-9a-f]{7,40}$/)?.[0];
    const wrong = url.searchParams.get("wrong")?.match(/^[a-z][a-z0-9_]*$/)?.[0];
    const noteId = p.match(/^\/note\/(.+)$/)?.[1].split("/").map(decodeURIComponent).join("/");
    const fix = wrong && noteId ? button(csrf, "fact-wrong", { id: noteId, attribute: wrong }, "It was never right", "", "The old value was a mistake, not something that changed? It stays in history, marked as never right.") : "";
    const withFlash = (pg: Page) => html({ ...pg, flash: flash && undo && !flash.err ? { ...flash, extra: button(csrf, "owner-undo", { hash: undo }, "Undo") + fix } : flash });
    if (p === "/") return withFlash(overview(s, csrf));
    if (p === "/deck") return new Response(deckPage(buildDeck(root), csrf, flash), { headers: PAGE_HEADERS });
    const editor = s.rules.policy.owner_editor;
    if (p === "/agents") return withFlash(agentsPage(s, csrf, oauthCard(s, csrf, loadOAuth(root), listPending(root)) + editorCard(s, csrf, editor, editor ? editorCommits(root, editor) : [])));
    if (p === "/agents/new") {
      const q = url.searchParams;
      const clientId = q.get("client_id") ?? "";
      const req = { agent: (q.get("agent") ?? "").trim(), name: q.get("name")?.trim().slice(0, 60) || undefined, slices: q.getAll("slices").flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean) };
      if (!listPending(root).some((x) => x.client_id === clientId)) return html({ title: "Gone", tab: "agents", body: "<h1>That connection isn't waiting any more</h1><a href=\"/agents\">Back</a>" }, 404);
      try { return html(newAgentPage(csrf, clientId, req, previewNewAgent(root, req))); }
      catch (e) { return html({ title: "Can't add", tab: "agents", body: `<h1>${esc(e instanceof Error ? e.message : String(e))}</h1><a href="/agents">Back</a>` }, 400); }
    }
    if (p === "/brain") return withFlash(brainPage(s, csrf, { q: url.searchParams.get("q") ?? "", kind: url.searchParams.get("kind") || url.searchParams.get("folder") || undefined }));
    // The search box asks for this as you type: results only, from this computer, no model.
    if (p === "/brain/results") return new Response(brainResults(s, csrf, (url.searchParams.get("q") ?? "").slice(0, 300)), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    const nm = p.match(/^\/note\/(.+)$/);
    if (nm) {
      const id = nm[1].split("/").map(decodeURIComponent).join("/");
      try {
        const note = editableNote(root, id);
        return withFlash(notePage(s, csrf, note, noteText(root, id), editor, url.searchParams.get("edit") ?? undefined));
      } catch (e) { return html({ title: "Not found", tab: "brain", body: `<h1>${esc(e instanceof Error ? e.message : String(e))}</h1>` }, e instanceof CoreError ? e.status : 500); }
    }
    const wm = p.match(/^\/why\/(.+)$/);
    if (wm) {
      const id = wm[1].split("/").map(decodeURIComponent).join("/");
      const attr = url.searchParams.get("fact") ?? "";
      const note = s.notes.find((n) => n.fm.id === id);
      try {
        if (!note) throw new CoreError(404, `no note ${id}`);
        return withFlash(whyPage(s, note, attr, ownerWhy(root, `${id}#${attr}`)));
      } catch (e) { return html({ title: "Not found", tab: "brain", body: `<h1>${esc(e instanceof Error ? e.message : String(e))}</h1>` }, e instanceof CoreError ? e.status : 500); }
    }
    // History, read from git: what changed this week, one note's facts over time, a note as it was.
    if (p === "/history") {
      const day = url.searchParams.get("at")?.match(/^\d{4}-\d{2}-\d{2}$/)?.[0];
      if (day) {
        const b = brainAt(root, day);
        return b ? withFlash(brainOnPage(s, day, b.notes, b.at)) : html({ title: "Not found", tab: "brain", body: `<h1>The brain has no saved version from ${esc(day)}</h1>` }, 404);
      }
      const days = 7;
      return withFlash(weekPage(s, savesSince(root, new Date(s.now.getTime() - days * 86_400_000).toISOString()), days));
    }
    const hm = p.match(/^\/history\/(.+)$/);
    if (hm) {
      const id = hm[1].split("/").map(decodeURIComponent).join("/");
      const note = s.notes.find((n) => n.fm.id === id);
      if (!note) return html({ title: "Not found", tab: "brain", body: `<h1>No note ${esc(id)}</h1>` }, 404);
      const versions = noteVersions(root, id);
      const saves = noteSaves(root, id, versions);
      const at = url.searchParams.get("at");
      if (at) {
        const v = versionAt(versions, at);
        return v ? withFlash(snapshotPage(s, csrf, note, v, saves, at)) : html({ title: "Not found", tab: "brain", body: "<h1>The note has no saved version from then</h1>" }, 404);
      }
      return withFlash(noteHistoryPage(s, csrf, note, saves, revertedHashes(root)));
    }
    const cp = p.match(/^\/consent\/([A-Za-z0-9_-]+)$/);
    if (cp) {
      const prop = consents.get(cp[1]);
      return prop ? html(consentPage(s, csrf, prop)) : html({ title: "Gone", tab: "agents", body: "<h1>That proposal is gone</h1>" }, 404);
    }
    const pr = p.match(/^\/proposal\/([A-Za-z0-9_-]+)$/);
    if (pr) {
      const prop = proposals.get(pr[1]);
      return prop ? withFlash(proposalPage(s, csrf, prop)) : html({ title: "Gone", tab: "brain", body: "<h1>That proposal is gone</h1>" }, 404);
    }
    if (p === "/fga") return withFlash(await fgaPage(s));
    if (p === "/fga/grid") return new Response(await fgaGrid(s), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" } });
    if (p === "/map") return withFlash(mapPage(s, url.searchParams.get("as") || undefined));
    // The map page asks for this every 2 seconds, so a revoke or an FGA change shows as it lands.
    if (p === "/map/grid") return new Response(mapGrid(s, url.searchParams.get("as") || undefined), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" } });
    if (p === "/activity") return withFlash(activityPage(s, url.searchParams.get("agent") || undefined, url.searchParams.get("op") || undefined));
    if (p === "/upkeep") return withFlash(upkeepPage(s, csrf));
    if (p === "/digest") return withFlash(digestPage(s, csrf, latestDigest(root)));
    if (p === "/people") return withFlash(peoplePage(s, csrf));
    if (p === "/usage") return withFlash(usagePage(root, csrf, url.searchParams.get("month")?.match(/^\d{4}-\d{2}$/)?.[0]));
    const m = p.match(/^\/agent\/([a-z0-9_-]+)(\/view)?$/i);
    if (m) {
      const name = decodeURIComponent(m[1]);
      if (m[2]) {
        const rules = loadRules(root);
        if (!s.agents.some((a) => a.name === name)) return text("no such agent", 404);
        const notes = loadBrain(root);
        return text(renderView(notes, rules, carve(notes, rules, grantFor(rules, name)), root));
      }
      const pg = agentPage(s, csrf, name);
      return pg ? withFlash(pg) : html({ title: "Not found", tab: "", body: `<h1>No agent ${esc(name)}</h1>` }, 404);
    }
    return html({ title: "Not found", tab: "", body: "<h1>Not found</h1>" }, 404);
  }

  return { loginKey, setPort, handle: async (req: Request) => {
    try { return await handle(req); }
    catch (e) { console.error(e); return text("internal error", 500); }
  } };
}

export function serveDashboard(root: string, opts: DashboardOptions = {}) {
  const hostname = opts.hostname ?? "127.0.0.1";
  if (!LOOPBACK.has(hostname)) throw new Error(`the dashboard binds to loopback only (got ${hostname}); reach it from elsewhere with an SSH tunnel`);
  const port = opts.port ?? 8788;
  const h = dashboardHandler(root, { ...opts, port });
  const server = Bun.serve({ port, hostname, fetch: h.handle });
  h.setPort(server.port!);
  const loginUrl = `http://${hostname === "::1" ? "[::1]" : hostname}:${server.port}/login?key=${h.loginKey}`;
  return { server, loginUrl };
}
