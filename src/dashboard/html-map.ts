// SPDX-License-Identifier: AGPL-3.0-only
// "Who sees what": every note against every outside agent, in one grid. Each cell comes from the
// same carve the agent gets (so FGA, pauses and revokes show up as they happen): the whole note,
// part of it (some facts cut), "ask" (outside its slice, but it may ask the owner for one read),
// or nothing. A column goes dark when the agent has no way in: paused, no key left after Revoke,
// or a coworker whose account is blocked or deleted at the sign-in service. The page refreshes
// the grid every 2 seconds. Owner only, read-only.
import { folderOf } from "../carve";
import { sensitivityRank } from "../brain";
import { askPolicy, asksOn } from "../asks";
import { clientsOf, loadOAuth } from "../oauth";
import { offboardingStatus } from "../offboard";
import type { State } from "./data";
import { esc, type Page } from "./html";
import { previewSearch, previewRead, CoreError } from "../core";
import { paged, pager, withParam } from "./paging";

export type Cell = "all" | "part" | "ask" | "none";
export interface MapColumn { agent: string; label: string; off?: string; cells: Map<string, Cell> }

// Why an agent can't get in at all right now, or undefined if it can.
function offReason(s: State, agent: string): string | undefined {
  const a = s.rules.policy.agents[agent];
  if (a?.status === "paused") return "paused";
  const o = loadOAuth(s.root);
  const coworkers = Object.entries(o?.coworkers ?? {}).filter(([, c]) => c.agent === agent);
  if (coworkers.length) {
    const st = new Map(offboardingStatus().coworkers.map((c) => [c.subject, c.standing]));
    if (coworkers.every(([sub]) => st.get(sub) === "blocked" || st.get(sub) === "gone")) return "left, cut at sign-in";
    return undefined;
  }
  const row = s.agents.find((x) => x.name === agent);
  const machines = Object.values(o?.machines ?? {}).some((m) => m.agent === agent);
  if (!row?.tokens && !clientsOf(s.root, agent).length && !machines) return "no key";
  return undefined;
}

export function accessMap(s: State): { rows: { id: string; title: string; folder: string; sensitivity: string }[]; columns: MapColumn[] } {
  const notes = s.notes.filter((n) => n.fm.status === "active" && folderOf(n) !== "agents")
    .sort((a, b) => folderOf(a).localeCompare(folderOf(b)) || a.fm.title.localeCompare(b.fm.title));
  const p = askPolicy(s.rules);
  const never = new Set(p?.never ?? []);
  const askable = (id: string) => {
    const n = notes.find((x) => x.fm.id === id)!;
    return sensitivityRank(n.fm.sensitivity) <= sensitivityRank("private") && !never.has(folderOf(n)) && !never.has(n.fm.type) && !never.has(n.fm.area ?? "");
  };
  // The resolver is the owner's own desk assistant (it settles conflicts and sees everything): not a column.
  const columns = s.agents.filter((a) => !a.resolver).map((a) => {
    const res = s.carves.get(a.name)!;
    const off = offReason(s, a.name);
    const hidden = new Set(res.hiddenFacts.map((h) => h.key.split("#")[0]));
    const canAsk = !!p && asksOn(s.rules, a.name);
    const cells = new Map<string, Cell>();
    for (const n of notes) {
      const id = n.fm.id;
      cells.set(id, off ? "none" : res.visible.has(id) ? (hidden.has(id) ? "part" : "all") : canAsk && askable(id) ? "ask" : "none");
    }
    return { agent: a.name, label: a.label, off, cells };
  });
  return { rows: notes.map((n) => ({ id: n.fm.id, title: n.fm.title, folder: folderOf(n), sensitivity: n.fm.sensitivity })), columns };
}

const CELL: Record<Cell, string> = {
  all: '<span class="m-dot m-all" title="sees the whole note"></span>',
  part: '<span class="m-dot m-part" title="sees part: some facts are cut"></span>',
  ask: '<span class="m-ask" title="outside its slice; it may ask you for one read, and you decide each time"></span>',
  none: "",
};

