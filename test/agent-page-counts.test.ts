// SPDX-License-Identifier: AGPL-3.0-only
// The assistant's page, from the re-recorded identity demo (2026-11-15). One number, one meaning:
// the budget's hourly count takes saves and asks (ask_to_see spends from it), so it is not called
// "writes", the word the page uses for facts written to the memory (G903). An assistant whose
// sign-in the owner approved has connected: the page says when, never "Hasn't connected yet" (G904).
import { test, expect, afterAll } from "bun:test";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { loadState } from "../src/dashboard/data";
import { agentPage, overview } from "../src/dashboard/html";
import { write } from "../src/write";
import { writeQuality, qualityText } from "../src/writequality";
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

// G955: the page's "N writes so far" counts every write the assistant sent, and the Writes line
// counted only those saved as a fact. An assistant whose writes all wait or were turned down read
// "1 write so far" beside "nothing written in 30 days".
test("writes that were sent and none saved: the Writes line says so, never 'nothing written'", () => {
  const root = makeBrain();
  // A trial assistant proposes: its write is in the log and waits in the inbox.
  const r = write(root, { agent: "helper", id: "projects/course-a", attribute: "room", value: "B-201", as_of: "2026-10-08", sources: ["gmail:f000000000000006"] } as never);
  expect(r.outcome).toBe("inbox");
  const q = writeQuality(root, "helper");
  expect(q).toMatchObject({ sent: 1, writes: 0, judged: 0 });
  expect(qualityText(q)).toBe("1 write sent in 30 days, none saved yet");
  const t = plain(agentPage(loadState(root), "c", "helper")!.body);
  expect(t).toContain("1 write so far");
  expect(t).not.toContain("nothing written");
});

test("some saved, some not: the Writes line gives both numbers", () => {
  const root = makeBrain();
  const w = (attribute: string, value: string, sources: string[]) => write(root, { agent: "planner", id: "projects/course-a", attribute, value, as_of: "2026-10-08", sources, verification: "verified-by-source" } as never);
  expect(w("room", "B-201", ["gmail:f000000000000006"]).outcome).toBe("committed");
  expect(w("hall", "Main", []).outcome).not.toBe("committed"); // no source: turned down
  const q = writeQuality(root, "planner");
  expect(q).toMatchObject({ sent: 2, writes: 1 });
  expect(qualityText(q)).toStartWith("1 of 2 writes saved in 30 days: 1 kept, 0 corrected, 0 reverted");
});

test("the Settings row names its window: the last 24 hours, never 'today'", async () => {
  const root = makeBrain();
  write(root, { agent: "planner", id: "projects/course-a", attribute: "room", value: "B-201", as_of: "2026-10-08", sources: ["gmail:f000000000000006"], verification: "verified-by-source" } as never);
  const t = plain(overview(loadState(root), "c").body);
  expect(t).toContain("wrote 1 in the last 24 hours");
  expect(t).not.toMatch(/wrote \d+ today|nothing today/);
});
