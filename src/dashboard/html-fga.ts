// SPDX-License-Identifier: AGPL-3.0-only
// The second lock, as FGA holds it: every agent→slice relationship in the FGA store, read live from
// the FGA server on each load and every 2 seconds after, so a relationship deleted there disappears
// here as it happens. Useful when the store is a local OpenFGA server with no console of its own.
// Owner only, read-only.
import { loadFga, FgaClient, fgaStatus, type Tuple } from "../fga";
import type { State } from "./data";
import { esc, type Page } from "./html";

const sliceLabel = (object: string) => object.replace(/^slice:/, "").replace(/__/g, ":").replace(/^area:/, "");

export async function fgaGrid(s: State, client?: FgaClient): Promise<string> {
  const c = loadFga(s.root);
  if (!c) return '<div class="card empty">FGA is off for this brain (docs/fga.md).</div>';
  let tuples: Tuple[];
  try { tuples = await (client ?? new FgaClient(c)).readAll(); }
  catch (e) { return `<div class="card"><span class="kind k-alert">unreachable</span> ${esc((e as Error).message)}. While FGA can't be asked, assistants lose their slices (it fails closed).</div>`; }
  const label = (user: string) => { const a = user.replace(/^agent:/, ""); return s.rules.policy.agents[a]?.label ?? a; };
  const rows = tuples.filter((t) => t.user.startsWith("agent:") && t.object.startsWith("slice:"))
    .sort((a, b) => label(a.user).localeCompare(label(b.user)) || a.object.localeCompare(b.object))
    .map((t) => `<tr><td>${esc(label(t.user))}</td><td class="sub">can read</td><td>${esc(sliceLabel(t.object))} <span class="mono sub">${esc(t.object)}</span></td></tr>`).join("");
  const st = fgaStatus();
  const hub = st.on ? `The hub last asked FGA ${Math.min(...st.agents.map((a) => a.age_s), 999)} s ago.` : "";
  return `<div class="card wrap"><table><thead><tr><th>Assistant</th><th></th><th>Slice</th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="sub">No relationships: no assistant gets any slice.</td></tr>'}</tbody></table></div><p class="sub">${tuples.length} relationship${tuples.length === 1 ? "" : "s"} in the store. ${hub}</p>`;
}

const SCRIPT = `<script>
(function(){var g=document.getElementById("fga-grid");if(!g)return;
setInterval(function(){fetch("/fga/grid",{credentials:"same-origin"}).then(function(r){return r.ok?r.text():""}).then(function(t){if(t&&t!==g.innerHTML)g.innerHTML=t}).catch(function(){})},2000)})();
</script>`;

export async function fgaPage(s: State): Promise<Page> {
  const c = loadFga(s.root);
  const where = c ? `${esc(c.api_url)}, store <span class="mono">${esc(c.store_id)}</span>` : "";
  const body = `<h1>Second lock: FGA</h1><p class="sub">Before every answer the hub asks FGA which slices each assistant may read; a slice FGA doesn't confirm is cut, even if the rules grant it. FGA holds who may read which slice, never a note or what it says. Read live from ${where}.</p>
<div id="fga-grid">${await fgaGrid(s)}</div>${SCRIPT}`;
  return { title: "Second lock", tab: "map", body };
}
