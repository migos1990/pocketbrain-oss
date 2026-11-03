// SPDX-License-Identifier: AGPL-3.0-only
// What the app does with a phone link (docs/phone-app.md): the link page's
// `pocketbrain://pair?hub=…&key=…` button, or the texted `https://<hub>/login?key=…` link pasted
// in. Pure, so the hub's test run checks it (test/phone-app-client.test.ts).

export type PairLink = { hub: string; key: string } | { error: string };

const KEY = /^[A-Za-z0-9_-]{16,128}$/;

// The hub's https door is `tailscale serve` on this port (SERVE_PORT in src/dashboard/tailnet.ts).
const SERVE_PORT = 8443;

/** The hub's address and the link's key, or one sentence saying what's wrong with it. Takes a
 *  whole pasted text message too: the first sign-in link in it counts. */
export function parsePairLink(raw: string): PairLink {
  const found = raw.match(/(?:pocketbrain:\/\/pair\?|https?:\/\/[^\s/]+\/login\?)[^\s]*/i)?.[0].replace(/[.,;:!?)\]]+$/, "");
  let u: URL;
  try { u = new URL((found ?? raw).trim()); } catch { return { error: "That isn't a sign-in link. Paste the whole link from the text." }; }
  let hub: string, key: string;
  if (u.protocol === "pocketbrain:") {
    hub = u.searchParams.get("hub") ?? "";
    key = u.searchParams.get("key") ?? "";
    try { const h = new URL(hub); hub = h.origin; if (h.protocol !== "https:" && h.protocol !== "http:") return { error: "That link doesn't name your hub." }; }
    catch { return { error: "That link doesn't name your hub." }; }
  } else if ((u.protocol === "https:" || u.protocol === "http:") && u.pathname === "/login") {
    hub = u.origin;
    key = u.searchParams.get("key") ?? "";
  } else return { error: "That isn't a sign-in link. Paste the whole link from the text." };
  if (!KEY.test(key)) return { error: "That link is cut short. Paste the whole link from the text." };
  // A tailnet name's plain address (the tailnet listener) has an https door on SERVE_PORT.
  const plain = new URL(hub);
  if (plain.protocol === "http:" && /\.ts\.net$/i.test(plain.hostname)) hub = `https://${plain.hostname}:${SERVE_PORT}`;
  // Phones refuse plain http to a named host, and the app does too: the hub's https address is
  // `tailscale serve` (docs/dashboard-tailnet.md).
  if (!hub.startsWith("https://")) return { error: "This link is for your hub's plain address. Use its https one: run `tailscale serve` on the hub, then get a new link there." };
  return { hub, key };
}

/** What the app asks before it pairs (audit v11, G647): a link from anyone could pair the app with
 *  their hub, or replace the owner's own pairing, so the owner sees which hub first. */
export function pairQuestion(hub: string, current: string | null): { title: string; body: string } {
  const host = (h: string) => { try { return new URL(h).hostname; } catch { return h; } };
  const replaces = current && current !== hub ? ` This replaces your pairing with ${host(current)}.` : "";
  return { title: `Pair with ${host(hub)}?`, body: `Only pair with your own hub, from a sign-in link you asked for.${replaces}` };
}
