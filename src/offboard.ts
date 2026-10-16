// SPDX-License-Identifier: AGPL-3.0-only
// Offboarding follows the sign-in service. When the owner has a management client
// (`pocketbrain oauth management`, docs/oauth.md), the hub asks the authorization server every
// coworker_check_s (default 30) whether each coworker's account is still active. Blocked or
// deleted there means refused here on the next request, even while the coworker's access token
// is still valid; unblocked means let back in. The first time a coworker is found blocked or
// deleted, the owner gets an alert. If the check can't be made for longer than
// coworker_max_age_s (default 600), coworkers are refused until it can (fail closed). Without a
// management client, nothing changes: coworkers are cut only by the owner's own levers.
import { loadOAuth, managementToken, asBase, type OAuthConfig } from "./oauth";
import { alert } from "./util";

export type Standing = "active" | "blocked" | "gone" | "unknown";

const state = {
  on: false, maxAgeMs: 600_000,
  subjects: new Map<string, { standing: Exclude<Standing, "unknown">; at: number }>(),
  timer: undefined as ReturnType<typeof setInterval> | undefined, lastError: "",
};

// Called on each coworker request through the OAuth door.
export function coworkerStanding(subject: string): Standing {
  if (!state.on) return "active";
  const e = state.subjects.get(subject);
  if (!e || Date.now() - e.at > state.maxAgeMs) return "unknown";
  return e.standing;
}

export function offboardingStatus() {
  return { on: state.on, last_error: state.lastError, coworkers: [...state.subjects].map(([s, e]) => ({ subject: s, standing: e.standing, age_s: Math.round((Date.now() - e.at) / 1000) })) };
}

export async function checkCoworkers(root: string, fetchFn: typeof fetch = fetch) {
  const c = loadOAuth(root);
  const secret = process.env.AUTH0_MGMT_CLIENT_SECRET;
  if (!c?.management_client_id || !secret) return;
  const coworkers = Object.entries(c.coworkers ?? {});
  if (!coworkers.length) return;
  let token: string;
  try { token = await managementToken(c, secret, fetchFn); } catch (e) { state.lastError = (e as Error).message; return; }
  for (const [subject, cw] of coworkers) {
    let standing: Exclude<Standing, "unknown">;
    try {
      standing = await lookUp(c, subject, token, fetchFn);
    } catch (e) { state.lastError = (e as Error).message; continue; }
    const before = state.subjects.get(subject)?.standing;
    state.subjects.set(subject, { standing, at: Date.now() });
    state.lastError = "";
    if (standing !== "active" && before !== standing)
      alert(root, { check: "coworker_offboarded", agent: cw.agent, from: `${cw.name}'s account is ${standing === "gone" ? "deleted" : "blocked"} at the sign-in service; their assistants are refused` });
  }
}

export async function lookUp(c: OAuthConfig, subject: string, token: string, fetchFn: typeof fetch): Promise<"active" | "blocked" | "gone"> {
  const r = await fetchFn(new URL(`api/v2/users/${encodeURIComponent(subject)}?fields=user_id,blocked&include_fields=true`, asBase(c)), { headers: { authorization: `Bearer ${token}` } });
  if (r.status === 404) return "gone";
  if (!r.ok) throw new Error(`user lookup: HTTP ${r.status}`);
  return ((await r.json()) as { blocked?: boolean }).blocked ? "blocked" : "active";
}

// The hub turns it on. Returns false when there's no management client or no coworker.
export async function startOffboarding(root: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  const c = loadOAuth(root);
  if (!c?.management_client_id || !process.env.AUTH0_MGMT_CLIENT_SECRET || !Object.keys(c.coworkers ?? {}).length) return false;
  state.on = true;
  state.maxAgeMs = (c.coworker_max_age_s ?? 600) * 1000;
  await checkCoworkers(root, fetchFn);
  state.timer = setInterval(() => void checkCoworkers(root, fetchFn), (c.coworker_check_s ?? 30) * 1000);
  (state.timer as { unref?: () => void }).unref?.();
  return true;
}

export function stopOffboarding() {
  if (state.timer) clearInterval(state.timer);
  state.on = false;
  state.subjects.clear();
  state.timer = undefined;
  state.lastError = "";
}
