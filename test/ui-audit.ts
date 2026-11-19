// SPDX-License-Identifier: AGPL-3.0-only
// Page checks for the owner dashboard and the browser door, run in a real Chromium (Playwright):
// the WCAG 2.2 AA rules a test can decide (names, labels, landmarks, headings, contrast, focus),
// plus screenshot baselines compared pixel by pixel in the browser itself, so no image library
// is needed. Used by test/ui-quality.test.ts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Everything here runs inside the page. Returns one line per problem, with a selector-ish hint.
export async function audit(page: any): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const where = (el: Element) => {
      const id = el.id ? `#${el.id}` : "";
      const cls = el.getAttribute("class") ? `.${el.getAttribute("class")!.trim().split(/\s+/).join(".")}` : "";
      const txt = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      return `<${el.tagName.toLowerCase()}${id}${cls}>${txt ? ` "${txt}"` : ""}`;
    };
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const name = (el: Element): string => {
      const aria = el.getAttribute("aria-label");
      if (aria?.trim()) return aria.trim();
      const by = el.getAttribute("aria-labelledby");
      if (by) return by.split(/\s+/).map((i) => document.getElementById(i)?.textContent ?? "").join(" ").trim();
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
        const lab = [...(el.labels ?? [])].map((l) => l.textContent ?? "").join(" ").trim();
        if (lab) return lab;
      }
      const t = (el.textContent ?? "").trim();
      if (t) return t;
      const img = el.querySelector("img[alt],[role=img][aria-label]");
      if (img) return img.getAttribute("alt") || img.getAttribute("aria-label") || "";
      if (el instanceof HTMLInputElement && ["submit", "button"].includes(el.type)) return el.value;
      return el.getAttribute("title")?.trim() ?? "";
    };

    if (!document.documentElement.lang) out.push("html has no lang");
    if (!document.title.trim()) out.push("page has no title");
    if (!document.querySelector("main,[role=main]")) out.push("no <main> landmark");
    const h1 = document.querySelectorAll("h1");
    if (h1.length !== 1) out.push(`${h1.length} <h1> on the page (want exactly one)`);
    let last = 0;
    for (const h of document.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
      const lv = Number(h.tagName[1]);
      if (last && lv > last + 1) out.push(`heading jumps from h${last} to h${lv}: ${where(h)}`);
      last = lv;
    }
    const ids = new Map<string, number>();
    for (const el of document.querySelectorAll("[id]")) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
    for (const [id, n] of ids) if (n > 1) out.push(`id "${id}" used ${n} times`);
    for (const el of document.querySelectorAll("input:not([type=hidden]),select,textarea")) {
      if (!visible(el)) continue;
      if (!name(el)) out.push(`form field without a label: ${where(el)}`);
    }
    for (const el of document.querySelectorAll("a[href],button,[role=button]")) {
      if (!visible(el)) continue;
      if (!name(el)) out.push(`${el.tagName.toLowerCase()} without a name: ${where(el)}`);
    }
    for (const el of document.querySelectorAll("img")) if (!el.hasAttribute("alt")) out.push(`img without alt: ${where(el)}`);

    // Contrast of every visible text node's element against the first opaque background behind it.
    const rgb = (c: string) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return undefined; const [r, g, b, a = "1"] = m[1].split(/[,\s/]+/).filter(Boolean); return [Number(r), Number(g), Number(b), Number(a)]; };
    const lum = ([r, g, b]: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const bgOf = (el: Element | null): number[] => {
      for (let e = el; e; e = e.parentElement) {
        const c = rgb(getComputedStyle(e).backgroundColor);
        if (c && c[3] > 0.9) return c;
        if (getComputedStyle(e).backgroundImage !== "none") return [];
      }
      const root = rgb(getComputedStyle(document.documentElement).backgroundColor);
      return root && root[3] > 0.9 ? root : (matchMedia("(prefers-color-scheme: dark)").matches && getComputedStyle(document.documentElement).colorScheme.includes("dark") ? [18, 18, 18, 1] : [255, 255, 255, 1]);
    };
    const seen = new Set<Element>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !n.textContent?.trim() || !visible(el)) continue;
      if (el.closest("script,style,svg,[aria-hidden=true]")) continue;
      seen.add(el);
      const cs = getComputedStyle(el);
      const fg = rgb(cs.color);
      const bg = bgOf(el);
      if (!fg || !bg.length || Number(cs.opacity) < 1) continue;
      // Blend a translucent text colour over its background.
      const a = fg[3];
      const f = [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
      const [hi, lo] = [lum(f), lum(bg)].sort((x, y) => y - x);
      const ratio = (hi + 0.05) / (lo + 0.05);
      const size = parseFloat(cs.fontSize);
      const bold = Number(cs.fontWeight) >= 700;
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      if (ratio < need - 0.01) out.push(`contrast ${ratio.toFixed(2)} < ${need}: ${where(el)} (${cs.color} on rgb(${bg.slice(0, 3).join(",")}))`);
    }
    return out;
  });
}

