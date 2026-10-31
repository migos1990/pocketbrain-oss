// SPDX-License-Identifier: AGPL-3.0-only
// What a vendor's export keeps of its memory (src/memimport.ts readMemory, G493): ChatGPT's memory
// saves only, never its chats; claude.ai's and Gemini's chat history and activity read as nothing.
// The fixtures are made up in the layout each export is known to use, not copied from one.
import { test, expect } from "bun:test";
import { join } from "node:path";
import { readMemory, skippedMemory, afterImport } from "../src/memimport";
import { makeBrain } from "./fixture";

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

// G580: claude.ai's memory export is a folder of Markdown pages (areas/, people/, topics/,
// projects/<project>/<page>.md), each with a name and a description; a project's pages often never
// name the project. The folder path is the page's subject, so it goes with the text.
test("G580: a claude.ai memory folder keeps each page's folder path as its subject", () => {
  const dir = join(import.meta.dir, "fixtures", "vendor-memory", "claude-memory");
  const read = readMemory([dir]);
  expect(read.map((m) => m.name)).toEqual(["areas/teaching.md", "projects/Garden Shed/budget.md"]);
  const shed = read.find((m) => m.name.endsWith("budget.md"))!;
  expect(shed.text.split("\n")[0]).toBe("(From projects/Garden Shed/budget)");
  expect(shed.text).toContain("- Lumber is bought at the yard on Elm Street");
  // A file given by itself has no folder to name.
  expect(readMemory([join(dir, "areas", "teaching.md")])[0].text.startsWith("---")).toBe(true);
});

// G580: the import's last line said "Review them with pocketbrain inbox", but facts file
// themselves now; and a trial assistant's imported facts are left to expire, which nobody was told.
test("G580: the import says where its facts go, and warns when they would expire", () => {
  const root = makeBrain();
  expect(afterImport(root, "steward")).toContain("file themselves");
  expect(afterImport(root, "steward")).toContain("settle");
  expect(afterImport(root, "helper")).toContain("expire");
  expect(afterImport(root, "me")).toContain("file themselves");
});
