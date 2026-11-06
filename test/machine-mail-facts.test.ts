// SPDX-License-Identifier: AGPL-3.0-only
// Machine mail is never read for facts (the owner's standing rule). The owner's phone, 2026-11-03:
// a ride receipt became an org page named for the payee's legal name, filed under a work area, with
// two held rows "Something new only you can see. from an email" and nothing else. The hub's own pull
// skips machine mail (G506, G662), but an assistant reading the inbox filed from it. The hub now
// remembers, by ref, the mail it saw was machine-sent, and write() refuses an assistant's fact citing
// any such mail, whatever else it cites (G679), of any kind of page (G668; G571 covered money pages and never landed).
import { test, expect } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { loadBrain } from "../src/brain";
import { machineMail, recordMachineMail } from "../src/louis";
import { makeModel, type ModelRequest } from "../src/model";
import { pullSource } from "../src/pull";

const RIDE = "gmail:f0000000000000a1", RIDE2 = "gmail:f0000000000000a2", PERSON = "gmail:f0000000000000b1";
const receipt = (agent: string, sources: string[], extra: Record<string, unknown> = {}) =>
  write(makeBrainOnce(), { agent, type: "org", title: "Ride Co Canada Inc.", area: "work", attribute: "trip", value: "a ride on 3 Nov, 14.20", as_of: "2026-10-05", sources, verification: "verified-by-source", ...extra } as never);
let shared: string | undefined;
const makeBrainOnce = () => shared!;
const pages = (root: string) => loadBrain(root).filter((n) => /ride-co/.test(n.fm.id));
const inbox = (root: string) => existsSync(join(root, "inbox")) ? readdirSync(join(root, "inbox"), { recursive: true }).filter((f) => String(f).endsWith(".yaml")) : [];

function rig() { shared = makeBrain(); recordMachineMail(shared, [RIDE, `gmail:primary/${RIDE2.slice(6)}`]); return shared; }

test("an assistant's fact whose every source is machine mail is refused, in one line, and files nothing", () => {
  for (const agent of ["planner", "helper"]) {
    const root = rig();
    const r = receipt(agent, [RIDE]);
    expect(r.outcome).toBe("refused");
    expect(r.message).toStartWith("machine_mail:");
    expect(r.fails?.[0]?.check).toBe("machine_mail");
    expect(pages(root)).toHaveLength(0);
    expect(inbox(root)).toHaveLength(0);
  }
});

test("a ref with its account names the same mail", () => {
  const root = rig();
  expect(receipt("planner", ["gmail:primary/" + RIDE.slice(6), RIDE2]).outcome).toBe("refused");
  expect(pages(root)).toHaveLength(0);
  // A mailbox's Message-ID carries an @ (code review of PR 104).
  recordMachineMail(root, ["mail:inbox/abc123@mailer.example"]);
  expect(receipt("planner", ["mail:abc123@mailer.example"]).outcome).toBe("refused");
});

test("mail the hub never saw as a machine's files as before", () => {
  rig();
  expect(receipt("planner", [PERSON]).outcome).toBe("committed");
});

// Audit v12 (G679): the refusal asked that EVERY source be machine mail, so citing any second
// source beside the receipt (a person's mail, the assistant's own word, a web page) filed it.
// Citing machine mail is reading it for a fact: any machine-mail source refuses, before any lookup.
test("a second source beside machine mail does not get a receipt filed", () => {
  for (const other of [PERSON, "agent:planner", "https://ride.example/receipt", "gmail:primary/" + PERSON.slice(6)]) {
    const root = rig();
    const r = receipt("planner", [RIDE, other]);
    expect(r.outcome).toBe("refused");
    expect(r.fails?.[0]?.check).toBe("machine_mail");
    expect(pages(root)).toHaveLength(0);
    expect(inbox(root)).toHaveLength(0);
  }
  // The same one-line reply whether or not the page exists, so it says nothing about the brain.
  const root = rig();
  expect(receipt("planner", [PERSON]).outcome).toBe("committed");
  const again = receipt("planner", [RIDE2, PERSON]);
  const fresh = (rig(), receipt("planner", [RIDE2, PERSON]));
  expect(again.message).toBe(fresh.message);
  void root;
});

test("the owner's own word is never refused", () => {
  const root = rig();
  const r = write(root, { agent: "owner", type: "org", title: "Ride Co Canada Inc.", area: "work", attribute: "trip", value: "a ride on 3 Nov", as_of: "2026-10-05", sources: [RIDE], verification: "verified-by-source" } as never, { owner: true });
  expect(r.outcome).toBe("committed");
});

