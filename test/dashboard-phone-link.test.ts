// SPDX-License-Identifier: AGPL-3.0-only
// Signing in from the phone (owner, 2026-10-24: the link sent the day before was dead after a hub
// restart, and the signed-out page offered only a Mac command). A phone link is one-time, lasts a
// day, survives restarts, and works only from the owner's listed devices on the tailnet. The
// tailnet's signed-out page has a button that texts a fresh one to the owner over a channel that
// reaches his own phone directly, never through an assistant.
import { test, expect } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { dashboardHandler, mintPhoneLink } from "../src/dashboard/server";
import { fakeSent } from "../src/textline/transport";

const PORT = 8788;
const PHONE = "100.88.1.2";
const TN = { address: "100.101.102.103", name: "mini.tail1234.ts.net", login: "robin@example.com", devices: [PHONE] };
const H = `${TN.name}:${PORT}`;

function hub(root: string) {
  const d = dashboardHandler(root, { port: PORT }); // a new login key each start, as on the Mac
  d.setTailnet(TN, PORT);
  const tn = (path: string, o: { method?: string; origin?: string; peer?: string; cookie?: string; form?: Record<string, string> } = {}) =>
    d.handleTailnet(new Request(`http://${H}${path}`, { method: o.method ?? "GET", body: o.form ? new URLSearchParams(o.form) : undefined, headers: { host: H, ...(o.origin ? { origin: o.origin } : {}), ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.form ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }), o.peer ?? PHONE);
  const local = (path: string) => d.handle(new Request(`http://127.0.0.1:${PORT}${path}`, { headers: { host: `127.0.0.1:${PORT}` } }));
  // Opening a texted link shows a Sign in button; the tap (a same-origin POST) spends the link.
  const signIn = async (token: string, peer?: string) => {
    const open = await tn(`/login?key=${token}`, { peer });
    if (open.status !== 200) return open;
    return tn("/login", { method: "POST", origin: `http://${H}`, form: { key: token }, peer });
  };
  return { d, tn, local, signIn };
}
const transport = (root: string, use: string, trusted = true) =>
  writeFileSync(join(root, "rules", "escalation.yaml"), `transport:\n  use: ${use}\n${use === "fake" ? `  fake: { trusted: ${trusted} }\n` : ""}`);

test("a phone link outlives a hub restart, works once, and only on the tailnet", async () => {
  const root = makeBrain();
  const token = mintPhoneLink(root);
  const after = hub(root); // the hub restarted: new login key, same brain
  expect((await after.local(`/login?key=${token}`)).status).toBe(403); // never on loopback
  const ok = await after.signIn(token);
  expect(ok.status).toBe(303);
  expect(ok.headers.get("set-cookie")).toContain("Max-Age=2592000");
  expect((await after.signIn(token)).status).toBe(403); // used up
  const old = mintPhoneLink(root, new Date(Date.now() - 25 * 3_600_000));
  expect((await after.signIn(old)).status).toBe(403); // a day old
});

test("signed out on the phone: a button texts a fresh link to the owner's own phone", async () => {
  const root = makeBrain();
  transport(root, "fake", true);
  const { tn, signIn } = hub(root);
  const out = await tn("/overview");
  expect(out.status).toBe(401);
  const page = await out.text();
  expect(page).toContain("Text me a sign-in link");
  expect(page).not.toContain("menubar open-dashboard");
  const sent = await tn("/send-link", { method: "POST", origin: `http://${H}` });
  expect(sent.status).toBe(200);
  expect(await sent.text()).toContain("Sent");
  const text = fakeSent(root).at(-1)!.text;
  const link = text.match(/http:\/\/mini\.tail1234\.ts\.net:8788\/login\?key=[A-Za-z0-9_-]+/)![0];
  expect((await signIn(link.slice(link.indexOf("key=") + 4))).status).toBe(303);
  // From another site: refused. More than 3 an hour: refused.
  expect((await tn("/send-link", { method: "POST", origin: "http://evil.example" })).status).toBe(403);
  for (let i = 0; i < 2; i++) expect((await tn("/send-link", { method: "POST", origin: `http://${H}` })).status).toBe(200);
  expect((await tn("/send-link", { method: "POST", origin: `http://${H}` })).status).toBe(429);
});

test("a text channel that goes through an assistant never carries a sign-in link", async () => {
  const root = makeBrain();
  transport(root, "fake", false);
  const { tn } = hub(root);
  const r = await tn("/send-link", { method: "POST", origin: `http://${H}` });
  expect(r.status).toBe(409);
  expect(await r.text()).toContain("pocketbrain dashboard phone-link");
  expect(fakeSent(root)).toHaveLength(0);
});

// Slice audit of the first version (G378, G379), and the gates it found untested.
test("parallel or failed sends still stop at 3 an hour", async () => {
  const root = makeBrain();
  transport(root, "fake", true);
  const { tn } = hub(root);
  const all = await Promise.all(Array.from({ length: 5 }, () => tn("/send-link", { method: "POST", origin: `http://${H}` })));
  expect(all.filter((r) => r.status === 200)).toHaveLength(3);
  expect(fakeSent(root)).toHaveLength(3);
  const root2 = makeBrain();
  transport(root2, "fake", false); // refused sends count too
  const h2 = hub(root2);
  for (let i = 0; i < 3; i++) expect((await h2.tn("/send-link", { method: "POST", origin: `http://${H}` })).status).toBe(409);
  expect((await h2.tn("/send-link", { method: "POST", origin: `http://${H}` })).status).toBe(429);
});

test("a used link never comes back, and the file holds only hashes, owner-only", async () => {
  const root = makeBrain();
  const a = mintPhoneLink(root);
  const { signIn } = hub(root);
  expect((await signIn(a)).status).toBe(303);
  mintPhoneLink(root); // another process minting after the use doesn't revive it
  expect((await signIn(a)).status).toBe(403);
  const f = join(root, ".git", "pb-phone-links.json");
  expect(readFileSync(f, "utf8")).not.toContain(a);
  expect(statSync(f).mode & 0o777).toBe(0o600);
});

test("no Origin, or a device that isn't listed: nothing is sent and no link signs in", async () => {
  const root = makeBrain();
  transport(root, "fake", true);
  const { tn, signIn } = hub(root);
  expect((await tn("/send-link", { method: "POST" })).status).toBe(403);
  const link = mintPhoneLink(root);
  expect((await signIn(link, "100.88.9.9")).status).toBe(403);
  expect((await tn("/login", { method: "POST", origin: `http://${H}`, form: { key: link }, peer: "100.88.9.9" })).status).toBe(403);
  expect((await tn("/send-link", { method: "POST", origin: `http://${H}`, peer: "100.88.9.9" })).status).toBe(403);
  expect(fakeSent(root)).toHaveLength(0);
  expect((await signIn(link)).status).toBe(303); // still good from the phone
});

// Owner, 2026-10-24 ("it doesn't work"): a link opened by a message preview or a second tap was
// already spent, and a restart looked like a sign-out. Opening a link spends nothing; the button does.
test("opening a texted link spends nothing: a preview fetch leaves it good for the real tap", async () => {
  const root = makeBrain();
  const token = mintPhoneLink(root);
  const { tn, signIn } = hub(root);
  for (let i = 0; i < 2; i++) {
    const open = await tn(`/login?key=${token}`); // what a link preview does
    expect(open.status).toBe(200);
    expect(open.headers.get("set-cookie")).toBeNull();
    const page = await open.text();
    expect(page).toContain("Sign in");
    expect(page).toContain('method="post"');
  }
  expect((await signIn(token)).status).toBe(303);
  // The tap must come from the dashboard's own page: no Origin, or another site's, spends nothing.
  const t2 = mintPhoneLink(root);
  expect((await tn("/login", { method: "POST", form: { key: t2 } })).status).toBe(403);
  expect((await tn("/login", { method: "POST", origin: "http://evil.example", form: { key: t2 } })).status).toBe(403);
  expect((await signIn(t2)).status).toBe(303);
});

test("a phone sign-in survives a hub restart, and reopening a spent link while signed in goes home", async () => {
  const root = makeBrain();
  const token = mintPhoneLink(root);
  const first = hub(root);
  const r = await first.signIn(token);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  expect((await first.tn("/", { cookie })).status).toBe(200);
  const after = hub(root); // restarted
  expect((await after.tn("/", { cookie })).status).toBe(200);
  const again = await after.tn(`/login?key=${token}`, { cookie }); // the old text, tapped again
  expect(again.status).toBe(303);
  expect(again.headers.get("location")).toBe("/");
});

test("a used or old link on the phone says so in plain words, with the button for a new one", async () => {
  const root = makeBrain();
  const token = mintPhoneLink(root);
  const { tn, signIn } = hub(root);
  expect((await signIn(token)).status).toBe(303);
  for (const r of [await tn(`/login?key=${token}`), await tn("/login", { method: "POST", origin: `http://${H}`, form: { key: token } })]) {
    expect(r.status).toBe(403);
    const page = await r.text();
    expect(page).toContain("already used");
    expect(page).toContain('action="/send-link"');
    expect(page).not.toContain("pocketbrain ");
  }
});

test("the Terminal's phone link is the https address the app accepts when tailscale serve is set up", async () => {
  const { phoneLinkUrl } = await import("../src/dashboard/tailnet");
  // The owner's Tailscale login set: `tailscale serve` on 8443 is the door the phone app pairs through.
  expect(phoneLinkUrl({ address: TN.address, name: TN.name }, TN.login, "k".repeat(32), PORT)).toBe(`https://${TN.name}:8443/login?key=${"k".repeat(32)}`);
  // No login set, or no MagicDNS name: the tailnet listener's plain address, as before.
  expect(phoneLinkUrl({ address: TN.address, name: TN.name }, undefined, "k".repeat(32), PORT)).toBe(`http://${TN.name}:${PORT}/login?key=${"k".repeat(32)}`);
  expect(phoneLinkUrl({ address: TN.address }, TN.login, "k".repeat(32), PORT)).toBe(`http://${TN.address}:${PORT}/login?key=${"k".repeat(32)}`);
});
