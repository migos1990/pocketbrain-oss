// SPDX-License-Identifier: AGPL-3.0-only
// Voice notes in the drop folder (docs/capture.md, "Voice notes"): off by default; with a local
// command or a hosted API set in rules/models.yaml (step capture.transcribe), an audio file
// becomes a voice capture of its transcript. The audio itself never enters the brain.
// The audio here is a generated fixture; the local transcriber is a fake script, the hosted
// API a fake fetch. Nothing calls a real model.
import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { makeModel } from "../src/model";
import { useCaptureModel, captureModel, readCapture } from "../src/capture";
import { dropOnce } from "../src/intake";
import { cleanTranscript, transcribeConfig, transcriberFor, useTranscribeFetch } from "../src/transcribe";

const original = captureModel;
beforeAll(() => useCaptureModel(() => makeModel({ provider: "fake", model: "fake-1" }, { fake: () => JSON.stringify({ facts: [] }) })));
afterAll(() => useCaptureModel((root) => original(root)));
afterEach(() => { useTranscribeFetch(undefined); delete process.env.PB_TEST_WHISPER_KEY; });

const MARKER = "AUDIO-BYTES-7f3c";
// A short silent WAV with a marker in its data, to prove the audio is never copied anywhere.
function wav(): Buffer {
  const data = Buffer.concat([Buffer.from(MARKER), Buffer.alloc(1600)]);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function dropFolder() {
  const d = mkdtempSync(join(tmpdir(), "pb-drop-"));
  return { d, put: (name: string, body: string | Buffer) => { writeFileSync(join(d, name), body); utimesSync(join(d, name), new Date(Date.now() - 60000), new Date(Date.now() - 60000)); } };
}

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } });
function setStep(root: string, cfg: Record<string, unknown> | undefined) {
  const f = join(root, "rules/models.yaml");
  const doc = existsSync(f) ? YAML.parse(readFileSync(f, "utf8")) ?? {} : {};
  doc.steps = { ...(doc.steps ?? {}) };
  if (cfg) doc.steps["capture.transcribe"] = cfg; else delete doc.steps["capture.transcribe"];
  writeFileSync(f, YAML.stringify(doc));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "louis: models");
}

// A fake whisper.cpp-style binary: prints timestamped segments for the file it is given.
function fakeWhisper(lines: string[], exit = 0): string {
  const dir = mkdtempSync(join(tmpdir(), "pb-whisper-"));
  const f = join(dir, "whisper.js");
  writeFileSync(f, `const fs = require("node:fs");
const audio = process.argv[2];
if (!fs.existsSync(audio)) { console.error("no file " + audio); process.exit(3); }
fs.writeFileSync(${JSON.stringify(join(dir, "seen"))}, audio);
${exit ? `console.error("model file missing"); process.exit(${exit});` : ""}
for (const l of ${JSON.stringify(lines)}) console.log(l);`);
  return f;
}

test("off by default: a voice note waits in failed/ with a note on how to turn transcription on, and nothing runs", async () => {
  const root = makeBrain();
  expect(transcribeConfig(root)).toBeUndefined();
  // A step default or a models.yaml default never turns it on: only the step itself does.
  setStep(root, undefined);
  const { d, put } = dropFolder();
  put("memo.m4a", wav());
  const r = await dropOnce(root, d, { settleSeconds: 0 });
  expect(r[0]).toMatchObject({ name: "memo.m4a", outcome: "failed" });
  expect(readFileSync(join(d, "failed", "memo.m4a.why.txt"), "utf8")).toMatch(/transcription is off.*rules\/models\.yaml step capture\.transcribe/);
});

test("local command: the transcript becomes a voice capture; the audio moves to done/ and never enters the brain", async () => {
  const root = makeBrain();
  const script = fakeWhisper([
    "",
    "[00:00:00.000 --> 00:00:04.000]   Course A, publish grades by Monday.",
    "[00:00:04.000 --> 00:00:09.000]   The door code is 4417 and my card is 4111 1111 1111 1111.",
  ]);
  setStep(root, { provider: "command", command: [process.execPath, script, "{audio}"] });
  const { d, put } = dropFolder();
  put("2026-10-15 voice memo.m4a", wav());

  const r = await dropOnce(root, d, { settleSeconds: 0 });
  expect(r[0].outcome).toBe("stored");
  const cap = readCapture(root, r[0].file!);
  expect(cap.fm).toMatchObject({ kind: "voice", via: "drop", by: "owner" });
  expect(cap.text).toContain("Course A, publish grades by Monday. The [removed: secret-shaped]");
  expect(cap.text).not.toContain("4417"); // the door code too (G47)
  expect(cap.text).not.toContain("-->");
  expect(cap.text).not.toContain("4111 1111 1111 1111"); // secrets are blanked as for any capture
  expect(readFileSync(join(dirname(script), "seen"), "utf8")).toContain("voice memo.m4a");
  expect(readdirSync(join(d, "done", readdirSync(join(d, "done"))[0]))).toEqual(["2026-10-15 voice memo.m4a"]);
  // Nothing in the brain's tree or history holds the audio.
  const grep = sh(root, "git", "grep", "-c", MARKER, ...sh(root, "git", "rev-list", "--all").stdout.toString().trim().split("\n"));
  expect(grep.stdout.toString()).toBe("");
  expect(sh(root, "git", "ls-files").stdout.toString()).not.toMatch(/\.(m4a|wav)\b/);
});

