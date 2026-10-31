// SPDX-License-Identifier: AGPL-3.0-only
// One page of a long list, and the links to the others (backlog #295). Every list on the owner's
// pages that grows with the brain or its logs (Needs you, alerts, notes in a slice, the map,
// history, activity) shows PAGE_SIZE rows at a time; the page number rides in the query string.
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const PAGE_SIZE = 200;

export interface Paged<T> { rows: T[]; page: number; pages: number; total: number; from: number }

// The page asked for, clamped to the pages there are; page 1 when the parameter is missing or junk.
export function paged<T>(items: T[], page: number | undefined, size = PAGE_SIZE): Paged<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(1, Math.floor(page ?? 1) || 1), pages);
  return { rows: items.slice((p - 1) * size, p * size), page: p, pages, total: items.length, from: (p - 1) * size };
}

export function pageParam(url: URL, name = "page"): number {
  const n = Number(url.searchParams.get(name));
  return Number.isInteger(n) && n > 0 ? n : 1;
}

// "201–400 of 7,104" with Previous and Next; nothing when everything fits on one page. `href`
// gets a page number and returns the link, keeping the page's other parameters.
export function pager<T>(p: Paged<T>, href: (page: number) => string, what = "rows"): string {
  if (p.pages <= 1) return "";
  const n = (x: number) => x.toLocaleString("en");
  const link = (page: number, label: string, rel: string) => `<a class="btn" rel="${rel}" href="${esc(href(page))}">${label}</a>`;
  return `<nav class="pager" aria-label="Pages of ${esc(what)}"><span class="sub">${n(p.from + 1)}–${n(p.from + p.rows.length)} of ${n(p.total)} ${esc(what)}</span>${p.page > 1 ? link(p.page - 1, "Previous", "prev") : ""}${p.page < p.pages ? link(p.page + 1, "Next", "next") : ""}</nav>`;
}

// A link to the same page with one parameter changed.
export function withParam(base: string, params: URLSearchParams, name: string, value: number): string {
  const q = new URLSearchParams(params);
  if (value <= 1) q.delete(name); else q.set(name, String(value));
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}
