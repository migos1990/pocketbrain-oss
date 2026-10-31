// SPDX-License-Identifier: AGPL-3.0-only
// Owner pages say "assistant", never "agent" (live page 2026-10-24: "the agent's word" 8 times; the
// new-user run then found it on a note's sources, History, Brain, Usage and an assistant's page).
import { test, expect } from "bun:test";
import { kindLabel, sourceWords } from "../src/dashboard/browse";

test("where a fact came from and the folder of assistants' notes say assistant", () => {
  expect(sourceWords(["agent:helper"])).not.toMatch(/\bagents?\b/i);
  expect(sourceWords(["agent-relay:x"])).not.toMatch(/\bagents?\b/i);
  expect(kindLabel("agents")).toBe("Assistants' notes");
});
