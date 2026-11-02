// SPDX-License-Identifier: AGPL-3.0-only
// The dashboard on the owner's tailnet (docs/dashboard-tailnet.md): off unless the owner opts
// in; on, it answers only the owner's listed devices asking for this machine's tailnet names, with the same
// login, cookie and CSRF; the loopback listener never takes tailnet names, and the Cloudflare
// tunnel never reaches either.
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { dashboardHandler, serveDashboard } from "../src/dashboard/server";
import { isTailnetIp, tailnetSelf, SERVE_PORT } from "../src/dashboard/tailnet";
import { tunnelConfig } from "../src/hub";

const PORT = 8788, KEY = "k".repeat(32);
const PHONE = "100.88.1.2", BOX = "100.77.3.4"; // the owner's phone, and another machine on the same account
const TN = { address: "100.101.102.103", name: "mini.tail1234.ts.net", login: "robin@example.com", devices: [PHONE] };

function setup(on = true) {
  const root = makeBrain();
  const d = dashboardHandler(root, { port: PORT, loginKey: KEY });
  if (on) d.setTailnet(TN, PORT);
  const H = `${TN.name}:${PORT}`;
  const tn = (path: string, o: { peer?: string; host?: string; cookie?: string; method?: string; body?: URLSearchParams; origin?: string } = {}) =>
    d.handleTailnet(new Request(`http://${o.host ?? H}${path}`, { method: o.method ?? "GET", body: o.body, headers: { host: o.host ?? H, ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.origin ? { origin: o.origin } : {}), ...(o.body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }), "peer" in o ? o.peer : PHONE);
  return { root, d, H, tn };
}

test("tailnet addresses: 100.64.0.0/10 and fd7a:115c:a1e0::/48 only", () => {
  for (const ip of ["100.64.0.1", "100.127.255.254", "::ffff:100.100.1.1", "fd7a:115c:a1e0::1"]) expect(isTailnetIp(ip)).toBe(true);
  for (const ip of ["100.63.255.255", "100.128.0.1", "127.0.0.1", "192.168.1.5", "10.0.0.2", "::1", "fd7a:115c:a1e1::1", "", undefined, "100.64.0.999"]) expect(isTailnetIp(ip as string)).toBe(false);
  // The address and name come from Tailscale itself, never from an interface in the CGNAT range (G100).
  const out = (o: unknown, exitCode = 0) => () => ({ exitCode, stdout: Buffer.from(JSON.stringify(o)) }) as any;
  expect(tailnetSelf(out({ Self: { DNSName: "Mini.tail1234.ts.net.", TailscaleIPs: ["fd7a:115c:a1e0::1", "100.101.102.103"] } }))).toEqual({ address: "100.101.102.103", name: "mini.tail1234.ts.net" });
  expect(tailnetSelf(out({ Self: { DNSName: "evil.example.", TailscaleIPs: ["100.101.102.103"] } }))).toEqual({ address: "100.101.102.103" });
  expect(tailnetSelf(out({ Self: { TailscaleIPs: ["192.168.1.5"] } }))).toBeUndefined();
  expect(tailnetSelf(out({}, 1))).toBeUndefined();
  expect(tailnetSelf(() => { throw new Error("no tailscale"); })).toBeUndefined();
});

test("off by default: the tailnet listener answers nothing, and the dashboard binds loopback only", async () => {
  const { tn } = setup(false);
  expect((await tn(`/login?key=${KEY}`)).status).toBe(404);
  const s = serveDashboard(makeBrain(), { port: 0 });
  try {
    expect(s.server.hostname).toBe("127.0.0.1");
    expect("tailnetServer" in s).toBe(false);
  } finally { s.server.stop(true); }
});

test("on: the owner's phone signs in over the tailnet and acts with the CSRF token", async () => {
  const { tn, H } = setup();
  const login = await tn(`/login?key=${KEY}`);
  expect(login.status).toBe(303);
  const cookie = login.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax"); // kept when a link is opened from Messages; actions need the CSRF token
  const c = cookie.split(";")[0];
  const home = await tn("/", { cookie: c });
  expect(home.status).toBe(200);
  const csrf = (await home.text()).match(/name="csrf" value="([^"]+)"/)![1];
  const post = (o: { csrf?: string; origin?: string }) => tn("/action/agent-status", { cookie: c, method: "POST", body: new URLSearchParams({ csrf: o.csrf ?? csrf, agent: "helper", status: "paused" }), origin: o.origin });
  expect((await post({ origin: `http://${H}` })).status).toBe(303);
  expect((await post({ origin: "https://brain.pocketbrain.dev" })).status).toBe(403);
  expect((await post({ origin: `http://127.0.0.1:${PORT}` })).status).toBe(403); // a loopback page can't post to the tailnet listener
  expect((await post({ csrf: "nope", origin: `http://${H}` })).status).toBe(403);
  expect((await tn(`/login?key=wrong`)).status).toBe(403);
});

