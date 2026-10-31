// SPDX-License-Identifier: AGPL-3.0-only
// What a vendor's export keeps of its memory (src/memimport.ts readMemory, G493): ChatGPT's memory
// saves only, never its chats; claude.ai's and Gemini's chat history and activity read as nothing.
// The fixtures are made up in the layout each export is known to use, not copied from one.
import { test, expect } from "bun:test";
import { join } from "node:path";
import { readMemory, skippedMemory } from "../src/memimport";

const F = join(import.meta.dir, "fixtures", "vendor-memory");

test("G493: a ChatGPT export gives only what the assistant saved to its memory", () => {
  const [m] = readMemory([join(F, "chatgpt-conversations.json")]);
  expect(m.shape).toBe("chatgpt");
  expect(m.text).toBe("Jane Roy prefers email over phone calls.");
  // Neither the chat around it nor the tool's own reply is memory.
  expect(m.text).not.toContain("budget");
  expect(m.text).not.toContain("Model set context");
});

test("G493: claude.ai and Gemini chat history is not memory: nothing is read, and the owner is told", () => {
  const files = [join(F, "claude-conversations.json"), join(F, "gemini-MyActivity.json")];
  expect(readMemory(files)).toEqual([]);
  expect(skippedMemory([F])).toEqual([{ name: "claude-conversations.json", shape: "chat-history" }, { name: "gemini-MyActivity.json", shape: "gemini-activity" }]);
});
