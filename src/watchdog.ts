// SPDX-License-Identifier: AGPL-3.0-only
// The hub's watchdog, run by its own launchd job every 5 minutes (com.pocketbrain.watchdog), never
// inside the hub: on 2026-10-20 the hub's main thread blocked in a sync open() on a cloud-synced
// folder and stayed up, listening and silent, for two days, its in-process probe frozen with it.
// Each run asks /health with a timeout. Two missed answers in a row restart the hub (launchctl
// kickstart; off a Mac, nothing is restarted) and leave a `probe_hub_hung` hub alert, which the
// digest shows and the real-use bar counts as a hub check that failed. After a restart it waits
// 15 minutes before trying again, so a hub that can't come back isn't restarted in a loop.
// It also reports what the hub can't while it is down (owner, 2026-10-22: self-healing and
// self-reporting): the hub's job checks that need no network (a night pass, backup or Gardener run
// that stopped, an assistant that stopped reading) run here too, and each failing one, like a hung
// hub, reaches the owner as a problem line in the menu bar (log/watchdog.json) and, when the check
// is promoted (NOTIFY in src/probe.ts, G747), as a Mac notification once a day. The hub's self-check in turn flags a watchdog that stopped running.
import { beat } from "./heartbeat";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { alert, appendJsonl, readJsonl } from "./util";
import { keysDir } from "./secrets";
import { jobChecks, notifies } from "./probe";
import { tailscaleRun, type Run as TailscaleRun } from "./phone";
import { isTailnetIp, tailnetSettings } from "./dashboard/tailnet";

export type Run = (cmd: string[]) => { code: number; out: string };
type Problem = { name: string; detail: string };
type State = { fails: number; since?: string; restarted?: string; last?: string; problems?: Problem[]; notified?: Record<string, string>; messages_relaunched?: string; tailnet_fails?: number };
const MISSES = 2;
const BACKOFF_MS = 15 * 60_000;
const stateFile = (root: string) => join(root, "log", "watchdog.json");

export function watchdogState(root: string): State {
  try { const s = JSON.parse(readFileSync(stateFile(root), "utf8")); return { ...s, fails: Number(s.fails) || 0 }; } catch { return { fails: 0 }; }
}
const load = watchdogState;
function save(root: string, s: State) { mkdirSync(join(root, "log"), { recursive: true }); writeFileSync(stateFile(root), JSON.stringify(s) + "\n"); }

// The hub's job checks, run from outside it. Not "model" (whether the hub process loaded its keys,
// which this process can't see) nor "watchdog" (this run is the heartbeat it checks).
function outsideChecks(root: string, now: Date): Problem[] {
  try { return jobChecks(root, now).filter((c) => !c.ok && c.name !== "model" && c.name !== "watchdog").map((c) => ({ name: c.name, detail: c.detail })); }
  catch (e) { return [{ name: "checks", detail: `the watchdog couldn't run the hub's checks: ${(e as Error).message}` }]; }
}

