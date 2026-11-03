// SPDX-License-Identifier: AGPL-3.0-only
// The phone app's paired phones (docs/phone-app.md). A phone pairs once with a phone link and gets
// a device key it keeps behind Face ID; the hub keeps only the key's hash, the name the app gave,
// when it paired, when it last made a sign-in fresh, and the hashes of the sign-ins it made, so
// removing the phone ends them. Kept in .git/ beside the sign-ins (never in the brain's notes),
// written whole and renamed into place at 0600, under a lock the CLI and the hub share.
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { withFileLock } from "../filelock";

export const APP_PHONES_MAX = 5;
// As many as the dashboard keeps at all (server.ts keeps the newest 20), so a remove ends every one.
const SIGN_INS_KEPT = 20;
interface Phone { name: string; at: string; last?: string; sids: string[]; fresh?: string[] }
type Phones = Record<string, Phone>; // key hash -> phone
const phonesFile = (root: string) => join(root, ".git", "pb-app-phones.json");
// The dashboard's kept sign-ins (server.ts reads and writes it): by the hash of the cookie.
export const sessionFile = (root: string) => join(root, ".git", "pb-dashboard-sessions.json");
/** Ends kept sign-ins by their hashes; a running hub forgets them at its next restart or Sign in again. */
export function endSignIns(root: string, sidHashes: string[]) {
  if (!sidHashes.length) return;
  try {
    const all = JSON.parse(readFileSync(sessionFile(root), "utf8")) as Record<string, unknown>;
    for (const h of sidHashes) delete all[h];
    writeFileSync(sessionFile(root), JSON.stringify(all), { mode: 0o600 });
  } catch { /* no kept sign-ins: nothing to end */ }
}
export const keyHash = (key: string) => createHash("sha256").update(key).digest("hex");

function load(root: string): Phones {
  try {
    const all = JSON.parse(readFileSync(phonesFile(root), "utf8")) as Phones;
    return Object.fromEntries(Object.entries(all).filter(([h, p]) => /^[0-9a-f]{64}$/.test(h) && typeof p?.name === "string" && typeof p.at === "string" && Array.isArray(p.sids)));
  } catch { return {}; }
}
function save(root: string, phones: Phones) {
  const tmp = `${phonesFile(root)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(phones), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, phonesFile(root));
}
function locked<T>(root: string, f: (phones: Phones) => T): T {
  if (!existsSync(join(root, ".git"))) throw new Error("the phone app needs the brain's git folder");
  let out: T | undefined, done = false;
  withFileLock(root, "app-phones", () => { const p = load(root); out = f(p); save(root, p); done = true; return true; });
  if (!done) throw new Error("another phone is being paired or removed right now; try again");
  return out as T;
}

// The name a phone shows under: what the app sent, cut to plain characters, "phone" if none.
export const phoneName = (raw: unknown) => (typeof raw === "string" ? raw.replace(/[^\p{L}\p{N} '’._-]/gu, "").trim().slice(0, 40) : "") || "phone";

/** A newly paired phone; the oldest goes past APP_PHONES_MAX. Returns the hashes of the sign-ins that ended with a dropped phone. */
export function addAppPhone(root: string, key: string, name: string, sidHash: string, now: Date): string[] {
  return locked(root, (phones) => {
    phones[keyHash(key)] = { name, at: now.toISOString(), sids: [sidHash] };
    const order = Object.entries(phones).sort((a, b) => b[1].at.localeCompare(a[1].at));
    const dropped = order.slice(APP_PHONES_MAX);
    for (const [h] of dropped) delete phones[h];
    return dropped.flatMap(([, p]) => p.sids);
  });
}

// Fresh sign-ins one phone makes in an hour before it waits (audit v11, G642): Face ID is a person
// at the phone, so a key used more often than that is not one.
export const APP_FRESH_PER_HOUR = 12;
/** A paired phone's key, and one of the live sign-ins that phone made: "ok" and the time is
 * recorded. Never a sign-in the phone didn't make, and never a new one (audit v11, G642: the key
 * alone made any cookie, or none, a fresh owner sign-in). */
export function useAppPhone(root: string, key: string, sidHash: string, now: Date): "ok" | "unknown" | "not-its-sign-in" | "cap" {
  if (!key) return "unknown";
  return locked(root, (phones) => {
    const p = phones[keyHash(key)];
    if (!p) return "unknown";
    if (!p.sids.includes(sidHash)) return "not-its-sign-in";
    const t = now.getTime();
    p.fresh = (p.fresh ?? []).filter((at) => t - Date.parse(at) < 3_600_000);
    if (p.fresh.length >= APP_FRESH_PER_HOUR) return "cap";
    p.fresh.push(now.toISOString());
    p.last = now.toISOString();
    return "ok";
  });
}

/** The paired phones, newest first: name, when paired, when last made fresh. Never a key or hash. */
export function appPhones(root: string): { name: string; at: string; last?: string }[] {
  return Object.values(load(root)).sort((a, b) => b.at.localeCompare(a.at)).map((p) => ({ name: p.name, at: p.at, ...(p.last ? { last: p.last } : {}) }));
}

/** Removes the phones with this name ("all" for every one); returns their names. Their sign-ins end with them. */
export function removeAppPhones(root: string, which: string, end: (sidHashes: string[]) => void = (h) => endSignIns(root, h)): string[] {
  if (!existsSync(phonesFile(root))) return [];
  const gone = locked(root, (phones) => {
    const hit = Object.entries(phones).filter(([, p]) => which === "all" || p.name === which);
    for (const [h] of hit) delete phones[h];
    return hit.map(([, p]) => p);
  });
  end(gone.flatMap((p) => p.sids));
  return gone.map((p) => p.name);
}
