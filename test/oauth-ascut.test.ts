// SPDX-License-Identifier: AGPL-3.0-only
// Revoke reaches the authorization server: with a management client set, revoking an agent also
// deletes its OAuth clients at the AS (Auth0's Management API shape), so the assistant shows the
// connection as gone. Without one, or when the AS fails, the local cut still holds.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { setupOAuth, bindClient, loadOAuth, setManagement, clientsOf, cutAtAuthServer } from "../src/oauth";
import { revokeTokens } from "../src/auth";

let server: ReturnType<typeof Bun.serve>;
let base = "";
const deleted: string[] = [];
const tokenCalls: Record<string, unknown>[] = [];
let failToken = false;

beforeAll(() => {
  server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/oauth/token" && req.method === "POST") {
        const b = (await req.json()) as Record<string, unknown>;
        tokenCalls.push(b);
        if (failToken || b.client_secret !== "s3cret") return new Response("no", { status: 401 });
        return Response.json({ access_token: "mgmt-token", token_type: "Bearer" });
      }
      const m = u.pathname.match(/^\/api\/v2\/clients\/(.+)$/);
      if (m && req.method === "DELETE") {
        if (req.headers.get("authorization") !== "Bearer mgmt-token") return new Response("no", { status: 401 });
        const id = decodeURIComponent(m[1]);
        if (id === "gone") return new Response("", { status: 404 });
        deleted.push(id);
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}/`;
});
afterAll(() => { server.stop(true); delete process.env.AUTH0_MGMT_CLIENT_SECRET; });

function door() {
  const root = makeBrain();
  setupOAuth(root, { issuer: base, resource: "http://127.0.0.1:1/mcp/oauth", owner_subject: "auth0|owner" });
  return root;
}

test("without a management client the cut is local only and says why", async () => {
  const root = door();
  bindClient(root, "c-1", "helper");
  const ids = clientsOf(root, "helper");
  revokeTokens(root, "helper");
  const r = await cutAtAuthServer(root, ids);
  expect(r.skipped).toContain("no management client");
  expect(loadOAuth(root)!.revoked).toContain("c-1");
});

test("revoking an agent deletes each of its clients at the AS, and the secret never lands in rules", async () => {
  const root = door();
  bindClient(root, "c-a", "helper");
  bindClient(root, "c-b", "helper", undefined, { keepOld: true });
  bindClient(root, "c-p", "planner");
  setManagement(root, "m2m-1");
  process.env.AUTH0_MGMT_CLIENT_SECRET = "s3cret";
  const ids = clientsOf(root, "helper");
  revokeTokens(root, "helper");
  const r = await cutAtAuthServer(root, ids);
  expect(r.deleted.sort()).toEqual(["c-a", "c-b"]);
  expect(deleted).toContain("c-a");
  expect(deleted).not.toContain("c-p");
  expect(tokenCalls.at(-1)).toMatchObject({ grant_type: "client_credentials", client_id: "m2m-1", audience: `${base}api/v2/` });
  expect(readFileSync(join(root, "rules", "oauth.yaml"), "utf8")).not.toContain("s3cret");
  const log = JSON.parse(readFileSync(join(root, ".oauth", "as-cuts.json"), "utf8"));
  expect(log.at(-1).deleted.length).toBe(2);
});

test("a client already gone at the AS counts as deleted", async () => {
  const root = door();
  setManagement(root, "m2m-1");
  process.env.AUTH0_MGMT_CLIENT_SECRET = "s3cret";
  expect((await cutAtAuthServer(root, ["gone"])).deleted).toEqual(["gone"]);
});

test("when the AS refuses, the failure is logged and the client stays refused here", async () => {
  const root = door();
  bindClient(root, "c-x", "helper");
  setManagement(root, "m2m-1");
  process.env.AUTH0_MGMT_CLIENT_SECRET = "s3cret";
  failToken = true;
  const ids = clientsOf(root, "helper");
  revokeTokens(root, "helper");
  const r = await cutAtAuthServer(root, ids);
  failToken = false;
  expect(r.deleted).toEqual([]);
  expect(r.failed[0]).toMatchObject({ client_id: "c-x" });
  expect(loadOAuth(root)!.revoked).toContain("c-x");
  expect(existsSync(join(root, ".oauth", "as-cuts.json"))).toBe(true);
});
