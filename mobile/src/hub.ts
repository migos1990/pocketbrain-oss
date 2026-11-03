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

/** "fresh": signed in within the last minutes now; "unpaired": pair again (the phone was removed, or its 30-day sign-in ended); "wait": too many tries this hour; "refused": the hub said no (an old or spent nonce), try again; "offline": hub unreachable. */
export async function fresh(f: Fetch, hub: string, device: string): Promise<"fresh" | "unpaired" | "wait" | "refused" | "offline"> {
  const said = (status: number) => status === 200 ? "fresh" : status === 429 ? "wait" : status === 401 ? "unpaired" : status === 403 ? "refused" : "offline";
  try {
    const n = await post(f, `${hub}/app/nonce`, {});
    if (n.status !== 200) return said(n.status);
    const { nonce } = await n.json() as { nonce?: unknown };
    if (typeof nonce !== "string") return "offline";
    return said((await post(f, `${hub}/app/fresh`, { device, nonce })).status);
  } catch { return "offline"; }
}