// With `as`, one assistant's view: its column stands out, the others fade, and every note it can't
// read fades too, so the page shows the brain as that assistant gets it. Same carve, read-only.
export function mapGrid(s: State, as?: string, page = 1): string {
  const m = accessMap(s);
  const rows = paged(m.rows, page);
  const me = m.columns.find((c) => c.agent === as);
  const sees = (c: MapColumn) => [...c.cells.values()].filter((x) => x === "all" || x === "part").length;
  const cls = (c: MapColumn) => `${c.off ? " m-off" : ""}${me ? (c === me ? " m-me" : " m-dim") : ""}`;
  const head = m.columns.map((c) => `<th class="m-col${cls(c)}"><a href="${c === me ? "/map" : `/map?as=${encodeURIComponent(c.agent)}`}" title="${c === me ? "Back to every assistant" : `See the brain as ${esc(c.label)} sees it`}">${esc(c.label)}</a>${c.off ? `<div class="m-why">${esc(c.off)}</div>` : ""}</th>`).join("");
  let folder = "";
  const body = rows.rows.map((r) => {
    const sep = r.folder !== folder ? `<tr class="m-folder"><td colspan="${m.columns.length + 1}">${esc((folder = r.folder))}</td></tr>` : "";
    const lock = sensitivityRank(r.sensitivity as never) >= sensitivityRank("private") ? ` <span class="kind">${esc(r.sensitivity)}</span>` : "";
    const mine = me?.cells.get(r.id);
    const gone = me && mine !== "all" && mine !== "part";
    return `${sep}<tr${gone ? ' class="m-gone"' : ""}><td title="${esc(r.id)}"><a href="/p/${r.id.split("/").map(encodeURIComponent).join("/")}">${esc(r.title)}</a>${lock}${me && mine === "part" ? ' <span class="sub">some facts cut</span>' : ""}</td>${m.columns.map((c) => `<td class="m-cell${cls(c)}">${CELL[c.cells.get(r.id)!]}</td>`).join("")}</tr>`;
  }).join("");
  const totals = m.columns.map((c) => `<td class="m-cell num${cls(c)}">${sees(c)}</td>`).join("");
  const n = me ? sees(me) : 0;
  const lede = !me ? "" : me.off
    ? `<p class="lede">${esc(me.label)} can't get in right now (${esc(me.off)}). The brain doesn't exist for it.</p>`
    : `<p class="lede">${esc(me.label)} can read <b>${n} of ${m.rows.length}</b> notes. The rest don't exist for it: it can't search them, open them or hear about them from another assistant.</p>`;
  return `${lede}<div class="card wrap m-map"><table><thead><tr><th>Note</th>${head}</tr></thead><tbody>${body}<tr class="m-total"><td>Notes it can read</td>${totals}</tr></tbody></table></div>${pager(rows, (n) => withParam("/map", new URLSearchParams(as ? { as } : {}), "page", n), "notes")}`;
}

const STYLE = `<style>
.m-map th.m-col,.m-map td.m-cell{text-align:center;width:1%;white-space:nowrap}
.m-map th.m-col{white-space:normal;min-width:72px;max-width:104px;line-height:18px;vertical-align:bottom}.m-map td:first-child{white-space:normal;min-width:180px}
.m-dot{display:inline-block;width:16px;height:16px;border-radius:50%;vertical-align:middle;border:1.5px solid var(--good)}.m-all{background:var(--good)}.m-part{background:linear-gradient(90deg,var(--good) 50%,transparent 50%)}
.m-ask{display:inline-block;width:14px;height:14px;border-radius:50%;vertical-align:middle;border:1.5px dashed var(--text-2)}
.m-off{background:repeating-linear-gradient(135deg,var(--well) 0 6px,var(--bg) 6px 12px);color:var(--muted)}.m-why{font-size:11px;font-weight:400;color:var(--bad)}
.m-folder td{font-size:12px;color:var(--text-2);background:var(--well);text-transform:capitalize}
.m-total td{font-weight:600}
.m-map th.m-col{color:var(--text);font-weight:500}.m-map th.m-col.m-off{color:var(--muted)}
.m-map td,.m-map th{transition:background .4s,opacity .4s}
.m-map th.m-col a{color:inherit;text-decoration:none}.m-map th.m-col a:hover{text-decoration:underline;text-decoration-color:var(--line-strong)}
.m-map .m-dim{opacity:.25}.m-map th.m-me{font-weight:700;box-shadow:inset 0 -2px 0 var(--text)}.m-map td.m-me{background:var(--well)}
.m-see{margin:8px 0}.m-as{white-space:pre-wrap;background:var(--well);padding:12px;border-radius:6px;overflow-x:auto}.m-hits li{margin:4px 0}
.m-map tr.m-gone>td:first-child a{color:var(--muted);font-weight:400}.m-map tr.m-gone>td:first-child .kind{opacity:.5}
@media (max-width:560px){.m-map td:first-child{min-width:120px}.m-map th.m-col{min-width:56px}}
</style>`;