test("the hub remembers the machine mail its pull skips, by ref only", async () => {
  const root = makeBrain();
  const mail = (id: string, from: string) => ({ id, labelIds: ["INBOX"], internalDate: "1791000000000", payload: { headers: [{ name: "Subject", value: `Your ride ${id}` }, { name: "From", value: from }] }, text: `Thanks for riding, message ${id}, total 14.20 with enough words to be read today.` });
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { mail: { kind: "gmail", fixture: "m.json" } } }));
  writeFileSync(join(root, "m.json"), JSON.stringify([mail("c000000000000001", "Ride Co <noreply@ride.example>"), mail("c000000000000002", "Jane Roy <jane@school.example>")]));
  const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: (_: ModelRequest) => JSON.stringify({ facts: [] }) });
  await pullSource(root, "mail", { model });
  const m = machineMail(root);
  expect(m.has("gmail:c000000000000001")).toBe(true);
  expect(m.has("gmail:c000000000000002")).toBe(false);
});

// The pages filed before (the phone's ride receipt page): upkeep counts them until the owner says
// `pocketbrain machine-mail on`, then sets each held fact aside with a diary line and Undo; a page
// left with nothing goes with it, and Undo brings both back, held as before.
test("held facts filed from machine mail before: counted, then set aside with Undo", async () => {
  const { upkeep } = await import("../src/upkeep");
  const { setMachineMailAside } = await import("../src/ownerset");
  const { readDiary } = await import("../src/diary");
  const { undoFact } = await import("../src/undo");
  const root = makeBrain();
  const filed = write(root, { agent: "planner", type: "org", title: "Ride Co Canada Inc.", area: "work", attribute: "trip", value: "a ride on 3 Nov, 14.20", sensitivity: "private", as_of: "2026-10-05", sources: [RIDE], verification: "verified-by-source" } as never);
  expect(filed.outcome).toBe("committed");
  // A person's own mail on another page stays, whatever else is set aside.
  expect(write(root, { agent: "planner", type: "org", title: "Ride Co Canada Inc.", area: "work", attribute: "contact", value: "support desk", sensitivity: "private", as_of: "2026-10-05", sources: [PERSON], verification: "verified-by-source" } as never).outcome).toBe("committed");
  recordMachineMail(root, [RIDE]);
  const id = pages(root)[0]!.fm.id;
  expect(pages(root)[0]!.fm.facts!.trip).toBeDefined();
  const off = upkeep(root, { run: "reflect-mm-off" });
  expect(off.findings.find((f) => f.rule === "machine-mail")?.detail).toContain("1 held fact on 1 page came only from machine mail");
  expect(pages(root)[0]!.fm.facts!.trip).toBeDefined();
  setMachineMailAside(root, "on");
  upkeep(root, { run: "reflect-mm-on" });
  const kept = pages(root)[0]!;
  expect(kept.fm.facts!.trip).toBeUndefined();
  expect(kept.fm.facts!.contact).toBeDefined();
  const row = readDiary(root).find((r) => r.why === "machine")!;
  expect(row.fact_key).toBe(`${id}#trip`);
  expect(undoFact(root, row.undo_token!).outcome).toBe("undone");
  const back = pages(root)[0]!.fm.facts!.trip as { value: string; unseen?: boolean };
  expect(back.value).toBe("a ride on 3 Nov, 14.20");
  expect(back.unseen).toBe(true);
});

test("a page left with nothing goes with its last machine-mail fact, and Undo brings it back", async () => {
  const { upkeep } = await import("../src/upkeep");
  const { setMachineMailAside } = await import("../src/ownerset");
  const { readDiary } = await import("../src/diary");
  const { undoFact } = await import("../src/undo");
  const root = makeBrain();
  expect(write(root, { agent: "planner", type: "org", title: "Ride Co Canada Inc.", area: "work", attribute: "trip", value: "a ride on 3 Nov, 14.20", sensitivity: "private", as_of: "2026-10-05", sources: [RIDE], verification: "verified-by-source" } as never).outcome).toBe("committed");
  const id = pages(root)[0]!.fm.id;
  recordMachineMail(root, [RIDE]);
  setMachineMailAside(root, "on");
  upkeep(root, { run: "reflect-mm" });
  expect(pages(root)).toHaveLength(0);
  const row = readDiary(root).find((r) => r.why === "machine")!;
  expect(undoFact(root, row.undo_token!).outcome).toBe("undone");
  const back = pages(root);
  expect(back.map((n) => n.fm.id)).toEqual([id]);
  expect((back[0]!.fm.facts!.trip as { unseen?: boolean }).unseen).toBe(true);
});

test("a removed page with two set-aside facts: each Undo brings back its own fact only", async () => {
  const { upkeep } = await import("../src/upkeep");
  const { setMachineMailAside } = await import("../src/ownerset");
  const { readDiary } = await import("../src/diary");
  const { undoFact } = await import("../src/undo");
  const root = makeBrain();
  for (const [attribute, value] of [["trip", "a ride on 3 Nov, 14.20"], ["total", "14.20"]])
    expect(write(root, { agent: "planner", type: "org", title: "Ride Co Canada Inc.", area: "work", attribute, value, sensitivity: "private", as_of: "2026-10-05", sources: [RIDE], verification: "verified-by-source" } as never).outcome).toBe("committed");
  recordMachineMail(root, [RIDE]);
  setMachineMailAside(root, "on");
  upkeep(root, { run: "reflect-mm2" });
  expect(pages(root)).toHaveLength(0);
  const rows = readDiary(root).filter((r) => r.why === "machine");
  expect(rows).toHaveLength(2);
  const trip = rows.find((r) => r.fact_key.endsWith("#trip"))!, total = rows.find((r) => r.fact_key.endsWith("#total"))!;
  expect(undoFact(root, trip.undo_token!).outcome).toBe("undone");
  expect(Object.keys(pages(root)[0]!.fm.facts!)).toEqual(["trip"]);
  expect(undoFact(root, total.undo_token!).outcome).toBe("undone");
  expect(Object.keys(pages(root)[0]!.fm.facts!).sort()).toEqual(["total", "trip"]);
});

