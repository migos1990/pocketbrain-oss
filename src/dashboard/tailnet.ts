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
  let funnels: string[] | undefined;
  try {
    const r = serveStatus();
    if (r.exitCode === 0) funnels = Object.entries((JSON.parse(Buffer.from(r.stdout).toString() || "{}") as { AllowFunnel?: Record<string, boolean> }).AllowFunnel ?? {}).filter(([, v]) => v).map(([k]) => k);
  } catch { funnels = undefined; }
  if (!funnels) out.push({ level: "warn", id: "doctor.tailnet-serve-unread" });
  else {
    const bad = funnels.filter((hp) => ports.some((p) => hp.endsWith(`:${p}`)));
    if (bad.length) out.push({ level: "FAIL", id: "doctor.tailnet-funnel", vars: { hosts: bad.join(", "), port: bad[0].split(":").pop() ?? "" } });
  }
  if (!out.length) out.push({ level: "ok", text: `tailnet dashboard: no funnel or tunnel rule reaches ports ${ports.join(" or ")}; ${cfg.dashboard_tailnet_devices!.length} device(s) listed` });
  return out;
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
