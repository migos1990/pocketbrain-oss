// SPDX-License-Identifier: AGPL-3.0-only
// The app's calls to the hub (docs/phone-app.md): pair once, then make its own sign-in fresh with
// the device key after Face ID, spending a one-time nonce the hub gives that sign-in first. The sign-in cookie comes back as Set-Cookie and lands in the
// phone's shared cookie store, which the web view uses. `fetch` is passed in so tests run without
// a phone. The device key is never logged or shown.

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; credentials: "include" }) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export type Paired = { device: string } | { error: string; status: number };

// The hub takes Face ID only from the app's own request: this header and no Origin (audit v11, G642).
const post = (f: Fetch, url: string, body: object) =>
  f(url, { method: "POST", headers: { "content-type": "application/json", "x-pocketbrain-app": "1" }, body: JSON.stringify(body), credentials: "include" });

export async function pair(f: Fetch, hub: string, key: string, name: string): Promise<Paired> {
  const r = await post(f, `${hub}/app/pair`, { key, name });
  if (r.status !== 200) return { error: (await r.text()).split("\n")[0] || "The hub said no.", status: r.status };
  const b = await r.json() as { device?: unknown };
  return typeof b.device === "string" ? { device: b.device } : { error: "The hub's answer had no phone key.", status: 502 };
}

/** "fresh": signed in within the last minutes now; "unpaired": pair again (the phone was removed, or its 30-day sign-in ended); "wait": too many tries this hour; "refused": the hub said no (an old or spent nonce), try again; "offline": the hub didn't answer, twice; { error }: the hub answered something else, said with its status (G651). */
export type Fresh = "fresh" | "unpaired" | "wait" | "refused" | "offline" | { error: number };
export async function fresh(f: Fetch, hub: string, device: string): Promise<Fresh> {
  const said = (status: number): Fresh => status === 200 ? "fresh" : status === 429 ? "wait" : status === 401 ? "unpaired" : status === 403 ? "refused" : { error: status };
  const once = async (): Promise<Fresh> => {
    const n = await post(f, `${hub}/app/nonce`, {});
    if (n.status !== 200) return said(n.status);
    const { nonce } = await n.json() as { nonce?: unknown };
    if (typeof nonce !== "string") return { error: 502 };
    return said((await post(f, `${hub}/app/fresh`, { device, nonce })).status);
  };
  // A call dropped right after Face ID (the app coming back to the front, the network waking) is
  // tried once more before the app blames the connection.
  try { return await once(); } catch { /* once more */ }
  try { return await once(); } catch { return "offline"; }
}

/** What the app says after Face ID, in words: nothing when the sign-in is fresh. */
export function freshWords(r: Fresh): string {
  if (r === "fresh") return "";
  if (r === "unpaired") return "This phone needs a new sign-in: it was removed, or its 30 days ended. Open a new sign-in link to pair it again.";
  if (r === "wait") return "Too many tries this hour. Try again later.";
  if (r === "refused") return "Your hub didn't take that Face ID sign-in. Try again.";
  if (r === "offline") return "Couldn't reach your hub. Is Tailscale on?";
  // No such door: the hub runs code from before this app's Face ID (G642 ships hub and app together).
  if (r.error === 404) return "Your hub needs the update that goes with this app.";
  return `Your hub answered ${r.error} to Face ID. Try again.`;
}

/** A page that loads says the hub answered: the last message about reaching it, or Face ID, goes (G651: it stayed on every page after). */
export const pageClears = (event: string) => event === "ready" || event === "blank";