test("on: a peer outside the tailnet, a public or loopback Host, and a tailnet Host on loopback are all refused", async () => {
  const { d, tn } = setup();
  for (const peer of ["192.168.1.5", "127.0.0.1", "203.0.113.9", undefined]) expect((await tn(`/login?key=${KEY}`, { peer })).status).toBe(403);
  for (const host of ["brain.pocketbrain.dev", `brain.pocketbrain.dev:${PORT}`, `127.0.0.1:${PORT}`, `evil.ts.net:${PORT}`, `${TN.name}:9999`]) expect((await tn(`/login?key=${KEY}`, { host })).status).toBe(421);
  expect((await tn(`/login?key=${KEY}`, { host: `${TN.address}:${PORT}` })).status).toBe(303);
  // The loopback listener keeps answering only loopback names.
  const viaLoopback = await d.handle(new Request(`http://${TN.name}:${PORT}/login?key=${KEY}`, { headers: { host: `${TN.name}:${PORT}` } }));
  expect(viaLoopback.status).toBe(421);
  expect((await d.handle(new Request(`http://127.0.0.1:${PORT}/login?key=${KEY}`, { headers: { host: `127.0.0.1:${PORT}` } }))).status).toBe(303);
});

test("on, with no Tailscale address: a clear problem, and the dashboard stays on localhost", () => {
  const s = serveDashboard(makeBrain(), { port: 0, tailnet: { address: "192.168.1.5" } });
  try {
    expect("tailnetProblem" in s && s.tailnetProblem).toContain("no Tailscale address");
    expect("tailnetServer" in s).toBe(false);
  } finally { s.server.stop(true); }
});

test("the Cloudflare tunnel still points only at the agents' port, and none of the dashboard's paths match its ingress", () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules/hub.yaml"), "hub: mini\nepoch: 1\nreplicas: {}\npublic_url: https://brain.example.com\nport: 8787\ndashboard_port: 8788\ndashboard_tailnet: true\n");
  const cfg = tunnelConfig(root);
  expect(cfg).toContain("service: http://127.0.0.1:8787");
  expect(cfg).not.toContain("8788");
  const ingress = new RegExp(cfg.match(/path: (.*)/)![1]);
  for (const p of ["/", "/login", "/action/pause", "/brain", "/agents", "/note/x", "/ask"]) expect(ingress.test(p)).toBe(false);
});

