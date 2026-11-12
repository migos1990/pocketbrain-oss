// SPDX-License-Identifier: AGPL-3.0-only
// Machine mail is never read for facts, whichever door it comes through (owner's phone, 2026-11-11:
// an assistant passed on a room-booking confirmation and it became a new decision note to approve;
// the hub's own pull would never have read it). An assistant's capture of mail a machine sent is
// refused before anything is stored, by its From field or a From: line at the top of the text.
import { test, expect, afterAll } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { captureFromAgent } from "../src/core";
import { loadRules } from "../src/rules";

const roots: string[] = [];
const brain = () => { const r = makeBrain(); roots.push(r); return r; };
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const stored = (root: string) => existsSync(join(root, "inbox", "captures")) ? readdirSync(join(root, "inbox", "captures")) : [];
const BOOKING = "Your room booking REG239428 has been approved for 2026-11-23, 9:00 to 12:00.";

for (const [name, body] of [
  ["its From field", { kind: "email", from: "Room Bookings <no-reply@bookings.example>", subject: "Booking approved", text: BOOKING }],
  ["a From: line atop the text", { kind: "email", text: `From: Room Bookings <noreply@bookings.example>\nSubject: Booking approved\n\n${BOOKING}` }],
  ["a forwarded block", { kind: "email", text: `---------- Forwarded message ---------\nFrom: Campus Notifications <notifications@school.example>\nSubject: Booking approved\n\n${BOOKING}` }],
] as const) {
  test(`an assistant's capture of machine mail is refused and nothing is stored: ${name}`, async () => {
    const root = brain();
    const ch = loadRules(root).policy.resolver!;
    const r = await captureFromAgent(root, ch, body as never);
    expect(r.outcome).toBe("refused");
    expect(r.message).toMatch(/machine/);
    expect(stored(root)).toEqual([]);
  });
}

test("mail a person wrote still goes through", async () => {
  const root = brain();
  const ch = loadRules(root).policy.resolver!;
  const r = await captureFromAgent(root, ch, { kind: "email", from: "Dana <dana@example.org>", text: `From: Dana <dana@example.org>\n\nThe room is booked for the 23rd.` });
  expect(r.outcome).not.toBe("refused");
  expect(stored(root).length).toBe(1);
});

// The same day's other wrong sentence: the ask the hub filed from its own Gmail pull, sent back by a
// check, said "From your assistant <capture channel>". It keeps where it came from for its card.
test("a pulled fact a check sends back is still from an email on its card, never from an assistant", async () => {
  const YAML = (await import("yaml")).default;
  const { writeFileSync, readFileSync } = await import("node:fs");
  const { storeCapture } = await import("../src/capture");
  const { decideProposal } = await import("../src/write");
  const { proposals } = await import("../src/dashboard/data");
  const { git } = await import("../src/git");
  const { captureAgentName } = await import("../src/rules");
  const root = brain();
  const agent = captureAgentName(loadRules(root).policy);
  const s = storeCapture(root, { kind: "text", text: "The room booking is approved for Nov 23." }, { via: "source", by: "source:gmail-primary" }, { source_ref: "gmail:f000000000000006", source_kind: "gmail" });
  expect(s.outcome).not.toBe("refused");
  const file = "2026-10-08-capture-aaaa1111.yaml";
  writeFileSync(join(root, "inbox", file), YAML.stringify({ proposed: "2026-10-08", by: agent, reason: `capture ${s.file}: new note`, checks: ["capture"], capture: s.file, request: { agent, kind: "fact", type: "project", title: "Room booking", area: "work", attribute: "status", value: "Room booking approved for Nov 23", as_of: "2026-10-08", sources: ["gmail:f000000000000006"], source_type: "email" } }));
  git(root, ["add", "inbox"]); git(root, ["commit", "-q", "-m", "hub: a capture proposal"]);
  const r = decideProposal(root, file, "accept", "auto-decide");
  expect(r.outcome).toBe("inbox");
  const again = proposals(root).find((p) => p.file !== file)!;
  expect(again.pulledFrom).toBe(s.file);
  // Not the filing's key: the hub doesn't take it as its own capture to file again.
  expect(YAML.parse(readFileSync(join(root, "inbox", again.file), "utf8")).capture).toBeUndefined();
  // Its card on Settings: a mail find, not an assistant's claim.
  const { dashboardHandler } = await import("../src/dashboard/server");
  const H = "127.0.0.1:8797", key = "k".repeat(32);
  const d = dashboardHandler(root, { port: 8797, loginKey: key });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${key}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
  const html = await (await d.handle(new Request(`http://${H}/overview`, { headers: { host: H, cookie } }))).text();
  expect(html).toContain("Room booking");
  expect(html).not.toMatch(/From your assistant [^<]*<\/small>[\s\S]{0,400}Room booking|Room booking[\s\S]{0,600}From your assistant/);
});
