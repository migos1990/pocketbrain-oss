// SPDX-License-Identifier: AGPL-3.0-only
// `pocketbrain phone` (src/phone.ts, docs/phone-app.md): one command in place of the tailnet steps
// done by hand. It shows the exact rules/ lines and writes them only on a yes, lets in only the
// chosen phone and this machine's own Tailscale login (never replacing one the owner set), puts
// `tailscale serve` on 8443, and prints a QR that decodes to the app's pair link.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import jsQR from "jsqr";
import { makeBrain } from "./fixture";
import { git } from "../src/git";
import { pairPhone, qrMatrix, qrText, readTailnet, type Run } from "../src/phone";
import { setDashboardTailnet } from "../src/ownerset";
import { tailnetSettings, SERVE_PORT } from "../src/dashboard/tailnet";
import { mintPhoneLink } from "../src/dashboard/server";

const NAME = "studio.tail1234.ts.net";
const status = (o: { phones?: { name: string; ip: string; os?: string; user?: number; online?: boolean }[]; state?: string } = {}) => JSON.stringify({
  BackendState: o.state ?? "Running",
  Self: { HostName: "studio", DNSName: `${NAME}.`, OS: "macOS", UserID: 7, TailscaleIPs: ["100.101.1.1", "fd7a:115c:a1e0::1"] },
  Peer: Object.fromEntries((o.phones ?? [{ name: "louis-iphone", ip: "100.101.2.2" }]).map((p, i) => [`k${i}`, { HostName: p.name, DNSName: `${p.name}.tail1234.ts.net.`, OS: p.os ?? "iOS", UserID: p.user ?? 7, TailscaleIPs: [p.ip], Online: p.online ?? true }])),
  User: { "7": { LoginName: "owner@example.com" }, "9": { LoginName: "someone@example.com" } },
});

