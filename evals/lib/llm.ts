// SPDX-License-Identifier: AGPL-3.0-only
// One call to a model. Uses ANTHROPIC_API_KEY when set, otherwise the `claude` CLI in print
// mode (no tools, no settings, empty working dir), so the suite runs wherever Claude Code does.
// Deterministic checks never call this; only the LLM agent driver and the answer judge do.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const AGENT_MODEL = process.env.EVAL_AGENT_MODEL ?? "claude-sonnet-5-5";
export const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL ?? "claude-haiku-5-5";

export const usage = { calls: 0, usd: 0, seconds: 0 };
const cwd = mkdtempSync(join(tmpdir(), "pb-eval-llm-"));

export async function llm(system: string, user: string, model = AGENT_MODEL): Promise<string> {
  const t0 = Date.now();
  usage.calls++;
  try {
    const key = process.env.ANTHROPIC_API_KEY;
    if (key) {
      const r = await fetch(`${process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 4000, system, messages: [{ role: "user", content: user }] }),
      });
      const j = (await r.json()) as any;
      if (!r.ok) throw new Error(`API ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
      return (j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const p = Bun.spawn(["claude", "-p", "--model", model, "--system-prompt", system, "--tools", "", "--strict-mcp-config",
        "--setting-sources", "", "--no-session-persistence", "--output-format", "json"], { cwd, stdin: new Blob([user]), stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      await p.exited;
      try {
        const j = JSON.parse(out);
        usage.usd += j.total_cost_usd ?? 0;
        if (!j.is_error) return String(j.result ?? "");
      } catch {}
      await Bun.sleep(2000 * (attempt + 1));
    }
    throw new Error("claude CLI failed 3 times");
  } finally {
    usage.seconds += (Date.now() - t0) / 1000;
  }
}

export function extractJson<T>(text: string): T | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[\[{]/);
  if (start < 0) return undefined;
  for (let end = body.length; end > start; end--) {
    try { return JSON.parse(body.slice(start, end)) as T; } catch {}
  }
  return undefined;
}

// Run up to n async jobs at a time.
export async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}
