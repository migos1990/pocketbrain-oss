// SPDX-License-Identifier: AGPL-3.0-only
// The Usage page: the brain's own model spend (src/usage.ts), for the owner only. Agents never
// see any of this. Reads and writes are not metered, so they don't appear here.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { git } from "../git";
import { OWNER } from "../owner";
import { CoreError } from "../core";
import { summary, capState, usageItem, money, fmtMinutes, usagePolicy, type Totals } from "../usage";
import { loadRules } from "../rules";
import { esc, button, type Page } from "./html";

const tok = (t: Totals) => `${(t.tokens_in + t.tokens_out).toLocaleString("en")}${t.estimated ? "~" : ""}`;

export function usagePage(root: string, csrf: string, month?: string): Page {
  const s = summary(root, { month });
  const cap = capState(root);
  const p = usagePolicy(loadRules(root));
  const m = (n: number) => esc(money(n, cap.currency));
  const pct = cap.cap !== undefined ? Math.floor((cap.ratio ?? 0) * 100) : undefined;
  const bar = cap.cap !== undefined
    ? `<div style="height:10px;border-radius:99px;background:var(--chip);overflow:hidden;margin:8px 0 4px"><div style="height:100%;width:${Math.min(100, pct!)}%;background:${cap.state === "over" ? "var(--bad)" : cap.state === "warn" ? "var(--warn)" : "var(--good)"}"></div></div>`
    : "";
  const item = usageItem(root);
  const kpi = (v: string, l: string) => `<div class="kpi"><div class="n">${v}</div><div class="l">${esc(l)}</div></div>`;
  const cells = (t: Totals) => `<td class="num">${t.calls}</td><td class="num">${t.errors}</td><td class="num">${tok(t)}</td><td class="num">${esc(fmtMinutes(t.seconds))}</td><td class="num">${m(t.cost)}</td>`;
  const head = (first: string, extra = "") => `<thead><tr><th>${first}</th><th class="num">Calls</th><th class="num">Errors</th><th class="num">Tokens</th><th class="num">Model time</th><th class="num">Cost</th>${extra}</tr></thead>`;
  const prices = p.prices ?? {};
  const body = `<h1>Model spend, ${esc(s.month)}</h1>
<p class="sub">What the brain's own model steps cost you: sleep, the duplicate judge, capture and Ask. Reads and writes are never metered or capped. Assistants never see this page or the cap.</p>
${item ? `<div class="flash${item.state === "over" ? " err" : ""}">${esc(item.title)}</div>` : ""}
<div class="card"><b>${m(s.total.cost)}</b> this month${cap.cap !== undefined ? ` of a ${m(cap.cap)} cap (${pct}%)` : ", no cap set"}${bar}
<div class="sub">Past the cap, model steps pause and say so in the morning note; everything else keeps working. ${cap.cap !== undefined ? `You hear about it at ${Math.round(cap.alert_at * 100)}% and at 100%.` : ""}</div>
<div style="margin-top:10px"><form class="inline" method="post" action="/action/usage-cap"><input type="hidden" name="csrf" value="${esc(csrf)}"><label for="u-cap">Monthly cap</label> <input type="text" id="u-cap" name="monthly" value="${cap.cap ?? ""}" size="6" inputmode="decimal"> ${esc(cap.currency)} <button class="go">Set</button></form>
${cap.cap !== undefined ? button(csrf, "usage-cap", { monthly: "none" }, "Remove the cap", "danger", "Remove the cap? Model steps will run however much the month costs.") : ""}</div></div>
<div class="kpis">${kpi(String(s.total.calls), "model calls this month")}${kpi(tok(s.total), "tokens")}${kpi(esc(fmtMinutes(s.total.seconds)), "model time")}${kpi(String(s.total.errors), "failed calls")}</div>
<h2>By step</h2>${s.steps.length ? `<div class="card wrap"><table>${head("Step", '<th class="num">Cap</th><th>Model</th>')}<tbody>${s.steps.map((st) => {
    const c = cap.steps.find((x) => x.step === st.step);
    return `<tr><td class="mono">${esc(st.step)}</td>${cells(st)}<td class="num">${c ? `${m(c.cap)}${c.over ? ' <span class="status st-paused">paused</span>' : ""}` : '<span class="sub">none</span>'}</td><td class="sub">${esc(st.models)}</td></tr>`;
  }).join("")}</tbody></table></div>` : '<div class="card empty">No model calls this month.</div>'}
<h2>By day</h2>${s.days.length ? `<div class="card wrap"><table>${head("Day")}<tbody>${s.days.slice().reverse().map((d) => `<tr><td class="mono">${esc(d.day)}</td>${cells(d)}</tr>`).join("")}</tbody></table></div>` : '<div class="card empty">Nothing yet.</div>'}
<h2>Prices</h2><div class="card sub">Tokens are priced at each model's list price (src/pricing.ts; a local model costs 0)${prices.model_input_per_million !== undefined || prices.model_output_per_million !== undefined ? `, overridden in policy.yaml to ${m(prices.model_input_per_million ?? 0)} in / ${m(prices.model_output_per_million ?? 0)} out per million` : ""}${prices.model_minute ? `, plus ${m(prices.model_minute)} per model minute` : ""}. Each call keeps the price it ran at.${s.total.unpriced ? " Some calls used a model with no listed price and count as 0: add its price under <span class=\"mono\">usage.prices</span>." : ""}${s.total.estimated ? " ~ marks token counts estimated from text length." : ""}</div>`;
  return { title: "Model spend", tab: "usage", body };
}

// The owner sets or removes the monthly cap: a commit to rules/policy.yaml by the owner.
export function setMonthlyCap(root: string, raw: string): string {
  const v = raw.trim().toLowerCase();
  const n = v === "none" || v === "" ? undefined : Number(v.replace(/^\$/, ""));
  if (n !== undefined && (!Number.isFinite(n) || n <= 0)) throw new CoreError(400, "the cap is an amount above 0, or none");
  const file = join(root, "rules", "policy.yaml");
  const doc = YAML.parseDocument(readFileSync(file, "utf8"));
  if (n === undefined) doc.deleteIn(["usage", "cap", "monthly"]);
  else doc.setIn(["usage", "cap", "monthly"], n);
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
  git(root, ["add", "rules/policy.yaml"]);
  git(root, ["commit", "-q", "-m", `${OWNER}: monthly model spend cap ${n === undefined ? "removed" : n}\n\nKind: usage-cap`, "--", "rules/policy.yaml"], OWNER);
  return n === undefined ? "model spend cap removed" : `monthly model spend cap set to ${money(n, capState(root).currency)}`;
}
