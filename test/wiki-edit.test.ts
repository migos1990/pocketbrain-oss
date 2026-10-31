// SPDX-License-Identifier: AGPL-3.0-only
// Wiki slice 5 (docs/wiki.md): the owner edits one section in place, or asks the model to change
// one section (Edit with chat). Either way only that section changes, and the commit says which
// section and how, so a later reader can tell a human went in.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { makeModel, type ModelRequest } from "../src/model";
import { dashboardHandler, flashOf } from "../src/dashboard/server";
import { git } from "../src/git";

const H = "127.0.0.1:8790";

function setup(fake: (req: ModelRequest) => string = () => "No model in this test.", maxSensitivity: "personal" | "private" = "personal") {
  const root = makeBrain();
  const tok = { helper: issueToken(root, "helper"), planner: issueToken(root, "planner"), steward: issueToken(root, "steward") };
  const prompts: ModelRequest[] = [];
  const d = dashboardHandler(root, { port: 8790, loginKey: "k".repeat(32), modelFor: () => makeModel({ provider: "fake", model: "fake-1", max_sensitivity: maxSensitivity }, { fake: (r) => { prompts.push(r); return fake(r); } }) });
  let cookie = "";
  const req = async (method: string, path: string, fields?: Record<string, string>) => {
    const body = fields ? new URLSearchParams(fields) : undefined;
    const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}${path.startsWith("/action") ? "/brain" : path}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
    const loc = r.headers.get("location") ?? "";
    return { status: r.status, text: await r.text(), loc, ...flashOf(loc) };
  };
  const login = async () => { const r = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } })); cookie = r.headers.get("set-cookie")!.split(";")[0]; };
  const csrf = async () => (await req("GET", "/home")).text.match(/name="csrf" value="([^"]+)"/)![1];
  const post = async (path: string, fields: Record<string, string> = {}) => req("POST", path, { csrf: await csrf(), ...fields });
  const agent = async (who: keyof typeof tok, method: string, path: string, body?: unknown) => {
    const r = await handle(root, new Request(`http://pb${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${tok[who]}` } }));
    const text = await r.text(); let json: any; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };
  return { root, req, post, login, agent, prompts };
}

const JANE = "people/jane-roy";
const withSections = (root: string) => {
  const f = join(root, `${JANE}.md`);
  writeFileSync(f, readFileSync(f, "utf8").replace(/\n?$/, "\n\n## Who they are\nA coordinator.\n\n## Open threads\nThe syllabus.\n"));
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "owner: sections"], "owner");
};
const text = (root: string) => readFileSync(join(root, `${JANE}.md`), "utf8");

test("Edit one section: only it changes, and the commit names the section", async () => {
  const { root, login, post } = setup();
  withSections(root);
  await login();
  const before = text(root);
  const r = await post("/action/section-save", { id: JANE, heading: "Open threads", text: "The syllabus, then the exam." });
  expect(r.ok).toBe("Saved the Open threads section.");
  const after = text(root);
  expect(after).toContain("## Open threads\nThe syllabus, then the exam.");
  expect(after.replace("The syllabus, then the exam.", "The syllabus.")).toBe(before);
  const msg = git(root, ["log", "-1", "--format=%an|%B"]);
  expect(msg).toStartWith("Robin|owner: edit the Open threads section of people/jane-roy");
  expect(msg).toContain("Kind: owner-edit");
  expect(msg).toContain("Section: Open threads");
  expect((await post("/action/section-save", { id: JANE, heading: "Bad\n## x", text: "y" })).err).toContain("heading");
});

test("Edit with chat changes one section; a model that touches anything else is refused", async () => {
  let mode = "good";
  const { root, login, post, prompts } = setup((r) => {
    const note = r.prompt.match(/```markdown\n([\s\S]*?)```/)![1];
    const out = mode === "good" ? note.replace("The syllabus.", "The syllabus and the exam.") : note.replace("A coordinator.", "A dean.").replace("The syllabus.", "The exam.");
    return "```markdown\n" + out + "```";
  });
  withSections(root);
  await login();
  const p = await post(`/propose/${JANE}`, { instruction: "add the exam", section: "Open threads" });
  expect(p.status).toBe(303);
  expect(prompts[0].prompt).toContain("Change only the section headed \"## Open threads\"");
  const a = await post("/action/proposal-apply", { pid: p.loc.split("/").pop()! });
  expect(a.ok).toBe(`${JANE}: saved`);
  expect(text(root)).toContain("## Open threads\nThe syllabus and the exam.");
  const msg = git(root, ["log", "-1", "--format=%B"]);
  expect(msg).toContain("Via: edit-with-chat");
  expect(msg).toContain("Section: Open threads");
  mode = "bad";
  const before = text(root);
  const bad = await post(`/propose/${JANE}`, { instruction: "add the exam", section: "Open threads" });
  expect(bad.err).toContain("changed more than the Open threads section");
  expect(text(root)).toBe(before);
  expect((await post(`/propose/${JANE}`, { instruction: "x", section: "Nope" })).err).toContain("no section Nope");
});