// The owner app's type scale: every size a visible word is set in comes from here, and one page
// uses at most TYPE_MAX of them (design checklist, 2026-11-19).
export const TYPE_SCALE = [11, 13, 15, 17, 19, 22, 30, 44, 56, 60];
export const TYPE_MAX = 8;
// A highlight this short stays on one line.
export const SHORT_MARK = 28;

// Touch checks for the owner app on a phone, measured where a finger lands (elementFromPoint), so
// a small glyph with a larger hit area passes and a large box covered by another fails:
// a control standing on its own takes a tap 44 px high and 24 px wide (WCAG 2.2 target size, the
// platform's 44 for height); a link inside a sentence, 24 by 24. Then: a short highlight never
// breaks across lines; text sizes come from the scale; a big numeral is set in tabular figures;
// the tap flash, the selection and the typing cursor are the app's own, not the browser's.
export async function touch(page: any): Promise<string[]> {
  return page.evaluate(async ({ scale, max, short }: { scale: number[]; max: number; short: number }) => {
    const out: string[] = [];
    const where = (el: Element) => {
      const cls = el.getAttribute("class") ? `.${el.getAttribute("class")!.trim().split(/\s+/).join(".")}` : "";
      const txt = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      return `<${el.tagName.toLowerCase()}${cls}>${txt ? ` "${txt}"` : ""}`;
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    // In a line of text: a link laid out inline (it flows with words or other links), or a footnote mark.
    const inText = (el: Element) => getComputedStyle(el).display === "inline" || el.matches("a.b-ref");
    for (const el of document.querySelectorAll("a[href],button,[role=button],summary,select")) {
      if (!visible(el) || (el as HTMLButtonElement).disabled) continue;
      (el as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" });
      const rects = [...el.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      const r = rects.sort((a, b) => b.width - a.width)[0];
      if (!r) continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const hits = (x: number, y: number) => { const h = document.elementFromPoint(x, y); return !!h && (el.contains(h) || h.contains(el) && h.closest("a,button,summary,label") === h); };
      if (!hits(cx, cy)) continue; // covered or off the screen: not this check's
      const inline = inText(el);
      // How far the hit area reaches from the centre, each way, up to the size asked for.
      const reach = (x: number, y: number, most: number) => { let d = 0; while (d < most && hits(cx + x * (d + 1), cy + y * (d + 1))) d++; return d; };
      const needH = inline ? 24 : 44, needW = 24;
      const h = 1 + reach(0, -1, needH) + reach(0, 1, needH), w = 1 + reach(-1, 0, needW) + reach(1, 0, needW);
      if (h < needH || w < needW) out.push(`tap target under ${inline ? "24x24" : "24x44"} (${Math.round(r.width)}x${Math.round(r.height)} drawn): ${where(el)}`);
    }
    window.scrollTo(0, 0);
    for (const m of document.querySelectorAll("mark")) {
      if (visible(m) && (m.textContent ?? "").trim().length <= short && m.getClientRects().length > 1) out.push(`a short highlight breaks across lines: ${where(m)}`);
    }
    const sizes = new Set<number>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || !n.textContent?.trim() || !visible(el) || el.closest("script,style,svg,canvas")) continue;
      const cs = getComputedStyle(el), px = Math.round(parseFloat(cs.fontSize) * 10) / 10;
      if (!sizes.has(px) && !scale.includes(px)) out.push(`text size ${px}px is not on the type scale: ${where(el)}`);
      sizes.add(px);
      if (px >= 30 && /^[\d\s.,:%]+$/.test(n.textContent.trim()) && !cs.fontVariantNumeric.includes("tabular-nums")) out.push(`a big numeral is not in tabular figures: ${where(el)}`);
    }
    if (sizes.size > max) out.push(`${sizes.size} text sizes on one page (at most ${max}): ${[...sizes].sort((a, b) => a - b).join(", ")}`);
    const root = getComputedStyle(document.documentElement);
    const alpha = (c: string) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return 1; const p = m[1]!.split(/[,\s/]+/).filter(Boolean); return p.length > 3 ? Number(p[3]) : 1; };
    if (alpha((root as unknown as Record<string, string>).webkitTapHighlightColor ?? "") > 0) out.push("the browser's own tap flash is on (-webkit-tap-highlight-color)");
    const sel = getComputedStyle(document.body, "::selection").backgroundColor;
    if (!sel || alpha(sel) === 0) out.push("text selection has no colour of the app's own (::selection)");
    for (const f of document.querySelectorAll("input[type=text],input:not([type]),textarea")) {
      if (!visible(f)) continue;
      const cs = getComputedStyle(f);
      if (cs.caretColor === cs.color) out.push(`the typing cursor is the text colour, not the app's ink: ${where(f)}`);
    }
    return out;
  }, { scale: TYPE_SCALE, max: TYPE_MAX, short: SHORT_MARK });
}

