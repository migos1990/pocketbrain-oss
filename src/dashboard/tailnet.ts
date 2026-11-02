// SPDX-License-Identifier: AGPL-3.0-only
// The owner dashboard on the owner's own tailnet (docs/dashboard-tailnet.md): opt in with
// `dashboard_tailnet: true` in rules/hub.yaml or `--dashboard-tailnet`, and the dashboard also
// listens on this machine's Tailscale address, for the owner's phone. That listener answers only
// the owner's own devices, listed by tailnet address in `dashboard_tailnet_devices` (an account
// can hold other machines, such as a box an assistant runs on), only for this machine's tailnet
// names, with the same login, cookie and CSRF as on localhost. The Cloudflare tunnel never points at it.
import type { OwnerErrorId, Vars } from "../owner-errors";
import { loadHub } from "../hub";
import { loadRules } from "../rules";

// The settings, from rules/hub.yaml once there is one, else rules/policy.yaml (a single machine
// has no hub.yaml), as `pocketbrain dashboard tailnet` writes them (src/ownerset.ts).
export function tailnetSettings(root: string): { dashboard_tailnet?: boolean; dashboard_tailnet_login?: string; dashboard_tailnet_devices?: string[]; dashboard_port?: number } {
  const h = loadHub(root);
  const src = h ?? (() => { try { return loadRules(root).policy; } catch { return undefined; } })();
  return { dashboard_tailnet: src?.dashboard_tailnet, dashboard_tailnet_login: src?.dashboard_tailnet_login, dashboard_tailnet_devices: src?.dashboard_tailnet_devices, dashboard_port: h?.dashboard_port };
}
// Tailscale hands out 100.64.0.0/10 (IPv4) and fd7a:115c:a1e0::/48 (IPv6).
export function isTailnetIp(ip: string | undefined): boolean {
  if (!ip) return false;
  const v4 = ip.replace(/^::ffff:/i, "");
  const m = v4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b, c, d] = m.slice(1).map(Number);
    if ([a, b, c, d].some((x) => x > 255)) return false;
    return a === 100 && b >= 64 && b <= 127;
  }
  return /^fd7a:115c:a1e0:/i.test(ip);
}

// The https port `tailscale serve` uses for the dashboard. Not 443: a `tailscale funnel` (public)
// may hold 443 on this machine, and serve and funnel share a port's config.
export const SERVE_PORT = 8443;

/** The phone link `dashboard phone-link` prints: the `tailscale serve` https address when the
 *  owner's Tailscale login is set and the machine has a name (the phone app refuses plain http),
 *  else the tailnet listener's own address. */
export function phoneLinkUrl(t: { address: string; name?: string }, login: string | undefined, key: string, port: number): string {
  return t.name && login ? `https://${t.name}:${SERVE_PORT}/login?key=${key}` : `http://${t.name ?? t.address}:${port}/login?key=${key}`;
}

// This machine's tailnet address and MagicDNS name, as Tailscale itself reports them. Never
// guessed from an interface in 100.64.0.0/10: that range is also carrier-grade NAT.
// The Mac App Store and standalone apps don't put `tailscale` on PATH; their CLI is inside the app.
const CLIS = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
const status = () => {
  for (const cli of CLIS) {
    try { const r = Bun.spawnSync([cli, "status", "--json"], { timeout: 3000 }); if (r.exitCode === 0) return r; } catch { /* not installed here */ }
  }
  return { exitCode: 1, stdout: Buffer.from("") };
};
type Run = () => { exitCode: number | null; stdout: Buffer | Uint8Array };
const cli = (args: string[]): Run => () => {
  for (const c of CLIS) {
    try { const r = Bun.spawnSync([c, ...args], { timeout: 3000 }); if (r.exitCode === 0) return r; } catch { /* not installed here */ }
  }
  return { exitCode: 1, stdout: Buffer.from("") };
};

