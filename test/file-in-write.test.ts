// SPDX-License-Identifier: AGPL-3.0-only
// Owner's outside review, 2026-10-25: filing was a robot approving a queue, off out of the box, run
// only by the text channel's loop, and only for the capture agent. Now file: all is the default,
// the hub files on its own tick, and a full agent's fact outside its own areas files itself too:
// a new fact lands, a different value is a conflict held for the Gardener, a private note still
// waits for the owner. Trial agents still propose (G422).
import { test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { write } from "../src/write";
import { loadEscalation } from "../src/textline/policy";
import { setFileAll } from "../src/ownerset";
import { runAuto } from "../src/filing";

const inbox = (root: string) => existsSync(join(root, "inbox")) ? readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml")) : [];
const fact = (root: string, id: string, attr: string) => loadBrain(root).find((n) => n.fm.id === id)?.fm.facts?.[attr];
const req = (over: Record<string, unknown> = {}) => ({ agent: "steward", id: "projects/course-a", attribute: "room", value: "B-201", as_of: "2026-10-07", sources: ["gmail:f000000000000041"], verification: "self-reported", ...over }) as never;

test("file all is the default, with no rules/escalation.yaml at all; file-all off writes file: ask", () => {
  const root = makeBrain();
  expect(existsSync(join(root, "rules", "escalation.yaml"))).toBe(false);
  expect(loadEscalation(root).auto_decide.file).toBe("all");
  setFileAll(root, "off");
  expect(YAML.parse(readFileSync(join(root, "rules", "escalation.yaml"), "utf8")).auto_decide.file).toBe("ask");
  expect(loadEscalation(root).auto_decide.file).toBeUndefined();
});

test("a full agent's new fact outside its own area files itself", () => {
  const root = makeBrain();
  expect(write(root, req()).outcome).toBe("committed");
  expect((fact(root, "projects/course-a", "room") as FactRecord).value).toBe("B-201");
  expect(inbox(root)).toEqual([]);
});

test("a different value outside its own area is a conflict held for the Gardener, never a replacement", () => {
  const root = makeBrain();
  const r = write(root, req({ attribute: "next_step", value: "Write the exam", as_of: "2026-10-07" }));
  expect(r.outcome).toBe("disputed");
  const d = loadBrain(root).find((n) => n.fm.type === "dispute")!;
  expect(typeof d.fm.gardener_first).toBe("string");
  // The live value stays for every reader, the conflict beside it (G425).
  const f = fact(root, "projects/course-a", "next_step") as FactRecord;
  expect(f.value).toBe("Grade the midterm");
  expect(f.contested).toBe(String(d.fm.id).split("/")[1]);
  expect((d.fm.candidates as FactRecord[]).map((c) => c.value)).toEqual(["Grade the midterm", "Write the exam"]);
});

test("outside its area on a private note it still waits for the owner; a trial agent still proposes", () => {
  const root = makeBrain();
  const f = join(root, "projects", "course-a.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("sensitivity: personal", "sensitivity: private"));
  Bun.spawnSync(["git", "commit", "-qam", "private"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
  expect(write(root, req()).outcome).toBe("inbox");
  const r2 = makeBrain();
  expect(write(r2, req({ agent: "helper" })).outcome).toBe("inbox");
  // And the hub never files a trial agent's proposal on its own.
  expect(runAuto(r2, new Date())).toEqual([]);
});

// Review thread's north-star eval, 2026-10-25: on a fresh `pocketbrain init` every planned save was
// refused "unknown agent instinct": no brain but the owner's had a capture agent.
test("a new brain has the hub's own capture agent, and what a capture finds files itself", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { initBrain } = await import("../src/init");
  const { loadRules } = await import("../src/rules");
  const { captureAgent, capture } = await import("../src/capture");
  const { makeModel } = await import("../src/model");
  const root = mkdtempSync(join(tmpdir(), "pb-init-"));
  initBrain(root, { owner: "Kim Lee", text: [], token: false });
  expect(captureAgent(loadRules(root))).toBe("capture");
  const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: () => JSON.stringify({ facts: [{ entity: "Ada Fox", type: "person", attribute: "role", value: "Dean of studies", quote: "Ada Fox is the dean of studies" }] }) });
  await capture(root, { text: "Ada Fox is the dean of studies", kind: "text" }, model, { via: "cli" });
  // As the hub's tick runs it on a brain with no text channel: filing only.
  const done = runAuto(root, new Date(), new Set(), { filingOnly: true });
  expect(done.map((d) => d.picked)).toEqual(["saved it"]);
  expect(loadBrain(root).some((n) => n.fm.title === "Ada Fox")).toBe(true);
});

// Slice audit of G422: what filing from outside an area must still never do.
const commitAll = (root: string) => { Bun.spawnSync(["git", "add", "-A"], { cwd: root }); Bun.spawnSync(["git", "commit", "-qm", "x"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "l", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "l", GIT_COMMITTER_EMAIL: "l@x" } }); };
const kim = (root: string, withEmail: boolean) => {
  writeFileSync(join(root, "people", "kim-lee.md"), `---\nid: people/kim-lee\ntype: person\ntitle: Kim Lee\narea: personal\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: steward\nfacts:\n  role: { value: Neighbour, as_of: 2026-09-01, sources: ["gmail:f000000000000009"], verification: verified-by-source, by: steward, recorded: 2026-10-01 }\n${withEmail ? `  emails: { items: [{ value: kim@example.org, as_of: 2026-09-01, sources: ["gmail:f000000000000009"], verification: verified-by-source, by: steward, recorded: 2026-10-01 }] }\n` : ""}---\n`);
  commitAll(root);
};
const out = (over: Record<string, unknown>) => ({ as_of: "2026-10-07", sources: ["gmail:f000000000000041"], verification: "self-reported", ...over }) as never;