test("an old line never brings back a page removed later by anything else", async () => {
  const { upkeep } = await import("../src/upkeep");
  const { setMachineMailAside } = await import("../src/ownerset");
  const { readDiary } = await import("../src/diary");
  const { undoFact } = await import("../src/undo");
  const root = makeBrain();
  const filed = () => write(root, { agent: "planner", type: "org", title: "Ride Co Canada Inc.", area: "work", attribute: "trip", value: "a ride on 3 Nov, 14.20", sensitivity: "private", as_of: "2026-10-05", sources: [RIDE], verification: "verified-by-source" } as never);
  expect(filed().outcome).toBe("committed");
  recordMachineMail(root, [RIDE]);
  setMachineMailAside(root, "on");
  upkeep(root, { run: "reflect-mm3" });
  const row = readDiary(root).find((r) => r.why === "machine")!;
  // The page comes back another way, then the owner removes it.
  const rel = `${row.fact_key.split("#")[0]}.md`;
  const sh = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  const aside = sh("log", "-1", "--diff-filter=D", "--format=%H", "--", rel).stdout.toString().trim();
  writeFileSync(join(root, rel), sh("show", `${aside}^:${rel}`).stdout.toString());
  expect(sh("add", rel).exitCode).toBe(0); expect(sh("commit", "-qm", "owner: back by hand").exitCode).toBe(0);
  expect(sh("rm", "-q", rel).exitCode).toBe(0); expect(sh("commit", "-qm", "owner: forget\n\nForgot: it").exitCode).toBe(0);
  expect(undoFact(root, row.undo_token!).outcome).toBe("changed_since");
  expect(pages(root)).toHaveLength(0);
});

test("a fact the owner let out, or the owner's own, is never set aside", async () => {
  const { setAsideMachineMail } = await import("../src/receipt-pages");
  const root = makeBrain();
  write(root, { agent: "planner", type: "org", title: "Ride Co Canada Inc.", area: "work", attribute: "trip", value: "a ride on 3 Nov", as_of: "2026-10-05", sources: [RIDE], verification: "verified-by-source" } as never);
  write(root, { agent: "owner", type: "org", title: "Ride Co Canada Inc.", area: "work", attribute: "plan", value: "rides to campus", as_of: "2026-10-05", sources: [RIDE], verification: "verified-by-source" } as never, { owner: true });
  recordMachineMail(root, [RIDE]);
  const held = (pages(root)[0]!.fm.facts!.trip as { unseen?: boolean }).unseen;
  expect(setAsideMachineMail(root, false).facts).toBe(held ? 1 : 0);
});

// On the demo brain, through the owner's home: the receipt an assistant filed before is counted,
// set aside on the owner's word with a line on the home, and a new one is refused.
test("on the demo brain: an old receipt fact is set aside with a home line, a new one refused", async () => {
  const { makeDemoBrain } = await import("./fixture");
  const { DEMO_NOW } = await import("../scripts/demo-brain");
  const { upkeep } = await import("../src/upkeep");
  const { setMachineMailAside } = await import("../src/ownerset");
  const { homeView } = await import("../src/dashboard/home");
  const { loadRules } = await import("../src/rules");
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    const ride = (value: string) => write(root, { agent: "claude", type: "org", title: "Ride Co Canada Inc.", area: "work", attribute: "trip", value, sensitivity: "private", as_of: "2026-10-05", sources: [RIDE], verification: "verified-by-source" } as never);
    expect(ride("a ride on 3 Nov, 14.20").outcome).toBe("committed");
    recordMachineMail(root, [RIDE]);
    expect(ride("a ride on 4 Nov, 9.80").outcome).toBe("refused");
    expect(upkeep(root, { run: "reflect-demo-off" }).findings.find((f) => f.rule === "machine-mail")?.detail).toContain("1 held fact on 1 page");
    setMachineMailAside(root, "on");
    upkeep(root, { run: "reflect-demo-on" });
    expect(pages(root)).toHaveLength(0);
    const view = homeView(root, loadRules(root), loadBrain(root), new Date(DEMO_NOW), { all: true, fresh: true });
    expect(JSON.stringify(view)).toContain("machine mail isn't read for facts");
  } finally { delete process.env.PB_NOW; }
}, 90_000);
