// SPDX-License-Identifier: AGPL-3.0-only
// `pocketbrain phone` (docs/phone-app.md): pair the owner's phone in one command, in place of the
// tailnet steps done by hand. It reads Tailscale's own status, asks which of this account's phones
// is the owner's, lets only that device and this machine's own Tailscale login in (the same owner
// commit `dashboard tailnet on` makes, src/ownerset.ts), puts `tailscale serve` on the https port,
// and prints the phone link as a QR the iPhone Camera opens in the pocketBrain app. The link is
// minted as `dashboard phone-link` mints it: once, for a day, on the tailnet only.
import qrcode from "qrcode-generator";
import { SERVE_PORT, isTailnetIp } from "./dashboard/tailnet";

export type Run = (args: string[]) => { code: number; out: string };

// The CLIs `tailnetSelf` tries: the Mac App Store and standalone apps keep theirs inside the app.
const CLIS = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
export const tailscaleRun: Run = (args) => {
  let last = { code: 1, out: "Tailscale isn't installed on this computer" };
  for (const c of CLIS) {
    try {
      const r = Bun.spawnSync([c, ...args], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
      last = { code: r.exitCode ?? 1, out: `${r.stdout}${r.stderr}` };
      if (last.code === 0) return last;
    } catch { /* not installed here */ }
  }
  return last;
};

type Node = { HostName?: string; DNSName?: string; OS?: string; UserID?: number; TailscaleIPs?: string[]; Online?: boolean };
type Status = { BackendState?: string; Self?: Node; Peer?: Record<string, Node>; User?: Record<string, { LoginName?: string }> };

export type Phone = { name: string; address: string; os: string; online: boolean };
export type Tailnet = { name: string; address: string; login?: string; phones: Phone[] };

const v4 = (n: Node) => n.TailscaleIPs?.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip) && isTailnetIp(ip));
const dns = (n: Node) => n.DNSName?.replace(/\.$/, "").toLowerCase();

/** This machine on its tailnet and the phones signed in to the same Tailscale account, from
 *  `tailscale status --json`. A string says why there is nothing to pair with. */
