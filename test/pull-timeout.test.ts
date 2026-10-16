// SPDX-License-Identifier: AGPL-3.0-only
// A source that accepts the connection and never answers must not hold up the hub. Pulls run in
// the same queue as agent writes (src/start.ts), so a pull with no timeout froze every write.
import { test, expect, afterAll } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { useHttp, GMAIL_SCOPE, DRIVE_SCOPE } from "../src/google";
import { useDiscordHttp } from "../src/feeds";
import { pullSource } from "../src/pull";
import { serial } from "../src/server";
import { timed } from "../src/util";

afterAll(() => { useHttp((u, i) => fetch(u, i)); useDiscordHttp((u, i) => fetch(u, i)); delete process.env.PB_HTTP_TIMEOUT_MS; });
const never = () => new Promise<Response>(() => {});
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<"still waiting">((r) => setTimeout(() => r("still waiting"), ms))]);

test("timed gives up on a call that never answers, and aborts it", async () => {
  process.env.PB_HTTP_TIMEOUT_MS = "100";
  let signal: AbortSignal | undefined;
  const r = await within(timed((_u, init) => { signal = init?.signal ?? undefined; return never(); }, "https://gmail.googleapis.com/x").catch((e: Error) => e.message), 2000);
  expect(r).toBe("no answer from gmail.googleapis.com in 0.1s");
  expect(signal?.aborted).toBe(true);
});

test("a stalled Gmail pull ends and the agent write queued behind it goes through", async () => {
  process.env.PB_HTTP_TIMEOUT_MS = "100";
  process.env.GOOGLE_CLIENT_ID = "cid"; process.env.GOOGLE_CLIENT_SECRET = "cs"; process.env.GMAIL_REFRESH_TOKEN_PRIMARY = `r-${Math.random()}`;
  useHttp(async (url) => url.includes("oauth2") ? new Response(JSON.stringify({ access_token: "at", expires_in: 3600, scope: GMAIL_SCOPE })) : never());
  const root = makeBrain();
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ consent: "2026-10-01 test", sources: { mail: { kind: "gmail", account: "primary", area: "personal" } } }));
  const pull = serial(() => pullSource(root, "mail", { model: null })).catch((e: Error) => e.message);
  expect(await within(serial(() => "agent write committed"), 3000)).toBe("agent write committed");
  expect(JSON.stringify(await pull)).toContain("no answer from");
});

test("a stalled Discord pull ends too", async () => {
  process.env.PB_HTTP_TIMEOUT_MS = "100"; process.env.DISCORD_BOT_TOKEN = "bot-token";
  useDiscordHttp(() => never());
  const root = makeBrain();
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ consent: "2026-10-01 test", sources: { team: { kind: "discord", where: ["111"] } } }));
  const r = await within(pullSource(root, "team", { model: null }).catch((e: Error) => e.message), 3000);
  expect(JSON.stringify(r)).toContain("no answer from discord.com");
});

test("a Drive file whose text never arrives ends the pull too (stranger rehearsal 2)", async () => {
  process.env.PB_HTTP_TIMEOUT_MS = "100";
  process.env.GOOGLE_CLIENT_ID = "cid"; process.env.GOOGLE_CLIENT_SECRET = "cs"; process.env.GDRIVE_REFRESH_TOKEN_PRIMARY = `d-${Math.random()}`;
  const doc = { id: "d1", name: "Plan", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-10-14T10:00:00Z", parents: ["F1"], version: "3" };
  useHttp(async (url) => {
    if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "at", expires_in: 3600, scope: DRIVE_SCOPE }));
    const u = new URL(url);
    if (u.pathname.endsWith("/export") || u.searchParams.get("alt") === "media") return never();
    if (u.pathname === "/drive/v3/files") return new Response(JSON.stringify({ files: [doc] }));
    if (u.pathname === "/drive/v3/files/d1") return new Response(JSON.stringify(doc));
    return new Response("{}", { status: 404 });
  });
  const root = makeBrain();
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ consent: "2026-10-01 test, Drive too", sources: { docs: { kind: "gdoc", account: "primary", where: ["F1"] } } }));
  const r = await within(pullSource(root, "docs", { model: null }).catch((e: Error) => e.message), 3000);
  expect(JSON.stringify(r)).toContain("no answer from");
});