test("a retract from outside its area waits for the owner", () => {
  const root = makeBrain();
  expect(write(root, req({ attribute: "next_step", value: "Grade the midterm", retract: true })).outcome).toBe("inbox");
  expect((fact(root, "projects/course-a", "next_step") as FactRecord).value).toBe("Grade the midterm");
});

test("outside its area, a write to an attribute it can't see answers the same whether it is set or not", () => {
  const replies = [true, false].map((has) => {
    const root = makeBrain(); kim(root, has);
    const r = write(root, out({ agent: "planner", id: "people/kim-lee", attribute: "emails", value: "guess@example.org" }));
    return `${r.outcome} ${r.message}`;
  });
  expect(replies[0]).toBe(replies[1]);
  expect(replies[0]).toStartWith("inbox");
});

test("outside its area a weaker source never moves a max value: it is a held conflict", () => {
  const root = makeBrain();
  const f = join(root, "people", "jane-roy.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("  phones:", "  last_contact: { value: 2026-09-01, as_of: 2026-09-01, sources: [\"gmail:f000000000000001\"], verification: verified-by-source, by: planner, recorded: 2026-10-01 }\n  phones:"));
  commitAll(root);
  const r = write(root, out({ agent: "steward", id: "people/jane-roy", attribute: "last_contact", value: "2026-10-07", sources: ["agent:steward"] }));
  expect(r.outcome).toBe("disputed");
});


test("outside its area a real change over time files as an update; the owner's pick of a side keeps its email", async () => {
  const root = makeBrain();
  const r = write(root, req({ attribute: "next_step", value: "Write the exam", as_of: "2026-10-07", sources: ["gmail:f000000000000042"], verification: "verified-by-source" }));
  expect(r.outcome).toBe("committed");
  expect((fact(root, "projects/course-a", "next_step") as FactRecord).value).toBe("Write the exam");
  // A weaker, same-day value is a conflict; the owner picks it and its email stays cited.
  const d = write(root, req({ attribute: "next_step", value: "Book the room", as_of: "2026-10-07", sources: ["gmail:f000000000000043"] }));
  expect(d.outcome).toBe("disputed");
  const { ownerDecide } = await import("../src/core");
  ownerDecide(root, /\((c-[^)\s]+)\)/.exec(String(d.message))![1], 2);
  const f = fact(root, "projects/course-a", "next_step") as FactRecord;
  expect(f.value).toBe("Book the room");
  expect(f.sources.map(String)).toContain("gmail:f000000000000043");
});
