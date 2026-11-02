// SPDX-License-Identifier: AGPL-3.0-only
// What the app does with the hub's page in its web view, so it never shows a blank screen
// (owner, 2026-11-02: back from the background, iOS had dropped the page and the app showed only
// paper). Pure, so the hub's test run checks it (test/phone-app-client.test.ts).

export type Phase = "loading" | "shown" | "failed";
export interface PageState { phase: Phase; tries: number; awayAt?: number }
export type PageEvent =
  | { kind: "loaded"; blank: boolean }   // the page's script said whether it drew anything
  | { kind: "error" }                    // the load failed: no network, Tailscale off, hub down
  | { kind: "http"; status: number }     // the hub answered with an error status
  | { kind: "gone" }                     // iOS or Android dropped the page's process
  | { kind: "background"; at: number }
  | { kind: "foreground"; at: number }
  | { kind: "retry" };                   // the owner tapped Try again

export const START: PageState = { phase: "loading", tries: 0 };
// Away this long and the page loads again on return, so it is never stale or dropped.
const STALE_MS = 10 * 60_000;

export function pageStep(s: PageState, e: PageEvent): { state: PageState; reload: boolean } {
  const reload = (tries = 0) => ({ state: { phase: "loading" as const, tries }, reload: true });
  switch (e.kind) {
    case "gone": return reload();
    case "retry": return reload();
    case "error": return { state: { ...s, phase: "failed" }, reload: false };
    // 401 and 403 are the hub's own sign-in pages, which the page script handles.
    case "http": return { state: e.status >= 500 ? { ...s, phase: "failed" } : s, reload: false };
    case "loaded":
      if (!e.blank) return { state: { phase: "shown", tries: 0 }, reload: false };
      return s.tries < 1 ? reload(s.tries + 1) : { state: { ...s, phase: "failed" }, reload: false };
    case "background": return { state: { ...s, awayAt: e.at }, reload: false };
    case "foreground": {
      const away = s.awayAt === undefined ? 0 : e.at - s.awayAt;
      if (s.phase === "failed" || away > STALE_MS) return reload();
      return { state: { phase: s.phase, tries: s.tries }, reload: false };
    }
  }
}
