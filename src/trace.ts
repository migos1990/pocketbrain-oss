// SPDX-License-Identifier: AGPL-3.0-only
// `pocketbrain trace <request-id>` (backlog #300, docs/request-ids.md): one request's path through
// the hub, from the id an agent got back as X-Request-Id: the door and the answer
// (log/requests.jsonl), every log line the request wrote (checks, refusals, alerts, reads, the
// after-check's queue), and its commits. Owner-only, and it never prints note contents: a log line
// shows only the names of what it touched (fact keys, outcomes, checks), a commit its hash, author,
// kind and fact keys, never a value, a reason text or a subject line.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { git, gitTime } from "./git";
import { REQUEST_ID, requestsFile, type RequestLine } from "./reqid";

// The fields of a log line that name things without saying what they hold.
const SHOWN = ["agent", "by", "kind", "event", "step", "outcome", "check", "status", "tool", "action", "key", "fact_key", "from", "level", "verdict", "door"] as const;
const FACT_KEY = /[a-z0-9][a-z0-9/_-]*#[a-z0-9_]+/g;

export interface Trace { id: string; request?: RequestLine; logs: { file: string; at?: string; fields: Record<string, string> }[]; commits: { hash: string; at: string; author: string; kind?: string; keys: string[] }[] }

function jsonlFiles(dir: string, depth = 0): string[] {
  if (!existsSync(dir) || depth > 2) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    const st = statSync(p);
    return st.isDirectory() ? jsonlFiles(p, depth + 1) : n.endsWith(".jsonl") ? [p] : [];
  });
}

// Only a name-like value is shown (an id, a fact key, an outcome): anything with a space could be text.
const NAME_LIKE = /^[A-Za-z0-9][A-Za-z0-9/_#.:-]{0,79}$/;
const short = (v: unknown) => {
  const s = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined;
  return s !== undefined && NAME_LIKE.test(s) ? s : undefined;
};

export function trace(root: string, id: string): Trace {
  if (!REQUEST_ID.test(id)) throw new Error("a request id looks like req_ and 20 hex characters (the X-Request-Id an agent got back)");
  const needle = `"request_id":"${id}"`;
  const out: Trace = { id, logs: [], commits: [] };
  for (const f of jsonlFiles(join(root, "log"))) {
    const text = readFileSync(f, "utf8");
    if (!text.includes(needle)) continue;
    for (const l of text.split("\n")) {
      if (!l.includes(needle)) continue;
      let e: Record<string, unknown>;
      try { e = JSON.parse(l); } catch { continue; }
      if (f === requestsFile(root)) { out.request = e as unknown as RequestLine; continue; }
      const fields: Record<string, string> = {};
      for (const k of SHOWN) { const v = short(e[k]); if (v !== undefined) fields[k] = v; }
      out.logs.push({ file: relative(join(root, "log"), f), at: short(e.at), fields });
    }
  }
  out.logs.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  const SEP = "\x1f";
  const log = git(root, ["log", "--all", "--fixed-strings", `--grep=Request-Id: ${id}`, `--format=%h${SEP}%aI${SEP}%an${SEP}%(trailers:key=Kind,valueonly,separator=%x2C)${SEP}%(trailers:key=Fact-Keys,valueonly,separator=%x2C)${SEP}%s`]);
  for (const row of log.split("\n").filter(Boolean)) {
    const [hash, at, author, kind, factKeys, subject] = row.split(SEP);
    const keys = [...new Set([...(factKeys ?? "").split(",").map((k) => k.trim()).filter(Boolean), ...((subject ?? "").match(FACT_KEY) ?? [])])];
    out.commits.push({ hash, at: gitTime(at), author, ...(kind ? { kind } : {}), keys });
  }
  out.commits.reverse();
  return out;
}

export function traceText(t: Trace): string {
  const r = t.request;
  return [
    `Request ${t.id}`,
    r ? `  ${r.at}  ${r.door} ${r.method} ${r.route}${r.tool ? ` (${r.tool})` : ""}  ${r.agent ?? "no agent"}  ${r.status} in ${r.ms} ms` : "  (no line in log/requests.jsonl)",
    "", `Log lines (${t.logs.length})`,
    ...(t.logs.length ? t.logs.map((l) => `  ${l.at ?? "?"}  ${l.file}  ${Object.entries(l.fields).map(([k, v]) => `${k}=${v}`).join(" ")}`) : ["  none"]),
    "", `Commits (${t.commits.length})`,
    ...(t.commits.length ? t.commits.map((c) => `  ${c.hash}  ${c.at}  ${c.author}${c.kind ? `  ${c.kind}` : ""}${c.keys.length ? `  ${c.keys.join(", ")}` : ""}`) : ["  none"]),
    "",
  ].join("\n");
}
