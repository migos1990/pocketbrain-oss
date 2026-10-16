// SPDX-License-Identifier: AGPL-3.0-only
// A door per pilot user (docs/pilot-door.md). The operator makes a named Cloudflare tunnel and a
// hostname under their own zone (`pocketbrain pilot door`); the pilot installs its credentials
// (`pocketbrain door install`), which writes the agent-API-only ingress and sets public_url.
// The tunnel secret is never printed, and the credentials file is readable only by its owner.
import { test, expect, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { pilotDoor, installDoor } from "../src/door";
import { loadHub, tunnelConfig } from "../src/hub";

const ID = "6ff42ae2-765d-4adf-8112-31c55c1551ef";
const SECRET = "c2VjcmV0LXR1bm5lbC1zZWNyZXQtZm9yLXRlc3Rz";
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

function fakeCloudflared(opts: { failRoute?: boolean } = {}) {
  const dir = tmp("pb-cf-");
  const log = join(dir, "argv.log");
  writeFileSync(join(dir, "cloudflared"), `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  "tunnel create --credentials-file "*) f="$4"; printf '{"AccountTag":"acct1","TunnelSecret":"${SECRET}","TunnelID":"${ID}"}' > "$f"; echo "Created tunnel $5 with id ${ID}" ;;
  "tunnel route dns "*) ${opts.failRoute ? 'echo "record exists" >&2; exit 1' : 'echo "Added CNAME $5"'} ;;
  *) echo "unknown $*" >&2; exit 2 ;;
esac
`);
  chmodSync(join(dir, "cloudflared"), 0o755);
  return { bin: join(dir, "cloudflared"), log, argv: () => readFileSync(log, "utf8") };
}

test("pilot door: one named tunnel and one hostname per pilot, credentials kept to the operator, secret never printed", () => {
  const cf = fakeCloudflared();
  const out = tmp("pb-door-out-");
  const r = pilotDoor("sam", { zone: "brains.example", out, cloudflared: cf.bin });
  expect(r.ok).toBe(true);
  expect(r.hostname).toBe("sam.brains.example");
  expect(cf.argv()).toContain(`tunnel create --credentials-file ${join(out, "pb-sam.json")} pb-sam`);
  expect(cf.argv()).toContain("tunnel route dns pb-sam sam.brains.example");
  expect(statSync(join(out, "pb-sam.json")).mode & 0o077).toBe(0);
  const said = r.lines.join("\n");
  expect(said).not.toContain(SECRET);
  expect(said).toContain("pocketbrain door install");
  expect(said).toContain("--hostname sam.brains.example");
});

test("pilot door refuses a bad name or zone and a second run over existing credentials", () => {
  const cf = fakeCloudflared();
  const out = tmp("pb-door-out-");
  expect(pilotDoor("Sam!", { zone: "brains.example", out, cloudflared: cf.bin }).lines.join()).toMatch(/lowercase/);
  expect(pilotDoor("sam", { zone: "not a zone", out, cloudflared: cf.bin }).lines.join()).toMatch(/zone/);
  writeFileSync(join(out, "pb-sam.json"), "{}");
  const again = pilotDoor("sam", { zone: "brains.example", out, cloudflared: cf.bin });
  expect(again.ok).toBe(false);
  expect(again.lines.join()).toContain("already");
  expect(existsSync(cf.log)).toBe(false);
});

test("pilot door: a DNS route that fails says how to finish, and nothing is half-hidden", () => {
  const cf = fakeCloudflared({ failRoute: true });
  const out = tmp("pb-door-out-");
  const r = pilotDoor("sam", { zone: "brains.example", out, cloudflared: cf.bin });
  expect(r.ok).toBe(false);
  expect(r.lines.join("\n")).toContain("cloudflared tunnel route dns pb-sam sam.brains.example");
});

function creds() {
  const f = join(tmp("pb-creds-"), "pb-sam.json");
  writeFileSync(f, JSON.stringify({ AccountTag: "acct1", TunnelSecret: SECRET, TunnelID: ID }));
  return f;
}

test("door install: credentials 0600 under ~/.cloudflared, an agent-API-only ingress, public_url and tunnel in hub.yaml", () => {
  const root = makeBrain();
  const home = tmp("pb-home-");
  const r = installDoor(root, { credentials: creds(), hostname: "sam.brains.example", name: "sam-mac", home });
  expect(r.ok).toBe(true);
  const placed = join(home, ".cloudflared", `${ID}.json`);
  expect(statSync(placed).mode & 0o077).toBe(0);
  const cfg = loadHub(root)!;
  expect(cfg.public_url).toBe("https://sam.brains.example");
  expect(cfg.tunnel).toEqual({ kind: "cloudflare", name: ID, config: join(home, ".cloudflared", "config.yml") });
  const ing = YAML.parse(readFileSync(join(home, ".cloudflared", "config.yml"), "utf8"));
  expect(ing.tunnel).toBe(ID);
  expect(ing["credentials-file"]).toBe(placed);
  expect(ing.ingress[0]).toMatchObject({ hostname: "sam.brains.example", service: "http://127.0.0.1:8787" });
  expect(ing.ingress[0].path).toBe(YAML.parse(tunnelConfig(root)).ingress[0].path);
  expect(ing.ingress.at(-1)).toEqual({ service: "http_status:404" });
  expect(JSON.stringify(ing)).not.toContain("8788");
  const said = r.lines.join("\n");
  expect(said).not.toContain(SECRET);
  expect(said).toContain(`pocketbrain start --launchd --tunnel ${ID}`);
});

test("door install keeps a cloudflared config it didn't write, and refuses credentials that aren't a tunnel's", () => {
  const root = makeBrain();
  const home = tmp("pb-home-");
  mkdirSync(join(home, ".cloudflared"));
  writeFileSync(join(home, ".cloudflared", "config.yml"), "tunnel: other\n");
  const r = installDoor(root, { credentials: creds(), hostname: "sam.brains.example", name: "sam-mac", home });
  expect(r.ok).toBe(false);
  expect(r.lines.join()).toContain("--force");
  expect(readFileSync(join(home, ".cloudflared", "config.yml"), "utf8")).toBe("tunnel: other\n");
  expect(loadHub(root)).toBeUndefined();
  const bad = join(tmp("pb-creds-"), "x.json");
  writeFileSync(bad, JSON.stringify({ hello: "world" }));
  expect(installDoor(root, { credentials: bad, hostname: "sam.brains.example", name: "sam-mac", home: tmp("pb-home-") }).lines.join()).toMatch(/TunnelID/);
  expect(installDoor(root, { credentials: creds(), hostname: "https://x/y", name: "sam-mac", home: tmp("pb-home-") }).lines.join()).toMatch(/hostname/);
});

test("door install on a brain already in hub mode only changes its door", () => {
  const root = makeBrain();
  const home = tmp("pb-home-");
  expect(installDoor(root, { credentials: creds(), hostname: "sam.brains.example", name: "sam-mac", home }).ok).toBe(true);
  const r = installDoor(root, { credentials: creds(), hostname: "door.brains.example", home, force: true });
  expect(r.ok).toBe(true);
  expect(loadHub(root)).toMatchObject({ hub: "sam-mac", epoch: 1, public_url: "https://door.brains.example" });
});
