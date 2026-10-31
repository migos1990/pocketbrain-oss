// SPDX-License-Identifier: AGPL-3.0-only
// After a dashboard action the browser goes back to the page it came from, on this host only:
// a Referer path like //evil.example/x is a protocol-relative URL and must not leave the host
// (backlog #207).
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { dashboardHandler } from "../src/dashboard/server";

const H = "127.0.0.1:8788";

test("an action never redirects off-host, whatever path the Referer carries", async () => {
  const root = makeBrain();
  const d = dashboardHandler(root, { port: 8788, loginKey: "k".repeat(32) });
  const r = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  const page = await d.handle(new Request(`http://${H}/overview`, { headers: { host: H, cookie } }));
  const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)![1];
  const post = (referer: string) => d.handle(new Request(`http://${H}/action/digest`, { method: "POST", body: `csrf=${csrf}`, headers: { host: H, cookie, origin: `http://${H}`, referer, "content-type": "application/x-www-form-urlencoded" } }));
  for (const path of ["//evil.example/x", "/\\evil.example/x", "//evil.example", "/%2F%2Fevil.example"]) {
    const res = await post(`http://${H}${path}`);
    const loc = res.headers.get("location") ?? "";
    expect(res.status, path).toBe(303);
    expect(loc.startsWith("/"), `${path} -> ${loc}`).toBe(true);
    expect(/^\/[/\\]/.test(loc), `${path} -> ${loc}`).toBe(false);
    expect(new URL(loc, `http://${H}`).host, `${path} -> ${loc}`).toBe(H);
  }
  // An ordinary page still comes back to itself.
  const ok = await post(`http://${H}/agents/planner`);
  expect(ok.headers.get("location")!.startsWith("/agents/planner?")).toBe(true);
});
