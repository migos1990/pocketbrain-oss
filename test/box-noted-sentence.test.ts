// SPDX-License-Identifier: AGPL-3.0-only
// The box's own reply read as a fact line (coordinator, from the owner app, 2026-10-31): "Noted:
// Jane Roy: role is dean." The home says its memories as sentences (LINE_COPY in
// src/dashboard/home.ts); the box's "Noted" says what it kept the same way, in the owner's words.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { ownerSay } from "../src/owner-say";

const noted = (root: string, said: string) => ownerSay(root, said).text;

test("what the box noted reads as a sentence, the way the home says it", () => {
  expect(noted(makeBrain(), "Jane is the dean")).toStartWith("Noted: Jane Roy is dean now.");
  expect(noted(makeBrain(), "Jane Roy's next step is send the syllabus by Friday")).toStartWith("Noted: Next for Jane Roy: send the syllabus by Friday.");
  expect(noted(makeBrain(), "Met Jane Roy today")).toMatch(/^Noted: You were last in touch with Jane Roy on \d{1,2} \w+ \d{4}\./);
  expect(noted(makeBrain(), "Jane Roy's city is Laval")).toStartWith("Noted: Jane Roy's city is");
});

test("no reply the box writes reads 'Page: attribute is value'", () => {
  for (const said of ["Jane is the dean", "Jane moved to Brightwave", "Remind me to call Jane tomorrow", "Met Marco Bianchi yesterday, he runs the new lab"]) {
    const text = noted(makeBrain(), said);
    expect({ said, text }).toEqual({ said, text: expect.not.stringMatching(/^Noted: [^.;]*?: [a-z ]+ is /) });
  }
});