// Doctor's checks on the tailnet door (pocketbrain doctor): no `tailscale funnel` on the serve port
// or the dashboard port, no tunnel rule that forwards to the serve port, and no owner login left
// set while the tailnet dashboard is off. `serveStatus` is `tailscale serve status --json`.
export type DoorFinding = { level: "ok"; text: string } | { level: "warn" | "FAIL"; id: OwnerErrorId; vars?: Vars };
export function tailnetDoorChecks(
  cfg: { dashboard_tailnet?: boolean; dashboard_tailnet_login?: string; dashboard_tailnet_devices?: string[]; dashboard_port?: number },
  ingress: { hostname?: string; service?: string }[],
  serveStatus: Run = cli(["serve", "status", "--json"]),
): DoorFinding[] {
  if (!cfg.dashboard_tailnet) return cfg.dashboard_tailnet_login ? [{ level: "warn", id: "doctor.tailnet-login-off" }] : [];
  const out: DoorFinding[] = [];
  const ports = [String(SERVE_PORT), String(cfg.dashboard_port ?? 8788)];
  if (!(cfg.dashboard_tailnet_devices ?? []).some((ip) => isTailnetIp(ip))) out.push({ level: "warn", id: "doctor.tailnet-no-devices" });
  for (const r of ingress) if (ports.some((p) => r.service?.includes(`:${p}`)) || /\.ts\.net/i.test(r.service ?? "")) out.push({ level: "FAIL", id: "doctor.tailnet-tunnel", vars: { service: r.service ?? "" } });
  const st = readServe(serveStatus);
  if (!st) out.push({ level: "warn", id: "doctor.tailnet-serve-unread" });
  else {
    const funnels = Object.entries(st.AllowFunnel ?? {}).filter(([, v]) => v).map(([k]) => k);
    const bad = funnels.filter((hp) => ports.some((p) => hp.endsWith(`:${p}`)));
    if (bad.length) out.push({ level: "FAIL", id: "doctor.tailnet-funnel", vars: { hosts: bad.join(", "), port: bad[0].split(":").pop() ?? "" } });
    if (cfg.dashboard_tailnet_login && !servesDashboard(st, cfg.dashboard_port ?? 8788)) out.push({ level: "FAIL", id: "doctor.tailnet-no-serve", vars: { port: String(cfg.dashboard_port ?? 8788) } });
  }
  if (!out.length) out.push({ level: "ok", text: `tailnet dashboard: no funnel or tunnel rule reaches ports ${ports.join(" or ")}; ${cfg.dashboard_tailnet_devices!.length} device(s) listed` });
  return out;
}

type ServeStatus = { AllowFunnel?: Record<string, boolean>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
function readServe(serveStatus: Run): ServeStatus | undefined {
  try { const r = serveStatus(); return r.exitCode === 0 ? JSON.parse(Buffer.from(r.stdout).toString() || "{}") as ServeStatus : undefined; } catch { return undefined; }
}
// `tailscale serve` answers https on SERVE_PORT by proxying to the dashboard's own port.
function servesDashboard(st: ServeStatus, port: number): boolean {
  return Object.entries(st.Web ?? {}).some(([hp, w]) => hp.endsWith(`:${SERVE_PORT}`) && Object.values(w.Handlers ?? {}).some((h) => new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${port}/?$`).test(h.Proxy ?? "")));
}

/** The probe's check on the phone app's door (G629): with the owner's Tailscale login set, the
 *  https door is `tailscale serve` on SERVE_PORT to the dashboard; a sentence when it's missing.
 *  Undefined when it's there, when the login isn't set, or when Tailscale's CLI doesn't answer. */
export function serveDoorProblem(cfg: { dashboard_tailnet?: boolean; dashboard_tailnet_login?: string; dashboard_port?: number }, serveStatus: Run = cli(["serve", "status", "--json"])): string | undefined {
  if (!cfg.dashboard_tailnet || !cfg.dashboard_tailnet_login) return undefined;
  const st = readServe(serveStatus);
  const port = cfg.dashboard_port ?? 8788;
  return !st || servesDashboard(st, port) ? undefined : `nothing serves https on ${SERVE_PORT} to the dashboard, so the phone app can't reach it; run tailscale serve --bg --https=${SERVE_PORT} http://127.0.0.1:${port}`;
}

export function tailnetSelf(run: () => { exitCode: number | null; stdout: Buffer | Uint8Array } = status): { address: string; name?: string } | undefined {
  try {
    const r = run();
    if (r.exitCode !== 0) return undefined;
    const self = (JSON.parse(Buffer.from(r.stdout).toString()) as { Self?: { DNSName?: string; TailscaleIPs?: string[] } }).Self;
    const address = self?.TailscaleIPs?.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip) && isTailnetIp(ip));
    if (!address) return undefined;
    const name = self?.DNSName?.replace(/\.$/, "").toLowerCase();
    return name && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(name) ? { address, name } : { address };
  } catch { return undefined; }
}