function fakeTailscale(o: { status?: string; serving?: boolean; serveFails?: string } = {}) {
  const calls: string[][] = [];
  let on = !!o.serving;
  const run: Run = (a) => {
    calls.push(a);
    if (a[0] === "status") return { code: 0, out: o.status ?? status() };
    if (a[0] === "serve" && a[1] === "status") return { code: 0, out: JSON.stringify(on ? { Web: { [`${NAME}:${SERVE_PORT}`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:8788" } } } } } : {}) };
    if (a[0] === "serve") { if (o.serveFails) return { code: 1, out: o.serveFails }; on = true; return { code: 0, out: "" }; }
    return { code: 1, out: "?" };
  };
  return { run, calls };
}

function go(root: string, o: Partial<Parameters<typeof pairPhone>[0]> & { run: Run }) {
  const out: string[] = [];
  let restarts = 0, minted: string[] = [];
  const code = pairPhone({
    mint: () => { const k = mintPhoneLink(root); minted.push(k); return k; },
    setTailnet: (d, l) => setDashboardTailnet(root, true, d, l), settings: () => tailnetSettings(root),
    restart: () => { restarts++; return "hub restarted"; }, rulesFile: "rules/policy.yaml",
    say: (s) => out.push(s), ...o,
  });
  return { code, out: out.join("\n"), restarts, minted };
}
const policyText = (root: string) => readFileSync(join(root, "rules", "policy.yaml"), "utf8");
const commits = (root: string) => git(root, ["rev-list", "--count", "HEAD"]).trim();

function decode(text: string): string | undefined {
  const m = qrMatrix(text), s = 4, q = 4, n = (m.length + q * 2) * s;
  const px = new Uint8ClampedArray(n * n * 4).fill(255);
  for (let r = 0; r < m.length; r++) for (let c = 0; c < m.length; c++) if (m[r][c])
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) { const i = (((r + q) * s + y) * n + (c + q) * s + x) * 4; px[i] = px[i + 1] = px[i + 2] = 0; }
  return jsQR(px, n, n)?.data;
}

test("only this account's phones are offered, online first; a laptop or another person's phone is not", () => {
  const t = readTailnet(fakeTailscale({ status: status({ phones: [
    { name: "old-ipad", ip: "100.101.3.3", online: false }, { name: "pixel", ip: "100.101.4.4", os: "android" },
    { name: "theirs", ip: "100.101.5.5", user: 9 }, { name: "laptop", ip: "100.101.6.6", os: "macOS" },
  ] }) }).run);
  expect(t).toMatchObject({ name: NAME, address: "100.101.1.1", login: "owner@example.com" });
  expect(typeof t !== "string" && t.phones.map((p) => p.name)).toEqual(["pixel", "old-ipad"]);
});

test("Tailscale not running: one sentence, nothing written, nothing minted", () => {
  const root = makeBrain(), before = policyText(root);
  const r = go(root, { run: fakeTailscale({ status: status({ state: "NeedsLogin" }) }).run, yes: true });
  expect(r.code).toBe(1);
  expect(r.out).toContain("sign in");
  expect(policyText(root)).toBe(before);
  expect(r.minted).toEqual([]);
});

test("with no terminal and no --device it lists the phones and stops, writing nothing", () => {
  const root = makeBrain(), before = policyText(root);
  const r = go(root, { run: fakeTailscale().run, yes: true });
  expect(r.code).toBe(2);
  expect(r.out).toContain("--device");
  expect(r.out).toContain("louis-iphone");
  expect(policyText(root)).toBe(before);
});

test("rules/ lines are shown first and nothing is written without a yes", () => {
  const root = makeBrain(), before = policyText(root), n = commits(root);
  const r = go(root, { run: fakeTailscale().run, device: "louis-iphone" });
  expect(r.code).toBe(2);
  expect(r.out).toContain("dashboard_tailnet: true");
  expect(r.out).toContain("dashboard_tailnet_devices: [100.101.2.2]");
  expect(r.out).toContain("dashboard_tailnet_login: owner@example.com");
  expect(r.out).toContain("--yes");
  expect(policyText(root)).toBe(before);
  expect(commits(root)).toBe(n);
  // A typed no at a terminal is a no too.
  const t = go(root, { run: fakeTailscale().run, ask: () => "n" });
  expect(t.code).toBe(1);
  expect(policyText(root)).toBe(before);
});

test("on a yes it writes only the three tailnet keys, serves 8443, restarts, and the QR decodes to the app's pair link", () => {
  const root = makeBrain(), before = YAML.parse(policyText(root));
  const ts = fakeTailscale();
  const r = go(root, { run: ts.run, ask: (q) => (q.includes("[Y/n]") || q.includes("[y/N]") ? "y" : "") });
  expect(r.code).toBe(0);
  const after = YAML.parse(policyText(root));
  expect(after).toEqual({ ...before, dashboard_tailnet: true, dashboard_tailnet_devices: ["100.101.2.2"], dashboard_tailnet_login: "owner@example.com" });
  expect(ts.calls).toContainEqual(["serve", "--bg", `--https=${SERVE_PORT}`, "http://127.0.0.1:8788"]);
  expect(ts.calls.some((c) => c.includes("funnel"))).toBe(false);
  expect(r.restarts).toBe(1);
  const link = `pocketbrain://pair?hub=${encodeURIComponent(`https://${NAME}:${SERVE_PORT}`)}&key=${encodeURIComponent(r.minted[0])}`;
  expect(r.out).toContain(link);
  expect(decode(link)).toBe(link);
  expect(r.minted.length).toBe(1);
});

test("on a hub already set up (the owner's own Mac) it asks nothing, writes nothing, restarts nothing: only the QR", () => {
  const root = makeBrain();
  setDashboardTailnet(root, true, ["100.101.2.2"], "owner@example.com");
  const before = policyText(root), n = commits(root);
  let asked = 0;
  const r = go(root, { run: fakeTailscale({ serving: true }).run, device: "louis-iphone", ask: () => { asked++; return "y"; } });
  expect(r.code).toBe(0);
  expect(asked).toBe(0);
  expect(policyText(root)).toBe(before);
  expect(commits(root)).toBe(n);
  expect(r.restarts).toBe(0);
  expect(r.out).toContain("pocketbrain://pair?");
});

test("a login the owner set is never replaced, even when this machine signs in as someone else", () => {
  const root = makeBrain();
  setDashboardTailnet(root, true, ["100.101.9.9"], "chosen@example.com");
  const r = go(root, { run: fakeTailscale().run, device: "100.101.2.2", yes: true });
  expect(r.code).toBe(0);
  expect(r.out).not.toContain("dashboard_tailnet_login:");
  expect(tailnetSettings(root)).toMatchObject({ dashboard_tailnet_login: "chosen@example.com", dashboard_tailnet_devices: ["100.101.9.9", "100.101.2.2"] });
});

test("when Tailscale won't serve (Serve not enabled yet) its own words are shown and no link is minted", () => {
  const root = makeBrain();
  const r = go(root, { run: fakeTailscale({ serveFails: "Serve is not enabled on your tailnet. To enable, visit the link Tailscale prints" }).run, device: "louis-iphone", yes: true });
  expect(r.code).toBe(1);
  expect(r.out).toContain("Serve is not enabled on your tailnet");
  expect(r.minted).toEqual([]);
});

test("the terminal QR draws exactly the code's modules, white on black whatever the terminal's colours", () => {
  const link = "pocketbrain://pair?hub=https%3A%2F%2Fstudio.tail1234.ts.net%3A8443&key=abc";
  const m = qrMatrix(link), text = qrText(link), lines = text.split("\n");
  expect(lines.every((l) => l.startsWith("\x1b[97;40m") && l.endsWith("\x1b[0m"))).toBe(true);
  const rows: boolean[][] = []; // true = dark, read back from the half blocks
  for (const l of lines) {
    const chars = [...l.replace(/\x1b\[[0-9;]*m/g, "")];
    rows.push(chars.map((c) => c === " " || c === "▄"), chars.map((c) => c === " " || c === "▀"));
  }
  const pad = 2;
  for (let r = 0; r < m.length; r++) expect(rows[r + pad].slice(pad, pad + m.length)).toEqual(m[r]);
});
