// SPDX-License-Identifier: AGPL-3.0-only
// The app's two calls to the hub (docs/phone-app.md): pair once, then make a sign-in fresh with
// the device key after Face ID. The sign-in cookie comes back as Set-Cookie and lands in the
// phone's shared cookie store, which the web view uses. `fetch` is passed in so tests run without
// a phone. The device key is never logged or shown.

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; credentials: "include" }) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export type Paired = { device: string } | { error: string; status: number };

const post = (f: Fetch, url: string, body: object) =>
  f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "include" });

export async function pair(f: Fetch, hub: string, key: string, name: string): Promise<Paired> {
  const r = await post(f, `${hub}/app/pair`, { key, name });
  if (r.status !== 200) return { error: (await r.text()).split("\n")[0] || "The hub said no.", status: r.status };
  const b = await r.json() as { device?: unknown };
  return typeof b.device === "string" ? { device: b.device } : { error: "The hub's answer had no phone key.", status: 502 };
}

/** "fresh": signed in within the last minutes now; "unpaired": pair again; "wait": too many tries this hour; "offline": hub unreachable. */
export async function fresh(f: Fetch, hub: string, device: string): Promise<"fresh" | "unpaired" | "wait" | "offline"> {
  try {
    const r = await post(f, `${hub}/app/fresh`, { device });
    return r.status === 200 ? "fresh" : r.status === 429 ? "wait" : r.status === 401 ? "unpaired" : "offline";
  } catch { return "offline"; }
}
