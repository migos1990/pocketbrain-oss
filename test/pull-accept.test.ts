// SPDX-License-Identifier: AGPL-3.0-only
// A proposal pulled from a source can be accepted: its source_type matches its ref's scheme
// (gmail is email, gcal is calendar, other pulled sources are documents), so the owner's Accept
// isn't refused by source_matches_type. Fake model and fixtures only.
import { test, expect } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { decideProposal } from "../src/write";
import { makeModel, type ModelRequest } from "../src/model";
import { pullSource } from "../src/pull";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } });
const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => JSON.stringify({ facts: /dean of studies/.test(r.prompt) ? [{ entity: "Jane Roy", type: "person", attribute: "role", value: "Dean of studies", quote: "Jane Roy is now the dean of studies" }] : [] }) });
const MAIL = [{ id: "a1b2c3d4e5f60718", labelIds: ["Label_school"], internalDate: "1791000000000", payload: { headers: [{ name: "Subject", value: "News" }] }, text: "Jane Roy is now the dean of studies." }];
const DISC = [{ id: "900", channel_id: "111", channel_name: "#dev", type: 0, content: "Heads up: Jane Roy is now the dean of studies", timestamp: "2026-10-07T10:00:00Z", author: { username: "u1" } }];

for (const [name, source, fixture] of [
  ["gmail", { kind: "gmail", where: ["Label_school"], fixture: "f.json" }, MAIL],
  ["discord", { kind: "discord", where: ["#dev"], fixture: "f.json" }, DISC],
] as const) {
  test(`accepting a fact pulled from ${name} writes it`, async () => {
    const root = makeBrain();
    writeFileSync(join(root, "f.json"), JSON.stringify(fixture));
    writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { src: source } }));
    sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: sources");
    await pullSource(root, "src", { model });
    const files = existsSync(join(root, "inbox")) ? readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml")) : [];
    expect(files.length).toBe(1);
    const r = decideProposal(root, files[0], "accept");
    expect(r.outcome).not.toBe("refused");
    const role = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts!.role as FactRecord;
    expect(role.value).toBe("Dean of studies");
  });
}