const SCRIPT = `<script>
(function(){var g=document.getElementById("map-grid");if(!g)return;
setInterval(function(){fetch("/map/grid"+location.search,{credentials:"same-origin"}).then(function(r){return r.ok?r.text():""}).then(function(t){if(t&&t!==g.innerHTML)g.innerHTML=t}).catch(function(){})},2000)})();
</script>`;

// See as (backlog #313): search and open notes exactly as the chosen assistant gets them (its
// snapshot, ranking and [withheld] marks, from previewSearch / previewRead in core.ts), without
// it counting as that assistant's read. An error is what the assistant itself would be told.
function seeAs(s: State, agent: string, label: string, q: string, read: string): string {
  const link = (id: string) => `/map?as=${encodeURIComponent(agent)}&read=${encodeURIComponent(id)}`;
  const said = (e: unknown) => { if (e instanceof CoreError) return `<p class="sub">${esc(label)} would be told: <b>${esc(e.message)}</b></p>`; throw e; };
  let out = "";
  if (read) {
    try { out = `<h2>${esc(read)}, as ${esc(label)} reads it</h2><pre class="m-as">${esc(previewRead(s.root, agent, read).markdown)}</pre>`; }
    catch (e) { out = said(e); }
  } else if (q) {
    try {
      const hits = previewSearch(s.root, agent, q);
      out = hits.length ? `<ol class="m-hits">${hits.map((h) => `<li><a href="${esc(link(h.id))}">${esc(h.title)}</a> <span class="sub">${esc(h.id)} · ${esc(h.match)}</span></li>`).join("")}</ol>` : `<p class="sub">${esc(label)} would find nothing for that.</p>`;
    } catch (e) { out = said(e); }
  }
  return `<form method="get" action="/map" class="m-see"><input type="hidden" name="as" value="${esc(agent)}"><label>Search as ${esc(label)} <input type="search" name="q" value="${esc(q)}" maxlength="300"></label> <button>Search</button></form>
<p class="sub">Exactly what ${esc(label)} gets back, ranking and [withheld] marks included. Looking here doesn't count as its read.</p>${out}`;
}

export function mapPage(s: State, as?: string, page = 1, see: { q?: string; read?: string } = {}): Page {
  const me = as ? s.agents.find((a) => a.name === as && !a.resolver) : undefined;
  const legend = `<span class="m-dot m-all"></span> the whole note · <span class="m-dot m-part"></span> part of it, some facts cut · <span class="m-ask"></span> outside its slice: it can only ask you for one read, and you decide each time · empty: never offered, it doesn't exist for that assistant.`;
  const head = me
    ? `<h1>As ${esc(me.label)} sees it</h1>`
    : `<h1>Who sees what</h1><p class="sub">Every note against every assistant, from the same rules that answer them. ${legend} Click an assistant to see the brain as it does. Updates by itself.</p>`;
  const body = `${STYLE}${head}
${me ? seeAs(s, me.name, me.label, (see.q ?? "").slice(0, 300), (see.read ?? "").slice(0, 300)) : ""}
<div id="map-grid">${mapGrid(s, me?.name, page)}</div>${me ? `<p class="sub">${legend}</p>` : ""}${SCRIPT}`;
  return { title: me ? `As ${me.label} sees it` : "Who sees what", tab: "map", body };
}
