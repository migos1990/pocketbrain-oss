// SPDX-License-Identifier: AGPL-3.0-only
// The assistant's page, from the re-recorded identity demo (2026-11-15). One number, one meaning:
// the budget's hourly count takes saves and asks (ask_to_see spends from it), so it is not called
// "writes", the word the page uses for facts written to the memory (G903). An assistant whose
// sign-in the owner approved has connected: the page says when, never "Hasn't connected yet" (G904).
import { test, expect, afterAll } from "bun:test";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { loadState } from "../src/dashboard/data";
import { agentPage } from "../src/dashboard/html";
import { setupOAuth, bindClient, clearJwksCache } from "../src/oauth";
import { addAgent } from "../src/addagent";
import { markServing, spend } from "../src/budget";
import { startFakeAS, connect } from "./fake-as";

const as = startFakeAS("user_owner");
afterAll(() => as.stop());
const RESOURCE = "https://brain.test/mcp/oauth";
const plain = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&#39;/g, "'");

test("the budget line names what it counts: saves and asks, never writes", () => {
  const root = makeBrain();
  markServing(root);
  spend(root, "planner", "write", Date.now()); // what one ask_to_see spends
  const t = plain(agentPage(loadState(root), "c", "planner")!.body);
  expect(t).toContain("1 of 300 saves and asks in the last hour");
  expect(t).not.toContain("writes in the last hour");
});

test("an approved sign-in has connected: the page says when, and that it has read nothing yet", async () => {
  clearJwksCache();
  const root = makeBrain();
  setupOAuth(root, { issuer: as.issuer, resource: RESOURCE, owner_subject: "user_owner" });
  const call = (path: string, init: RequestInit = {}) => handle(root, new Request("https://brain.test" + path, init));
  const nb = await connect(call, RESOURCE, { dcr: { client_name: "Notebook", redirect_uri: "https://agent.example/cb" } });
  addAgent(root, { agent: "notebook", slices: ["contacts-basic"] });
  // Added, no sign-in yet: nothing has connected.
  let t = plain(agentPage(loadState(root), "c", "notebook")!.body);
  expect(t).toContain("Hasn't connected yet.");
  bindClient(root, nb.client_id, "notebook");
  const s = loadState(root);
  t = plain(agentPage(s, "c", "notebook")!.body);
  expect(t).not.toContain("Hasn't connected yet");
  expect(t).toContain("Signed in today; it has read nothing yet.");
  expect(agentPage(s, "c", "notebook")!.body).toContain("<dt>Last seen</dt><dd>signed in today, no read yet</dd>");
});
