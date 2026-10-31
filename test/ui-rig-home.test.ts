// SPDX-License-Identifier: AGPL-3.0-only
// The UI rig's home is designed against the demo brain (outside review 2026-10-29, item 2): on its
// pinned morning the home must look like a lived-in day, never "Nothing new since yesterday". The
// third outside read (2026-10-29) found the rig's home never showed the belief radar (G496) and
// fell on the real clock's day (G497); both hold on the demo brain too. Since the owner app
// (2026-10-30) the assistants' rows and the radar are on Who knows (/who).
import { test, expect } from "bun:test";
import { uiRig } from "./ui-rig";
import { HOME_COPY } from "../src/dashboard/html-home";
import { APP_COPY } from "../src/dashboard/html-app";

async function homeOf(r: Awaited<ReturnType<typeof uiRig>>, path = "/home"): Promise<string> {
  const login = await fetch(r.loginUrl, { redirect: "manual" });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  return (await fetch(`${r.dash}${path}`, { headers: { cookie } })).text();
}
const count = (html: string, s: string) => html.split(s).length - 1;

test("the rig's home is a full day: conflicts and a private value waiting, a week of memories; Who knows has assistants that read today, one with something wrong", async () => {
  const r = await uiRig();
  try {
    const html = await homeOf(r);
    expect(html).toContain("Thu 8 Oct");
    expect(html).toContain(`<h1>${APP_COPY.mind}</h1>`);
    expect(html).not.toContain(APP_COPY.quiet);
    // Waiting on you: the week's three planted conflicts and Hélène's private value, held for a Show.
    expect(r.conflicts.length).toBe(3);
    for (const id of r.conflicts) expect(html).toContain(`/settle/${id}`);
    expect(html).toContain("Something new about Hélène Lefebvre");
    // Who knows: each read today, ChatGPT still remembers Isabelle Roy's old role.
    const who = await homeOf(r, "/who");
    expect(who).toContain("<b>Claude</b>");
    expect(who).toContain("Read your brain 6 times today");
    expect(who).toContain("<b>ChatGPT</b><small>Read your brain 3 times today</small>");
    expect(who).toMatch(/<b>Gemini<\/b><span class="badge">trial<\/span><small>Hasn&#39;t read your brain today<\/small>/);
    expect(who).toContain("remembers “She&#39;s the course coordinator”");
    expect(who).toContain(HOME_COPY.fix);
    expect(who).toContain("/action/fix-everywhere");
    // The memories: since yesterday, then earlier days, each with its day inside the line, and the rest folded.
    expect(count(html, `>${HOME_COPY.undo}</button>`)).toBeGreaterThanOrEqual(12);
    expect(html).toContain(APP_COPY.justSaid);
    expect(html).toContain("you said, Tue");
    expect(html).toContain("from your ChatGPT");
    expect(html).toContain("from an email, Sun");
    expect(html).toMatch(/\d+ more on your mind/);
  } finally { r.stop(); }
}, 60_000);

test("the busy rig adds the operator's states and keeps the home's day", async () => {
  const r = await uiRig({ busy: true });
  try {
    const html = await homeOf(r);
    expect(html).toContain("Thu 8 Oct");
    expect(html).not.toContain(APP_COPY.quiet);
    expect(await homeOf(r, "/who")).toContain(HOME_COPY.fix);
  } finally { r.stop(); }
}, 60_000);

test("the rig puts the clock back when it stops, also with two rigs open at once", async () => {
  const before = process.env.PB_NOW;
  const r = await uiRig();
  r.stop();
  expect(process.env.PB_NOW).toBe(before);
  const quiet = await uiRig(), busy = await uiRig();
  quiet.stop(); busy.stop();
  expect(process.env.PB_NOW).toBe(before);
}, 60_000);