export function readTailnet(run: Run = tailscaleRun): Tailnet | string {
  const r = run(["status", "--json"]);
  let st: Status;
  try { st = JSON.parse(r.out) as Status; } catch { return "Tailscale isn't running on this computer. Install it from tailscale.com, sign in, then run pocketbrain phone again."; }
  if (st.BackendState && st.BackendState !== "Running") return `Tailscale isn't connected on this computer (${st.BackendState}). Open it and sign in, then run pocketbrain phone again.`;
  const self = st.Self, address = self && v4(self), name = self && dns(self);
  if (!self || !address) return "Tailscale isn't connected on this computer. Open it and sign in, then run pocketbrain phone again.";
  if (!name || !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(name)) return "This computer has no tailnet name, so the phone app has no https address to open. Turn on MagicDNS in Tailscale's admin console (DNS), then run pocketbrain phone again.";
  const login = self.UserID !== undefined ? st.User?.[String(self.UserID)]?.LoginName : undefined;
  // Only this account's own phones: a tailnet can hold other people's devices too.
  const phones = Object.values(st.Peer ?? {})
    .filter((p) => /^(ios|android)$/i.test(p.OS ?? "") && p.UserID === self.UserID && v4(p))
    .map((p) => ({ name: p.HostName || dns(p)?.split(".")[0] || v4(p)!, address: v4(p)!, os: /^ios$/i.test(p.OS!) ? "iPhone" : "Android", online: !!p.Online }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  return { name, address, login, phones };
}

/** The phone the owner named with --device (its name or its 100.x address), else undefined. */
export function pickPhone(phones: Phone[], device: string): Phone | undefined {
  const d = device.toLowerCase();
  return phones.find((p) => p.address === device || p.name.toLowerCase() === d);
}

/** True when `tailscale serve` already answers https on SERVE_PORT with the dashboard's port. */
export function serving(run: Run, port: number): boolean {
  const r = run(["serve", "status", "--json"]);
  if (r.code !== 0) return false;
  try {
    const st = JSON.parse(r.out || "{}") as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
    return Object.entries(st.Web ?? {}).some(([hp, w]) => hp.endsWith(`:${SERVE_PORT}`) && Object.values(w.Handlers ?? {}).some((h) => new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${port}/?$`).test(h.Proxy ?? "")));
  } catch { return false; }
}

/** Puts the dashboard on https SERVE_PORT, tailnet only (never funnel). Undefined when done; else
 *  Tailscale's own words, which carry its link when Serve isn't enabled on the tailnet yet. */
export function startServe(run: Run, port: number): string | undefined {
  if (serving(run, port)) return undefined;
  const r = run(["serve", "--bg", `--https=${SERVE_PORT}`, `http://127.0.0.1:${port}`]);
  return r.code === 0 ? undefined : r.out.trim() || `tailscale serve --bg --https=${SERVE_PORT} http://127.0.0.1:${port} failed`;
}

/** The link the iPhone Camera opens in the pocketBrain app (mobile/src/pair.ts reads it). */
export function pairLink(name: string, key: string): string {
  return `pocketbrain://pair?hub=${encodeURIComponent(`https://${name}:${SERVE_PORT}`)}&key=${encodeURIComponent(key)}`;
}

/** The QR's modules, true for dark, error correction M. */
export function qrMatrix(text: string): boolean[][] {
  const q = qrcode(0, "M");
  q.addData(text, "Byte");
  q.make();
  const n = q.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => q.isDark(r, c)));
}

/** The QR in a terminal: two rows per line with half blocks, light modules in white blocks and
 *  dark ones as spaces on a black background, colours set on each line, so it reads the same way
 *  round on a dark or a light terminal (a camera may not read one drawn light on dark). */
export function qrText(text: string): string {
  const m = qrMatrix(text), pad = 2, n = m.length + pad * 2;
  const dark = (r: number, c: number) => r >= pad && c >= pad && r < n - pad && c < n - pad && m[r - pad][c - pad];
  const lines: string[] = [];
  for (let r = 0; r < n; r += 2) {
    let line = "";
    for (let c = 0; c < n; c++) {
      const top = !dark(r, c), bottom = r + 1 < n ? !dark(r + 1, c) : true; // true = light
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(`\x1b[97;40m${line}\x1b[0m`);
  }
  return lines.join("\n");
}

export type PhoneOptions = {
  run?: Run;                                   // tailscale, for tests a fake
  device?: string;                             // --device: the phone's name or 100.x address
  ask?: (q: string) => string | null;          // a terminal's answer; undefined when there's no terminal
  port?: number;                               // the dashboard's port
  restart?: () => string;                      // restarts the hub; undefined: say how
  mint: () => string;                          // a phone link key (mintPhoneLink)
  setTailnet: (devices: string[], login?: string) => string; // setDashboardTailnet as the owner
  settings: () => { dashboard_tailnet?: boolean; dashboard_tailnet_login?: string; dashboard_tailnet_devices?: string[] };
  say: (s: string) => void;
  yes?: boolean;                               // --yes: the owner's yes to the rules/ lines shown
  rulesFile: string;                           // where they go: rules/hub.yaml or rules/policy.yaml
};

/** The command itself: 0 when the QR is printed, 1 when Tailscale needs a step first, 2 when it
 *  must be told which phone (no terminal to ask). Nothing is written before a phone is chosen. */
export function pairPhone(o: PhoneOptions): number {
  const run = o.run ?? tailscaleRun, port = o.port ?? 8788;
  const t = readTailnet(run);
  if (typeof t === "string") { o.say(t); return 1; }
  if (!t.phones.length) { o.say(`No phone is signed in to your Tailscale account (${t.login ?? "this computer's"}). Install Tailscale on your phone, sign in with the same account, then run pocketbrain phone again.`); return 1; }
  let phone: Phone | undefined;
  const list = t.phones.map((p, i) => `  ${i + 1}  ${p.name} (${p.os}, ${p.address}${p.online ? "" : ", offline"})`).join("\n");
  if (o.device) {
    phone = pickPhone(t.phones, o.device);
    if (!phone) { o.say(`No phone called ${o.device} on your tailnet. Your phones:\n${list}`); return 2; }
  } else if (!o.ask) {
    o.say(`Which one is your phone? Run it again with --device <name>:\n${list}`);
    return 2;
  } else if (t.phones.length === 1) {
    const a = (o.ask(`Is ${t.phones[0].name} (${t.phones[0].os}) your phone? [Y/n]`) ?? "").trim();
    if (a && !/^y(es)?$/i.test(a)) { o.say("Nothing changed. Sign in to Tailscale on your phone with the same account, then run pocketbrain phone again."); return 1; }
    phone = t.phones[0];
  } else {
    o.say(`Which one is your phone?\n${list}`);
    for (let i = 0; i < 3 && !phone; i++) {
      const a = (o.ask(`Its number or name:`) ?? "").trim();
      phone = /^\d+$/.test(a) ? t.phones[Number(a) - 1] : pickPhone(t.phones, a);
    }
    if (!phone) { o.say("Nothing changed."); return 1; }
  }
  // rules/ is the owner's own: the exact lines go on screen first, and nothing is written without
  // a yes (typed, or --yes). Only the three tailnet keys are ever touched (setDashboardTailnet).
  const cur = o.settings();
  const devices = [...new Set([...(cur.dashboard_tailnet_devices ?? []), phone.address])];
  const login = !cur.dashboard_tailnet_login && t.login ? t.login : undefined;
  const changed = !cur.dashboard_tailnet || devices.length !== (cur.dashboard_tailnet_devices ?? []).length || !!login;
  if (changed) {
    const lines = [`dashboard_tailnet: true`, `dashboard_tailnet_devices: [${devices.join(", ")}]   # ${phone.name}${devices.length > 1 ? " and the devices already listed" : ""}`, ...(login ? [`dashboard_tailnet_login: ${login}   # only this Tailscale login gets in over https`] : [])];
    o.say(`To open your dashboard to ${phone.name} only, pocketBrain will set these lines in ${o.rulesFile} (nothing else in it changes):\n\n${lines.map((l) => `  ${l}`).join("\n")}\n`);
    const yes = o.yes || (o.ask ? /^y(es)?$/i.test((o.ask("Write them? [y/N]") ?? "").trim()) : false);
    if (!yes) { o.say(o.ask ? "Nothing written." : "Nothing written. If this is right, run the same command with --yes."); return o.ask ? 1 : 2; }
    o.say(o.setTailnet([phone.address], login));
  }
  const serve = startServe(run, port);
  if (serve) { o.say(`Tailscale didn't put the dashboard on https yet:\n${serve}\nDo what it says (it may ask you to enable Serve on your tailnet), then run pocketbrain phone again.`); return 1; }
  if (changed) {
    if (o.restart) { try { o.say(o.restart()); } catch (e) { o.say(`Restart the hub yourself so it opens the dashboard to ${phone.name} (${(e as Error).message}).`); } }
    else o.say(`Restart pocketbrain start, so the dashboard opens to ${phone.name}.`);
  }
  const link = pairLink(t.name, o.mint());
  o.say(`\nPoint ${phone.name}'s camera at this code, and tap the banner to open it in the pocketBrain app:\n\n${qrText(link)}\n\nNo camera? Open this on the phone instead (it works once, for a day): ${link}`);
  return 0;
}
