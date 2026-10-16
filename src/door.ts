// SPDX-License-Identifier: AGPL-3.0-only
// A door per pilot user (docs/pilot-door.md). Two halves, both through the cloudflared CLI so
// pocketBrain names no new outbound host and stores no Cloudflare key:
//   - `pocketbrain pilot door <name> --zone <zone>`, run by the operator (signed in to their own
//     Cloudflare account with `cloudflared tunnel login`): a named tunnel pb-<name>, its
//     credentials file kept 0600, and a DNS route <name>.<zone> to it.
//   - `pocketbrain door install <credentials.json> --hostname <host>`, run by the pilot: the
//     credentials under ~/.cloudflared (0600), a cloudflared config whose ingress is the agent API
//     only (the same as `hub tunnel-config`), and public_url and tunnel in rules/hub.yaml.
// The tunnel secret is never printed: it travels as the file, through a password manager share.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as hub from "./hub";

const NAME = /^[a-z][a-z0-9-]{1,30}$/;
const ZONE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const MARK = "# written by pocketbrain door install";

export interface DoorResult { ok: boolean; lines: string[]; hostname?: string }

function cf(bin: string, args: string[]): hub.Run {
  try {
    const r = Bun.spawnSync([bin, ...args], { timeout: 120_000 });
    return { code: r.exitCode ?? 1, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
  } catch (e) { return { code: 127, out: "", err: (e as Error).message }; }
}

export function pilotDoor(name: string, o: { zone: string; out?: string; cloudflared?: string }): DoorResult {
  const no = (why: string): DoorResult => ({ ok: false, lines: [why] });
  if (!NAME.test(name)) return no("the pilot's name is 2 to 31 lowercase letters, digits and dashes, starting with a letter");
  const zone = o.zone.trim().toLowerCase().replace(/\.$/, "");
  if (!ZONE.test(zone)) return no(`--zone must be a domain on your Cloudflare account, like brains.example (got "${o.zone}")`);
  const tunnel = `pb-${name}`, hostname = `${name}.${zone}`;
  const out = o.out ?? join(homedir(), ".cloudflared");
  const file = join(out, `${tunnel}.json`);
  if (existsSync(file)) return no(`${file} already exists: ${tunnel} was made before. Send that file again, or delete the tunnel (cloudflared tunnel delete ${tunnel}) and the file to start over`);
  mkdirSync(out, { recursive: true });
  const bin = o.cloudflared ?? "cloudflared";
  const made = cf(bin, ["tunnel", "create", "--credentials-file", file, tunnel]);
  if (made.code !== 0 || !existsSync(file)) return no(made.code === 127 ? "cloudflared isn't installed (brew install cloudflared), then sign in once: cloudflared tunnel login" : `cloudflared couldn't create ${tunnel} (${made.err.slice(0, 300)}); sign in with cloudflared tunnel login if you haven't`);
  chmodSync(file, 0o600);
  const lines = [`tunnel ${tunnel} created; its credentials are in ${file} (only you can read it)`];
  const routed = cf(bin, ["tunnel", "route", "dns", tunnel, hostname]);
  if (routed.code !== 0) return { ok: false, hostname, lines: [...lines, `the DNS route failed (${routed.err.slice(0, 300)}). Fix it, then run: cloudflared tunnel route dns ${tunnel} ${hostname}`] };
  lines.push(
    `${hostname} now points at ${tunnel}`,
    ``,
    `Send ${file} to the pilot through a password manager share, never chat or email: it lets anyone run their door.`,
    `On their machine, in their brain folder:`,
    `  pocketbrain door install ${tunnel}.json --hostname ${hostname} --name <their machine>`,
  );
  return { ok: true, hostname, lines };
}

export function installDoor(root: string, o: { credentials: string; hostname: string; name?: string; home?: string; port?: number; force?: boolean }): DoorResult {
  const no = (why: string): DoorResult => ({ ok: false, lines: [why] });
  const host = o.hostname.trim().toLowerCase();
  if (!ZONE.test(host)) return no(`--hostname is the door's name only, like sam.brains.example (got "${o.hostname}")`);
  let c: { TunnelID?: unknown; TunnelSecret?: unknown; AccountTag?: unknown };
  try { c = JSON.parse(readFileSync(o.credentials, "utf8")); } catch { return no(`can't read ${o.credentials} as a tunnel credentials file`); }
  const id = typeof c.TunnelID === "string" && /^[0-9a-f-]{36}$/.test(c.TunnelID) ? c.TunnelID : "";
  if (!id || typeof c.TunnelSecret !== "string" || typeof c.AccountTag !== "string") return no(`${o.credentials} isn't a tunnel credentials file (it needs TunnelID, TunnelSecret and AccountTag)`);

  const dir = join(o.home ?? homedir(), ".cloudflared");
  const config = join(dir, "config.yml");
  if (existsSync(config) && !o.force && !readFileSync(config, "utf8").startsWith(MARK)) return no(`${config} is already there and pocketBrain didn't write it; look at it, then run again with --force to replace it`);
  const before = hub.loadHub(root);
  if (!before && !o.name) return no("this brain has no rules/hub.yaml yet: add --name <this machine> so it can be the hub");

  mkdirSync(dir, { recursive: true });
  const placed = join(dir, `${id}.json`);
  copyFileSync(o.credentials, placed);
  chmodSync(placed, 0o600);
  const url = `https://${host}`;
  const lines: string[] = [];
  try {
    if (!before) lines.push(...hub.init(root, { name: o.name!, publicUrl: url }));
    lines.push(hub.setDoor(root, { public_url: url, tunnel: { kind: "cloudflare", name: id, config } }));
  } catch (e) { return no((e as Error).message); }
  const ing = hub.tunnelConfig(root).replace(/^credentials-file: .*$/m, `credentials-file: ${placed}`);
  writeFileSync(config, `${MARK}\n${ing}`);
  lines.push(
    `credentials in ${placed} (only you can read it); ${config} forwards only the agent API`,
    `Next: pocketbrain start --launchd --tunnel ${id} --write, load both files with launchctl as it says, then pocketbrain doctor (the door line should read ok).`,
  );
  return { ok: true, hostname: host, lines };
}