// A tailnet that is up and silent (2026-11-07/08, about 19 hours): `tailscale status` said the
// owner's phone was online with no health warning, while the phone's own Tailscale had stopped
// receiving and the app said "Still waiting for your hub"; toggling Tailscale on the phone fixed
// it. Each run pings, over the tailnet only, each phone listed in dashboard_tailnet_devices that
// status calls online (an offline phone is just not in use); a phone that fails two runs in a row
// is one problem line, by kind of device only, never its name or address (G741). Report-only for
// now: the menu bar and log/watchdog.json show it, no Mac notification (not in NOTIFY, src/probe.ts).
// A pong by any path counts: tailscale ping waits for a direct path by default, and with -c 1 a
// pong over a DERP relay, which an idle phone often answers with first, exits 1 (G743).
const TAILNET_MISSES = 2;
const TAILNET_LINE = "tailnet: the hub can't reach your phone; toggle Tailscale on the phone first, restart it on the Mac only if that fails";
type Peer = { OS?: string; Online?: boolean; TailscaleIPs?: string[] };
function tailnetCheck(root: string, ts: TailscaleRun, s: State): { problem?: Problem; fails: number } {
  const cfg = tailnetSettings(root);
  const listed = new Set((cfg.dashboard_tailnet_devices ?? []).filter((d) => isTailnetIp(d)));
  if (!cfg.dashboard_tailnet || !listed.size) return { fails: 0 };
  let st: { BackendState?: string; Peer?: Record<string, Peer> };
  try { st = JSON.parse(ts(["status", "--json"]).out); } catch { return { fails: 0 }; }
  if (st.BackendState !== "Running") return { fails: 0 };
  const phones = Object.values(st.Peer ?? {}).filter((p) => p.Online && /^(ios|android)$/i.test(p.OS ?? "")).map((p) => p.TailscaleIPs?.find((ip) => listed.has(ip))).filter((ip): ip is string => !!ip);
  if (!phones.length) return { fails: 0 };
  const failed = phones.some((ip) => ts(["ping", "--until-direct=false", "-c", "1", "--timeout", "5s", ip]).code !== 0);
  const fails = failed ? (s.tailnet_fails ?? 0) + 1 : 0;
  return { fails, ...(fails >= TAILNET_MISSES ? { problem: { name: "tailnet", detail: TAILNET_LINE } } : {}) };
}

// A Mac notification: no hub, no network, no brain value (check details name jobs, dates and assistants).
function macNotify(run: Run): (text: string) => void {
  return (text) => { run(["osascript", "-e", `display notification ${JSON.stringify(text.slice(0, 240))} with title "pocketBrain"`]); };
}

// Messages hung on AppleEvents (2026-10-23/24, three times in a day: sends timed out, so alerts
// and sign-in links went nowhere). When the last iMessage send timed out after the last relaunch,
// the watchdog quits and reopens Messages in the background: one hung send is enough (waiting for
// three let the poller's backoff hold it hung for hours, G382). Relaunches are RELAUNCH_GAP_MS
// apart and at most RELAUNCH_PER_DAY a day; each is self-healing, logged in textline/log.jsonl,
// not a hand fix. A failure that is not a hang (no permission, a wrong number) is only reported.
const RELAUNCH_GAP_MS = 15 * 60_000;
const RELAUNCH_PER_DAY = 6;
const HUNG = /-1712|timed out|no answer/i;
function relaunchMessages(root: string, run: Run, now: Date, s: State): string | undefined {
  if (s.messages_relaunched && now.getTime() - Date.parse(s.messages_relaunched) < RELAUNCH_GAP_MS) return undefined;
  const log = readJsonl(join(root, "textline", "log.jsonl"));
  const last = log.filter((e) => e.sent !== undefined).at(-1);
  if (!last || last.ok !== false || last.via !== "imessage" || !HUNG.test(String(last.detail ?? ""))) return undefined;
  if (s.messages_relaunched && String(last.at) <= s.messages_relaunched) return undefined;
  const day = now.toISOString().slice(0, 10);
  if (log.filter((e) => e.relaunched !== undefined && String(e.at).startsWith(day)).length >= RELAUNCH_PER_DAY) return undefined;
  run(["killall", "Messages"]);
  // Reopened in the background with App Nap off for this launch (the argument domain of its
  // defaults), since a napped background Messages is the likely reason its AppleEvents time out.
  const r = run(["open", "-g", "-a", "Messages", "--args", "-NSAppSleepDisabled", "YES"]);
  appendJsonl(join(root, "textline", "log.jsonl"), { at: now.toISOString(), relaunched: "Messages", ok: r.code === 0, why: String(last.detail).slice(0, 120) });
  return now.toISOString();
}