// Tab through the page: every stop must be visible and show a focus ring.
export async function keyboard(page: any, stops = 40): Promise<string[]> {
  const out: string[] = [];
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < stops; i++) {
    await page.keyboard.press("Tab");
    const r = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return { done: true };
      const cs = getComputedStyle(el);
      // A field inside a box that draws the ring for it (data-focus-ring, e.g. the owner app's composer)
      // counts when that box shows an outline while the field has focus.
      const host = el.parentElement?.closest("[data-focus-ring]") as HTMLElement | null;
      const hs = host && host.matches(":focus-within") ? getComputedStyle(host) : undefined;
      const ring = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none" || (!!hs && hs.outlineStyle !== "none" && parseFloat(hs.outlineWidth) > 0);
      const b = el.getBoundingClientRect();
      return { done: false, ring, shown: b.width > 0 && b.height > 0, what: `<${el.tagName.toLowerCase()}> "${(el.textContent || el.getAttribute("aria-label") || (el as HTMLInputElement).name || "").trim().slice(0, 30)}"` };
    });
    if (r.done) break;
    if (!r.shown) out.push(`focus lands on something invisible: ${r.what}`);
    else if (!r.ring) out.push(`no visible focus ring: ${r.what}`);
  }
  return [...new Set(out)];
}

// Screenshot baselines in test/screenshots/ (JPEG, to keep the repo small; the threshold absorbs its noise). A missing baseline is written (commit it); set
// UPDATE_SCREENSHOTS=1 to rewrite them after a deliberate change. The comparison runs in the
// browser: both PNGs drawn on a canvas, pixels counted where any channel moves more than 32.
export const SHOTS = join(import.meta.dir, "screenshots");

export async function matchScreenshot(page: any, name: string, opts: { mask?: string[]; maxDiff?: number } = {}): Promise<string | undefined> {
  const file = join(SHOTS, `${name}.jpg`);
  mkdirSync(dirname(file), { recursive: true });
  const mask = (opts.mask ?? []).map((s) => page.locator(s));
  const now: Buffer = await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide", mask, maskColor: "#ff00ff", type: "jpeg", quality: 70 });
  if (!existsSync(file) || process.env.UPDATE_SCREENSHOTS === "1") {
    if (process.env.CI && !existsSync(file)) return `no baseline for ${name}: run the UI tests locally and commit test/screenshots/${name}.jpg`;
    writeFileSync(file, now);
    return undefined;
  }
  const base = readFileSync(file);
  const res = await page.context().newPage();
  try {
    const d = await res.evaluate(async ([a, b]: string[]) => {
      const load = (src: string) => new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
      const [x, y] = await Promise.all([load(a), load(b)]);
      if (x.width !== y.width || x.height !== y.height) return { size: `${x.width}x${x.height} became ${y.width}x${y.height}`, ratio: 1 };
      const px = (img: HTMLImageElement) => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d")!; g.drawImage(img, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
      const p = px(x), q = px(y);
      let diff = 0;
      for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) > 32 || Math.abs(p[i + 1] - q[i + 1]) > 32 || Math.abs(p[i + 2] - q[i + 2]) > 32) diff++;
      return { size: "", ratio: diff / (p.length / 4) };
    }, [`data:image/jpeg;base64,${base.toString("base64")}`, `data:image/jpeg;base64,${now.toString("base64")}`]);
    const max = opts.maxDiff ?? 0.002;
    if (d.size || d.ratio > max) {
      writeFileSync(join(SHOTS, `${name}.actual.jpg`), now);
      return `${name}: ${d.size || `${(d.ratio * 100).toFixed(2)}% of pixels changed (allowed ${(max * 100).toFixed(2)}%)`}; see test/screenshots/${name}.actual.jpg, and if the change is meant, rerun with UPDATE_SCREENSHOTS=1`;
    }
    return undefined;
  } finally { await res.close(); }
}
