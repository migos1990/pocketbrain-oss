// SPDX-License-Identifier: AGPL-3.0-only
// G639: on the phone, Memory listed "Notes 13" and "Assistants' notes 41" side by side and the owner
// couldn't tell them apart; the assistants' pages are the routines and jobs they run. And titles
// written as Markdown links read as raw Markdown ("[site.example](http://site.example) reporting").
import { test, expect } from "bun:test";
import { kindLabel } from "../src/dashboard/browse";
import { displayName } from "../src/diary";
import { memoryPage, APP_COPY } from "../src/dashboard/html-app";

test("the assistants' pages are named for what they are, apart from the owner's notes", () => {
  expect(kindLabel("agents")).toBe("Assistants' routines");
  expect(kindLabel("notes")).toBe("Notes");
  const html = memoryPage({ pages: 3, people: 1, name: "Robin", kinds: [], week: [], kind: { label: kindLabel("agents"), folder: "agents", pages: [] } });
  expect(html).toContain(APP_COPY.routinesHint);
});

test("a title written as a Markdown link reads as its words", () => {
  expect(displayName("agents/site", "[site.example](http://site.example) session reporting")).toBe("site.example session reporting");
  expect(displayName("agents/inbox", "AgentMail inbox ([bot@mail.example](mailto:bot@mail.example))")).toBe("AgentMail inbox (bot@mail.example)");
  expect(displayName("people/a", "Plain [brackets] stay")).toBe("Plain [brackets] stay");
});
