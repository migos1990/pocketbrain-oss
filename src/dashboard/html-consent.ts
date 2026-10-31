// SPDX-License-Identifier: AGPL-3.0-only
// Consent in plain words on the dashboard (src/consent.ts, docs/consent.md): a one-line form on an
// assistant's page, and the proposal page with examples and an Apply button. Existing classes only.
import type { State } from "./data";
import { esc, button, type Page } from "./html";
import { plain, agentLabel } from "./labels";
import type { Proposal, Example } from "../consent";

export interface ConsentProposal extends Proposal { id: string }

const noteHref = (id: string) => `/p/${id.split("/").map(encodeURIComponent).join("/")}`;
const list = (xs: Example[], empty: string) => xs.length ? xs.map((x) => `<div><a href="${noteHref(x.id)}" title="${esc(x.id)}">${esc(x.title)}</a> <span class="sub">${esc(x.why)}</span></div>`).join("") : `<div class="empty">${esc(empty)}</div>`;

// The card on an assistant's page. Its slice changes only after the owner applies a proposal.
export function consentCard(csrf: string, agent: string, label: string): string {
  return `<h2 id="for">What is ${esc(label)} for?</h2>
<p class="sub">Say it in one sentence. You get the slice it would see, with examples, before anything changes.</p>
<form method="post" action="/consent/${encodeURIComponent(agent)}" class="acts"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="text" name="intent" maxlength="300" placeholder="Handles family logistics" aria-label="What is ${esc(label)} for?" autocomplete="off" style="flex:1;min-width:200px"><button>Propose</button></form>`;
}

export function consentPage(s: State, csrf: string, p: ConsentProposal): Page {
  const label = agentLabel(s.rules, p.agent);
  const sees = p.slices.map(plain).join(", ");
  const without = p.exclude_types.length ? `, without ${p.exclude_types.map(plain).join(", ")}` : "";
  const before = p.before ? `<p class="sub">Today it sees ${p.before.notes} note${p.before.notes === 1 ? "" : "s"} (${esc(p.before.slices.map(plain).join(", ") || "nothing")}${p.before.exclude_types.length ? `, without ${esc(p.before.exclude_types.map(plain).join(", "))}` : ""}).</p>` : "";
  // G183: before the one-click Apply, say when the proposal shows more than today and when money stays in.
  const warn = [
    p.widens ? `This shows ${esc(label)} more than it sees today: notes, facts or values it can't see now.` : "",
    !p.exclude_types.includes("money") ? `Money is kept in: ${esc(label)} would see money notes in these areas, because your words ask for money matters.` : "",
  ].filter(Boolean).map((t) => `<p class="lede"><span class="kind k-alert">Check</span> ${t}</p>`).join("");
  const apply = p.isNew
    ? `<p>${esc(label)} isn't set up yet. Add it with:</p><pre class="pv">${esc(p.command)}</pre>`
    : `<div class="acts">${button(csrf, "consent-apply", { pid: p.id }, `Let ${label} see this`, "go")}${button(csrf, "consent-discard", { pid: p.id }, "Discard")}</div>`;
  const body = `<div class="b-crumbs"><a href="/agents">Assistants</a> / <a href="/agent/${encodeURIComponent(p.agent)}">${esc(label)}</a></div><h1>What ${esc(label)} would see</h1>
<p class="sub">You wrote: “${esc(p.intent)}”</p>
<p class="lede"><b>${p.notes} of ${p.total}</b> notes: ${esc(sees)}${esc(without)}.${p.why ? ` <span class="sub">${esc(p.why)}</span>` : ""}</p>
${before}${warn}${p.note ? `<p class="sub">${esc(p.note)}</p>` : ""}
<div class="grid2"><div><h3>It would see, for example</h3><div class="card">${list(p.sees, "Nothing.")}</div></div>
<div><h3>It would not see</h3><div class="card">${list(p.hidden, "Nothing is left out.")}</div></div></div>
<div style="height:16px"></div>${apply}
<p class="sub">Proposed by ${esc(p.by === "rules" ? "your words alone" : p.by)}. Nothing changes until you apply it.</p>`;
  return { title: `What ${label} would see`, tab: "agents", body };
}