test("local command that fails or hears nothing: failed/ says why, nothing is captured", async () => {
  const root = makeBrain();
  setStep(root, { provider: "command", command: [process.execPath, fakeWhisper([], 2), "{audio}"] });
  const { d, put } = dropFolder();
  put("a.wav", wav());
  expect((await dropOnce(root, d, { settleSeconds: 0 }))[0].outcome).toBe("failed");
  expect(readFileSync(join(d, "failed", "a.wav.why.txt"), "utf8")).toMatch(/exited 2.*model file missing/s);

  setStep(root, { provider: "command", command: [process.execPath, fakeWhisper(["[00:00:00.000 --> 00:00:02.000]   [BLANK_AUDIO]"]), "{audio}"] });
  put("b.wav", wav());
  expect((await dropOnce(root, d, { settleSeconds: 0 }))[0].outcome).toBe("failed");
  expect(readFileSync(join(d, "failed", "b.wav.why.txt"), "utf8")).toMatch(/no speech/);
  expect(existsSync(join(root, "inbox", "captures"))).toBe(false);
});

test("a command without {audio}, or an unknown provider, is refused before anything runs", () => {
  const root = makeBrain();
  setStep(root, { provider: "command", command: ["whisper-cli", "-m", "model.bin"] });
  expect(transcriberFor(root)).toMatch(/\{audio\}/);
  setStep(root, { provider: "anthropic", model: "claude-sonnet-5-5" });
  expect(transcriberFor(root)).toMatch(/provider/);
});

test("hosted API only with a key: sends the file to /audio/transcriptions, meters the call, honours the step cap", async () => {
  const root = makeBrain();
  setStep(root, { provider: "openai-compatible", base_url: "https://stt.example/v1", model: "whisper-large-v3", api_key_env: "PB_TEST_WHISPER_KEY" });
  const calls: { url: string; auth?: string; model?: string; size?: number }[] = [];
  useTranscribeFetch(async (url, init) => {
    const form = init.body as FormData;
    const file = form.get("file") as File;
    calls.push({ url, auth: (init.headers as Record<string, string>)?.authorization, model: String(form.get("model")), size: file.size });
    return new Response("Course A, book the exam room B-201.\n", { status: 200 });
  });
  const { d, put } = dropFolder();
  // openai-compatible may run keyless (a local server); a key env that is named but unset is refused.
  put("memo.m4a", wav());
  expect((await dropOnce(root, d, { settleSeconds: 0 }))[0].outcome).toBe("failed");
  expect(readFileSync(join(d, "failed", "memo.m4a.why.txt"), "utf8")).toMatch(/set PB_TEST_WHISPER_KEY/);
  expect(calls).toEqual([]);

  process.env.PB_TEST_WHISPER_KEY = "k-test";
  put("memo2.m4a", wav());
  const r = await dropOnce(root, d, { settleSeconds: 0 });
  expect(r[0].outcome).toBe("stored");
  expect(calls).toEqual([{ url: "https://stt.example/v1/audio/transcriptions", auth: "Bearer k-test", model: "whisper-large-v3", size: wav().length }]);
  expect(readCapture(root, r[0].file!).text).toContain("book the exam room B-201");
  const usage = readFileSync(join(root, "log", "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(usage.at(-1)).toMatchObject({ step: "capture.transcribe", outcome: "ok", provider: "openai-compatible", model: "whisper-large-v3" });

  // A step cap that is reached pauses transcription; the file waits in failed/ with the reason.
  const pf = join(root, "rules/policy.yaml");
  const p = YAML.parse(readFileSync(pf, "utf8")) ?? {};
  p.usage = { cap: { steps: { "capture.transcribe": 0 } } };
  writeFileSync(pf, YAML.stringify(p));
  put("memo3.m4a", wav());
  expect((await dropOnce(root, d, { settleSeconds: 0 }))[0].outcome).toBe("failed");
  expect(readFileSync(join(d, "failed", "memo3.m4a.why.txt"), "utf8")).toMatch(/paused/);
  expect(calls.length).toBe(1);
});

test("audio over the transcription size limit is refused without being read", async () => {
  const root = makeBrain();
  setStep(root, { provider: "command", command: [process.execPath, fakeWhisper(["hello"]), "{audio}"], max_bytes: 100 });
  const { d, put } = dropFolder();
  put("long.m4a", wav());
  expect((await dropOnce(root, d, { settleSeconds: 0 }))[0]).toMatchObject({ outcome: "failed", detail: "too large" });
});

test("cleanTranscript drops timestamps, blank-audio tags and extra space", () => {
  expect(cleanTranscript("[00:00:00.000 --> 00:00:02.000]  Hello there.\n\n[00:00:02.000 --> 00:00:03.000]   [BLANK_AUDIO]\n  Second   line ")).toBe("Hello there. Second line");
  expect(cleanTranscript("[Music]\n(silence)")).toBe("");
});

test("CLI: capture --voice takes an audio file once a transcriber is set, and says how to turn it on before", () => {
  const root = makeBrain();
  const dir = mkdtempSync(join(tmpdir(), "pb-voice-"));
  writeFileSync(join(dir, "memo.wav"), wav());
  const cli = () => Bun.spawnSync(["bun", "src/cli.ts", "capture", "--voice", join(dir, "memo.wav"), "--brain", root], { cwd: join(import.meta.dir, ".."), env: process.env });
  const off = cli();
  expect(off.exitCode).toBe(1);
  expect(off.stderr.toString()).toMatch(/transcription is off/);

  setStep(root, { provider: "command", command: [process.execPath, fakeWhisper(["[00:00:00.000 --> 00:00:03.000]   Jane is now program director."]), "{audio}"] });
  // No extraction model here: the capture is stored first, extraction waits for one.
  cli();
  const files = readdirSync(join(root, "inbox", "captures"));
  expect(files.length).toBe(1);
  expect(readCapture(root, `inbox/captures/${files[0]}`)).toMatchObject({ text: "Jane is now program director.", fm: { kind: "voice" } });
});