test("tailscale serve on its own https port (not 443, which a funnel door may hold): only the owner's Tailscale login, never funnel or Cloudflare traffic (G99, G101)", async () => {
  const { d } = setup();
  const S = `${TN.name}:${SERVE_PORT}`;
  const req = (path: string, h: Record<string, string>, init: RequestInit = {}) => d.handle(new Request(`http://127.0.0.1:${PORT}${path}`, { ...init, headers: h }));
  const owner = { "tailscale-user-login": TN.login, "x-forwarded-for": PHONE };
  expect((await req(`/login?key=${KEY}`, { host: S })).status).toBe(403); // no identity
  expect((await req(`/login?key=${KEY}`, { host: S, "tailscale-user-login": "someone@else.example" })).status).toBe(403);
  expect((await req(`/login?key=${KEY}`, { host: S, ...owner, "tailscale-funnel-request": "?1" })).status).toBe(403);
  expect((await req(`/login?key=${KEY}`, { host: S, ...owner, "cf-connecting-ip": "203.0.113.9" })).status).toBe(403);
  for (const host of [TN.name, `${TN.name}:443`]) expect((await req(`/login?key=${KEY}`, { host, ...owner })).status).toBe(421);
  const login = await req(`/login?key=${KEY}`, { host: S, ...owner });
  expect(login.status).toBe(303);
  expect(login.headers.get("set-cookie")).toContain("Secure"); // https through serve (G104)
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const home = await req("/", { host: S, cookie, ...owner });
  expect(home.status).toBe(200);
  const csrf = (await home.text()).match(/name="csrf" value="([^"]+)"/)![1];
  const post = (origin: string, h: Record<string, string> = owner) => req("/action/agent-status", { host: S, cookie, origin, "content-type": "application/x-www-form-urlencoded", ...h }, { method: "POST", body: new URLSearchParams({ csrf, agent: "helper", status: "paused" }) });
  expect((await post(`https://${S}`)).status).toBe(303);
  expect((await post(`http://127.0.0.1:${PORT}`)).status).toBe(403);
  expect((await post("https://brain.pocketbrain.dev")).status).toBe(403);
  expect((await post(`https://${S}`, {})).status).toBe(403);
  expect((await post(`https://${S}`, { "tailscale-user-login": TN.login })).status).toBe(403); // no device address
  // No owner login set: the serve path is off; the MagicDNS name is just a foreign Host.
  const noLogin = dashboardHandler(makeBrain(), { port: PORT, loginKey: KEY });
  noLogin.setTailnet({ address: TN.address, name: TN.name }, PORT);
  expect((await noLogin.handle(new Request(`http://127.0.0.1:${PORT}/login?key=${KEY}`, { headers: { host: S, ...owner } }))).status).toBe(421);
  const off = setup(false);
  expect((await off.d.handle(new Request(`http://127.0.0.1:${PORT}/login?key=${KEY}`, { headers: { host: S, ...owner } }))).status).toBe(421);
});

test("a tailnet address this machine can't bind is a logged problem, not a crash of the hub (G103)", () => {
  const s = serveDashboard(makeBrain(), { port: 0, tailnet: { address: "100.101.102.103", name: TN.name } });
  try {
    expect("tailnetProblem" in s && s.tailnetProblem).toContain("couldn't listen");
    expect("tailnetServer" in s).toBe(false);
  } finally { s.server.stop(true); }
});

