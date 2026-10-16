// SPDX-License-Identifier: AGPL-3.0-only
// Memory Passport bundles (src/passport.ts, docs/export.md): a brain bundle imported into a fresh
// folder gives every agent the same carve; nothing outside the carve's rules, no token and nothing
// secret leaves; import refuses what export never writes.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { exportBrain, exportSlice, importBundle } from "../src/passport";
import { loadBrain, saveNote } from "../src/brain";
import { loadRules } from "../src/rules";
import { carve, grantFor } from "../src/carve";
import { renderNote } from "../src/view";
import { issueToken } from "../src/auth";
import { readNote } from "../src/core";
import { main } from "../src/cli";

const tmp = () => mkdtempSync(join(tmpdir(), "pb-passport-"));
const write = (b: unknown) => { const f = join(tmp(), "bundle.json"); writeFileSync(f, JSON.stringify(b)); return f; };

// What each agent would be served: every visible note, rendered.
function carves(root: string): Record<string, string[]> {
  const rules = loadRules(root), notes = loadBrain(root);
  return Object.fromEntries(Object.keys(rules.policy.agents).sort().map((a) => {
    const res = carve(notes, rules, grantFor(rules, a));
    return [a, [...res.visible.values()].map((v) => renderNote(v, res, rules).join("\n")).sort()];
  }));
}

test("a brain bundle imported into a fresh folder gives every agent the same carve", () => {
  const root = makeBrain();
  const into = join(tmp(), "brain");
  const r = importBundle(write(exportBrain(root)), into);
  expect(r.notes).toBe(loadBrain(root).length);
  expect(r.rules).toContain("policy.yaml");
  const before = carves(root), after = carves(into);
  expect(Object.keys(before).length).toBeGreaterThan(2);
  expect(after).toEqual(before);
  expect(Bun.spawnSync(["git", "log", "--format=%an %s"], { cwd: into }).stdout.toString()).toContain("import: Memory Passport bundle");
});

test("a bundle carries no token, binding, invite or log, and nothing secret", () => {
  const root = makeBrain();
  const token = issueToken(root, "helper");
  mkdirSync(join(root, "log"), { recursive: true });
  writeFileSync(join(root, "log", "reads.jsonl"), '{"agent":"helper"}\n');
  const n = loadBrain(root).find((x) => x.fm.id === "projects/course-a")!;
  n.fm.facts = { ...n.fm.facts, door_code: { value: "4417-Kestrel", as_of: "2026-10-01", sources: ["gmail:f00000000000000b"], verification: "verified-by-source", by: "steward", recorded: "2026-10-01", sensitivity: "secret" } as never };
  n.body += "\nThe door code is 4417-Kestrel.";
  saveNote(root, n);
  const text = JSON.stringify(exportBrain(root));
  expect(text).not.toContain(token);
  expect(text).not.toContain(readFileSync(join(root, "rules", "tokens.yaml"), "utf8").split("\n").find((l) => /[0-9a-f]{32}/.test(l))!.trim());
  expect(text).not.toContain("4417-Kestrel");
  expect(text).not.toContain("door_code");
  expect(Object.keys(exportBrain(root).rules).sort()).toEqual(["RULES.md", "checks.yaml", "policy.yaml", "slices.yaml"]);
  expect(text).not.toContain("reads.jsonl");
});

test("a slice bundle is the agent's own reads: the same facts and body, nothing it may not see", () => {
  const root = makeBrain();
  const b = exportSlice(root, "helper");
  expect(b.bundle).toBe("slice");
  expect(b.notes.length).toBeGreaterThan(0);
  for (const n of b.notes) {
    const r = readNote(root, "helper", n.id);
    expect(n.facts).toEqual(r.facts);
    expect(n.body).toEqual(r.body);
  }
  const text = JSON.stringify(b);
  expect(text).not.toContain("Maple Trust Bank");
  expect(text).not.toContain("money/main-bank");
  expect(() => exportSlice(root, "nobody")).toThrow("no agent nobody");
});

test("import refuses a slice bundle, a used folder, a note id outside the content folders and a rules file export never writes", () => {
  const root = makeBrain();
  const b = exportBrain(root);
  expect(() => importBundle(write(exportSlice(root, "helper")), join(tmp(), "x"))).toThrow("slice bundle");
  const used = tmp(); writeFileSync(join(used, "a"), "");
  expect(() => importBundle(write(b), used)).toThrow("isn't empty");
  for (const id of ["../escape", "/etc/passwd", "people/../../x", "rules/policy", "people/Jane"]) {
    const bad = structuredClone(b); bad.notes[0].fm.id = id;
    const into = join(tmp(), "y");
    expect(() => importBundle(write(bad), into), id).toThrow("bad note id");
    expect(existsSync(into)).toBe(false);
  }
  const tok = structuredClone(b); tok.rules["tokens.yaml"] = "helper: x\n";
  expect(() => importBundle(write(tok), join(tmp(), "z"))).toThrow("isn't something export writes");
  const twice = structuredClone(b); twice.notes.push(twice.notes[0]);
  expect(() => importBundle(write(twice), join(tmp(), "w"))).toThrow("twice");
});

test("pocketbrain export writes the bundle and import makes the brain", async () => {
  const root = makeBrain();
  const out = join(tmp(), "b.json"), slice = join(tmp(), "s.json"), into = join(tmp(), "brain");
  expect(await main(["export", "--brain", root, "--out", out])).toBe(0);
  expect(await main(["export", "--brain", root, "--agent", "helper", "--out", slice])).toBe(0);
  expect(JSON.parse(readFileSync(slice, "utf8")).agent).toBe("helper");
  expect(await main(["import", out, "--into", into])).toBe(0);
  expect(carves(into)).toEqual(carves(root));
});