// One look at the hub: "ok", "waiting" (missed, not yet twice, or backing off), "restarted" or
// "alerted" (a miss that would restart, on a machine with no launchd).
export async function watchdogTick(root: string, o: { url: string; run: Run; uid: number; fetch?: typeof fetch; now?: Date; timeoutMs?: number; platform?: string; notify?: (text: string) => void; tailscale?: TailscaleRun }): Promise<{ action: "ok" | "waiting" | "restarted" | "alerted"; detail: string }> {
  const r = await healthTick(root, o);
  const tn = tailnetCheck(root, o.tailscale ?? tailscaleRun, load(root));
  // What the hub would report, said from here, each problem once a day (the owner's day is close
  // enough: a UTC date only decides when the same problem is said again).
  const now = o.now ?? new Date();
  const s = load(root);
  const problems = [...(r.action === "restarted" || r.action === "alerted" ? [{ name: "hub_hung", detail: r.detail }] : []), ...outsideChecks(root, now), ...(tn.problem ? [tn.problem] : [])];
  const day = now.toISOString().slice(0, 10);
  const notified = Object.fromEntries(Object.entries(s.notified ?? {}).filter(([, d]) => d === day));
  const say = o.notify ?? (o.platform === "darwin" ? macNotify(o.run) : undefined);
  for (const p of problems) if (notifies(p.name) && notified[p.name] !== day) { try { say?.(p.detail); } catch { /* the menu bar still shows it */ } notified[p.name] = day; }
  let relaunched = s.messages_relaunched;
  if (o.platform === "darwin") {
    const at = relaunchMessages(root, o.run, now, s);
    if (at) {
      relaunched = at;
      if (notified.messages_relaunch !== day) {
        try { say?.("A text to your phone didn't go out: Messages wasn't answering, so it was restarted. The next text will tell if it worked."); } catch { /* logged above */ }
        notified.messages_relaunch = day;
      }
    }
  }
  save(root, { ...load(root), last: now.toISOString(), problems, notified, messages_relaunched: relaunched, tailnet_fails: tn.fails });
  // The watchdog itself ran: its own heartbeat (src/heartbeat.ts). A hung hub is the hub's problem, not this job's.
  beat(root, "watchdog", { ok: true, now });
  return r;
}

async function healthTick(root: string, o: { url: string; run: Run; uid: number; fetch?: typeof fetch; now?: Date; timeoutMs?: number; platform?: string }): Promise<{ action: "ok" | "waiting" | "restarted" | "alerted"; detail: string }> {
  const now = o.now ?? new Date();
  const f = o.fetch ?? fetch;
  const timeout = o.timeoutMs ?? 15_000;
  let why = "";
  try {
    const r = await Promise.race([
      f(`${o.url.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(timeout) }),
      new Promise<never>((_, no) => setTimeout(() => no(new Error(`no answer in ${Math.round(timeout / 1000)} s`)), timeout).unref?.()),
    ]);
    if (r.ok) { save(root, { ...load(root), fails: 0, since: undefined }); return { action: "ok", detail: "the hub answered" }; }
    why = `/health answered ${r.status}`;
  } catch (e) { why = `/health: ${(e as Error).message}`; }

  const s = load(root);
  const st: State = { ...s, fails: s.fails + 1, since: s.since ?? now.toISOString() };
  if (st.fails < MISSES || (st.restarted && now.getTime() - Date.parse(st.restarted) < BACKOFF_MS)) {
    save(root, st);
    return { action: "waiting", detail: `${why} (miss ${st.fails})` };
  }
  const from = `the hub didn't answer ${st.fails} checks in a row since ${st.since} (${why})`;
  if (o.platform !== "darwin") {
    alert(root, { agent: "hub", check: "probe_hub_hung", from: `${from}; restart it with: pocketbrain start` });
    save(root, { ...st, restarted: now.toISOString() });
    return { action: "alerted", detail: from };
  }
  // The start after this restart was planned, not by hand (src/measure.ts noteStart reads this mark).
  try { mkdirSync(dirname(keysDir()), { recursive: true }); writeFileSync(join(dirname(keysDir()), "deploy.restart"), now.toISOString() + "\n"); } catch { /* the alert below still says what happened */ }
  const r = o.run(["launchctl", "kickstart", "-k", `gui/${o.uid}/com.pocketbrain.start`]);
  alert(root, { agent: "hub", check: "probe_hub_hung", from: `${from}; the watchdog restarted it${r.code === 0 ? "" : ` but launchctl failed: ${r.out.trim().slice(0, 200)}`}` });
  save(root, { ...st, fails: 0, since: undefined, restarted: now.toISOString() });
  return { action: "restarted", detail: from };
}