test("an action's redirect back never leaves the dashboard, even with a // referer", async () => {
  const { d } = setup(false);
  const H = `127.0.0.1:${PORT}`;
  const login = await d.handle(new Request(`http://${H}/login?key=${KEY}`, { headers: { host: H } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const csrf = (await (await d.handle(new Request(`http://${H}/overview`, { headers: { host: H, cookie } }))).text()).match(/name="csrf" value="([^"]+)"/)![1];
  const r = await d.handle(new Request(`http://${H}/action/agent-status`, { method: "POST", body: new URLSearchParams({ csrf, agent: "nobody", status: "paused" }), headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}//evil.example/x`, "content-type": "application/x-www-form-urlencoded" } }));
  expect(r.headers.get("location") ?? "").not.toMatch(/^\/\//);
});

test("a Tailscale login with non-ASCII letters, the same length as the owner's, is a 403, not a 500 (G139)", async () => {
  const { d } = setup();
  const S = `${TN.name}:${SERVE_PORT}`;
  const odd = "é".repeat(TN.login.length); // same length in characters, longer in bytes
  const r = await d.handle(new Request(`http://127.0.0.1:${PORT}/login?key=${KEY}`, { headers: { host: S, "tailscale-user-login": odd, "x-forwarded-for": PHONE } }));
  expect(r.status).toBe(403);
  // The same goes for the login key and the CSRF token.
  const H = `127.0.0.1:${PORT}`;
  expect((await d.handle(new Request(`http://${H}/login?key=${encodeURIComponent("é".repeat(KEY.length))}`, { headers: { host: H } }))).status).toBe(403);
});

test("doctor's tailnet checks: a funnel on the dashboard's ports, a tunnel rule to 8443, or a login set with the tailnet off are flagged (G141)", async () => {
  const { tailnetDoorChecks } = await import("../src/dashboard/tailnet");
  const serve = (o: unknown) => () => ({ exitCode: 0, stdout: Buffer.from(JSON.stringify(o)) });
  const on = { dashboard_tailnet: true, dashboard_tailnet_login: "robin@example.com", dashboard_tailnet_devices: [PHONE], dashboard_port: 8788 };
  const levels = (xs: { level: string }[]) => xs.map((x) => x.level);
  const door = { TCP: { "8443": { HTTPS: true } }, Web: { "mini.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8788" } } } } };
  expect(levels(tailnetDoorChecks(on, [], serve({ ...door, AllowFunnel: { "mini.tail1234.ts.net:443": true } })))).toEqual(["ok"]);
  const funnel = tailnetDoorChecks(on, [], serve({ AllowFunnel: { "mini.tail1234.ts.net:8443": true } }));
  expect(levels(funnel)).toContain("FAIL");
  expect(funnel.find((f) => f.level === "FAIL")).toMatchObject({ id: "doctor.tailnet-funnel", vars: { port: "8443" } });
  expect(levels(tailnetDoorChecks(on, [], serve({ AllowFunnel: { "mini.tail1234.ts.net:8788": true } })))).toContain("FAIL");
  expect(levels(tailnetDoorChecks(on, [{ service: "https://mini.tail1234.ts.net:8443" }], serve({})))).toContain("FAIL");
  expect(levels(tailnetDoorChecks({ dashboard_tailnet_login: "robin@example.com" }, [], serve({})))).toEqual(["warn"]);
  // Tailscale's CLI missing: nothing to say about serve, no failure.
  expect(levels(tailnetDoorChecks(on, [], () => ({ exitCode: 1, stdout: Buffer.from("") })))).toEqual(["warn"]);
  expect(tailnetDoorChecks({}, [], serve({}))).toEqual([]);
});

test("only the owner's listed devices get in: another machine on the same Tailscale account is refused on both paths, and none listed lets none in", async () => {
  const { d, tn } = setup();
  expect((await tn(`/login?key=${KEY}`, { peer: BOX })).status).toBe(403);
  expect(await (await tn(`/login?key=${KEY}`, { peer: BOX })).text()).toContain("pocketbrain dashboard tailnet on --device");
  expect((await tn(`/login?key=${KEY}`, { peer: `::ffff:${PHONE}` })).status).toBe(303);
  const S = `${TN.name}:${SERVE_PORT}`;
  const serve = (from: string) => d.handle(new Request(`http://127.0.0.1:${PORT}/login?key=${KEY}`, { headers: { host: S, "tailscale-user-login": TN.login, "x-forwarded-for": from } }));
  expect((await serve(BOX)).status).toBe(403);
  expect((await serve(`${PHONE}, ${BOX}`)).status).toBe(403);
  expect((await serve(PHONE)).status).toBe(303);
  // The list empty or missing: the tailnet door is on but opens for no device.
  for (const devices of [[], undefined]) {
    const none = dashboardHandler(makeBrain(), { port: PORT, loginKey: KEY });
    none.setTailnet({ ...TN, devices }, PORT);
    expect((await none.handleTailnet(new Request(`http://${TN.name}:${PORT}/login?key=${KEY}`, { headers: { host: `${TN.name}:${PORT}` } }), PHONE)).status).toBe(403);
    expect((await none.handle(new Request(`http://127.0.0.1:${PORT}/login?key=${KEY}`, { headers: { host: S, "tailscale-user-login": TN.login, "x-forwarded-for": PHONE } }))).status).toBe(403);
  }
  // doctor says so.
  const { tailnetDoorChecks } = await import("../src/dashboard/tailnet");
  const ok = () => ({ exitCode: 0, stdout: Buffer.from("{}") });
  expect(tailnetDoorChecks({ dashboard_tailnet: true }, [], ok)).toContainEqual({ level: "warn", id: "doctor.tailnet-no-devices" });
  expect(tailnetDoorChecks({ dashboard_tailnet: true, dashboard_tailnet_devices: [PHONE] }, [], ok).map((f) => f.level)).toEqual(["ok"]);
});

test("the owner turns it on with one command, without a hub.yaml: policy.yaml on a single machine, hub.yaml once there is one; idempotent, devices checked", async () => {
  const { setDashboardTailnet, OwnerSetError } = await import("../src/ownerset");
  const { tailnetSettings } = await import("../src/dashboard/tailnet");
  const { readFileSync, existsSync } = await import("node:fs");
  const root = makeBrain();
  expect(existsSync(join(root, "rules/hub.yaml"))).toBe(false);
  expect(tailnetSettings(root).dashboard_tailnet).toBeFalsy();
  expect(setDashboardTailnet(root, true, [PHONE])).toContain("rules/policy.yaml");
  expect(tailnetSettings(root)).toMatchObject({ dashboard_tailnet: true, dashboard_tailnet_devices: [PHONE] });
  expect(readFileSync(join(root, "rules/policy.yaml"), "utf8")).toContain(`dashboard_tailnet_devices:\n  - ${PHONE}`);
  expect(setDashboardTailnet(root, true, [PHONE])).toContain("already has");
  // A second device adds to the list; off keeps the list for next time.
  setDashboardTailnet(root, true, [BOX]);
  expect(tailnetSettings(root).dashboard_tailnet_devices).toEqual([PHONE, BOX]);
  setDashboardTailnet(root, false);
  expect(tailnetSettings(root)).toMatchObject({ dashboard_tailnet: false, dashboard_tailnet_devices: [PHONE, BOX] });
  for (const bad of [["192.168.1.5"], ["100.64.0.999"], ["louiss-mac-mini"], []]) expect(() => setDashboardTailnet(makeBrain(), true, bad)).toThrow(OwnerSetError);
  // With a hub.yaml, the settings live there, as the other hub settings do.
  const h = makeBrain();
  writeFileSync(join(h, "rules/hub.yaml"), "hub: mini\nepoch: 1\nreplicas: {}\n");
  Bun.spawnSync(["git", "config", "--local", "pocketbrain.replica", "mini"], { cwd: h });
  expect(setDashboardTailnet(h, true, [PHONE])).toContain("rules/hub.yaml");
  expect(tailnetSettings(h)).toMatchObject({ dashboard_tailnet: true, dashboard_tailnet_devices: [PHONE] });
  // The CLI.
  const r = Bun.spawnSync(["bun", "src/cli.ts", "dashboard", "tailnet", "on", "--device", PHONE], { cwd: join(import.meta.dir, ".."), env: { ...process.env, PB_BRAIN: makeBrain() } });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toContain("dashboard_tailnet");
});

test("the sign-in cookie lasts 30 days, so it survives closing Safari or a home-screen icon, as the hub keeps the sign-in", async () => {
  const { tn } = setup();
  const cookie = (await tn(`/login?key=${KEY}`)).headers.get("set-cookie")!;
  expect(cookie).toMatch(/Max-Age=2592000/);
});

test("the https door the phone app needs: a login set with nothing served on 8443 fails doctor and the probe (G629)", async () => {
  const { tailnetDoorChecks, serveDoorProblem } = await import("../src/dashboard/tailnet");
  const serve = (o: unknown) => () => ({ exitCode: 0, stdout: Buffer.from(JSON.stringify(o)) });
  const on = { dashboard_tailnet: true, dashboard_tailnet_login: "robin@example.com", dashboard_tailnet_devices: [PHONE], dashboard_port: 8788 };
  const door = { TCP: { "8443": { HTTPS: true } }, Web: { "mini.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8788" } } } } };
  // What the Mac showed on 2026-11-02: "No serve config" is `{}` in JSON.
  const none = tailnetDoorChecks(on, [], serve({}));
  expect(none.find((f) => f.level === "FAIL")).toMatchObject({ id: "doctor.tailnet-no-serve", vars: { port: "8788" } });
  expect(serveDoorProblem(on, serve({}))).toContain("8443");
  // 8443 served, but to another port than the dashboard's.
  const elsewhere = { ...door, Web: { "mini.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } };
  expect(tailnetDoorChecks(on, [], serve(elsewhere)).map((f) => f.level)).toContain("FAIL");
  expect(serveDoorProblem(on, serve(door))).toBeUndefined();
  // No login set: the https path is off by choice, so nothing to check.
  const noLogin = { dashboard_tailnet: true, dashboard_tailnet_devices: [PHONE] };
  expect(serveDoorProblem(noLogin, serve({}))).toBeUndefined();
  expect(tailnetDoorChecks(noLogin, [], serve({})).map((f) => f.level)).toEqual(["ok"]);
  // Tailscale's CLI not answering: unknown, not a failure.
  expect(serveDoorProblem(on, () => ({ exitCode: 1, stdout: Buffer.from("") }))).toBeUndefined();
});
