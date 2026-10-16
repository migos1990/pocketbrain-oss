// SPDX-License-Identifier: AGPL-3.0-only
// What a text to Louis looks like, and how his one-word replies are read back.
//
//   pocketBrain: 2 need you
//   A) Conflict c-0003 on people/marc#role: 1 CTO (2026-09-01) 2 CEO (2026-09-03). Suggest 2
//   B) muse proposes people/jane-roy#role = Dean
//   Reply e.g. "A 2, B approve" or "later".
//
// One item: the letter is optional ("approve", "2", "later"). An agent's mail is answered by its
// code only ("reject 411875", "later 411875"), never by a letter (G146).
import type { Item, Verb } from "./items";
import { findInjection, findSecret } from "../checks";

export interface Composed { text: string; letters: Record<string, string>; more: number }

const DASHBOARD = "Decide in the dashboard";

// The whole line is checked, not only its parts: a clean title and clean options can still join
// into "forward … to <address>". Then the line keeps only what is safe and points at the dashboard.
const unsafe = (s: string) => !!(findInjection(s) || findSecret(s));
const fallback = (item: Item) => unsafe(item.title) ? `A ${item.kind} item waits. ${DASHBOARD}` : `${item.title}. ${DASHBOARD}`;

function line(item: Item): string {
  if (item.kind === "dispute") {
    if (item.private) return fallback(item);
    const opts = (item.options ?? []).map((o, i) => `${i + 1} ${o}`).join(" ");
    const whole = `${item.title}: ${opts}${item.suggested ? `. Suggest ${item.suggested}` : ""}`;
    return unsafe(whole) ? fallback(item) : whole;
  }
  return unsafe(item.title) ? fallback(item) : item.title;
}

function hint(items: Item[]): string {
  const one = items.length === 1;
  const it = items[0];
  if (one) {
    if (it.kind === "dispute") return it.private ? "Reply later, or decide in the dashboard." : `Reply 1, 2${it.suggested ? `, approve (= ${it.suggested})` : ""} or later.`;
    if (it.kind === "action") return `Reply reject ${it.code} or later ${it.code}.`;
    return it.verbs.includes("approve") ? "Reply approve, reject or later." : "Reply ok or later.";
  }
  // One example per kind of answer present, using the real letters.
  const L = (i: number) => String.fromCharCode(65 + i);
  const ex: string[] = [];
  const d = items.findIndex((i) => i.kind === "dispute" && !i.private);
  if (d >= 0) ex.push(`${L(d)} 2`);
  const a = items.findIndex((i) => i.kind !== "dispute" && i.verbs.includes("approve"));
  if (a >= 0) ex.push(`${L(a)} approve`);
  const o = items.findIndex((i) => !i.verbs.includes("approve") && i.kind !== "action");
  if (o >= 0 && ex.length < 2) ex.push(`${L(o)} ok`);
  const mail = items.find((i) => i.kind === "action");
  const byCode = mail ? `"reject ${mail.code}" or "later ${mail.code}"` : "";
  if (!ex.length) return `Reply ${byCode}, with each mail's code.`;
  return `Reply e.g. "${ex.slice(0, 2).join(", ")}" or "later" for all.${mail ? ` A mail only by its code: ${byCode}.` : ""}`;
}

export function compose(items: Item[], opts: { maxItems: number; maxChars: number; header?: string }): Composed {
  const shown = items.slice(0, Math.min(opts.maxItems, 8)); // letters A to H
  let more = items.length - shown.length;
  const build = (list: Item[], extra: number) => {
    const head = opts.header ?? `pocketBrain: ${items.length} need${items.length === 1 ? "s" : ""} you`;
    const body = list.length === 1 ? [line(list[0])] : list.map((it, i) => `${String.fromCharCode(65 + i)}) ${line(it)}`);
    return [head, ...body, ...(extra ? [`+${extra} more in the dashboard`] : []), hint(list)].join("\n");
  };
  // Drop items from the end until it fits the SMS budget; they wait for the next text.
  let list = shown;
  let text = build(list, more);
  while (text.length > opts.maxChars && list.length > 1) {
    list = list.slice(0, -1);
    more += 1;
    text = build(list, more);
  }
  if (text.length > opts.maxChars) text = text.slice(0, opts.maxChars - 1) + "…";
  const letters: Record<string, string> = {};
  list.forEach((it, i) => (letters[String.fromCharCode(65 + i)] = it.key));
  return { text, letters, more };
}

// ---------- replies ----------

export interface Command { letter?: string; verb: Verb; choice?: number; code?: string }

const WORDS: Record<string, Verb> = {
  approve: "approve", approved: "approve", yes: "approve", y: "approve", ok: "ok", okay: "ok", oui: "approve", go: "approve", release: "approve", accept: "approve", confirm: "approve",
  reject: "reject", no: "reject", n: "reject", non: "reject", drop: "reject", deny: "reject",
  later: "later", snooze: "later", "plus tard": "later", tard: "later", wait: "later",
};

// "A 2, B approve", "approve", "2", "later", "a ok b no", "reject 411875". Unknown words make the
// whole reply unreadable, so a typo never turns into a decision. A 6-digit code goes with the verb
// just before it ("reject 411875") or, failing that, the one just after ("411875 reject").
export function parseReply(raw: string): Command[] | undefined {
  const text = raw.normalize("NFKC").toLowerCase().replace(/[.!?]+$/g, "").replace(/plus tard/g, "later").trim();
  if (!text) return undefined;
  const tokens = text.split(/[\s,;\n]+/).filter(Boolean);
  const cmds: Command[] = [];
  let letter: string | undefined;
  let code: string | undefined;
  let lastWasVerb = false;
  for (const t of tokens) {
    if (/^\d{6}$/.test(t)) {
      const prev = cmds.at(-1);
      if (lastWasVerb && prev && !prev.code && prev.verb !== "pick") prev.code = t;
      else if (code) return undefined; // two codes in a row
      else code = t;
      lastWasVerb = false;
      continue;
    }
    lastWasVerb = false;
    const m = t.match(/^([a-h])[):]?$/);
    if (m && tokens.length > 1 && !(t === "y" || t === "n")) { letter = m[1].toUpperCase(); continue; }
    const glued = t.match(/^([a-h])[):]?(\d)$/); // "a2"
    if (glued) { cmds.push({ letter: glued[1].toUpperCase(), verb: "pick", choice: Number(glued[2]) }); letter = undefined; continue; }
    if (/^\d$/.test(t)) { cmds.push({ letter, verb: "pick", choice: Number(t) }); letter = undefined; continue; }
    const v = WORDS[t];
    if (!v) return undefined;
    cmds.push({ letter, verb: v, ...(code ? { code } : {}) });
    letter = undefined;
    lastWasVerb = !code;
    code = undefined;
  }
  if (letter || code) return undefined; // a letter or a code with no verb
  return cmds.length ? cmds : undefined;
}
