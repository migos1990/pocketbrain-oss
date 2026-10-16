// SPDX-License-Identifier: AGPL-3.0-only
// Voice notes (docs/capture.md, "Voice notes"): an audio file in the drop folder, or given to
// `capture --voice`, becomes the text of a voice capture. Bring-your-own transcriber, off until
// the owner names one in rules/models.yaml step capture.transcribe:
//   provider: command    a local binary (whisper.cpp's whisper-cli or similar); the audio stays
//                        on this machine. {audio} in the argument list is the file's path.
//   provider: openai | openai-compatible   POST <base_url>/audio/transcriptions with a key;
//                        metered and capped like any model step.
// The transcript goes through capture() like a dictated one (secrets blanked, limits, injection
// hold, dedupe). The audio itself is never copied into the brain: it stays in the drop folder.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { readYaml } from "./rules";
import { KEY_ENV } from "./model";
import { pausedReason, record } from "./usage";

export const TRANSCRIBE_STEP = "capture.transcribe";
export const AUDIO = new Set([".m4a", ".mp3", ".wav", ".caf", ".aac", ".ogg", ".opus", ".amr", ".flac", ".webm"]);
const MAX_BYTES = 25 * 1024 * 1024; // the hosted APIs' own upload limit
const OFF = "audio: transcription is off. Name a transcriber in rules/models.yaml step capture.transcribe (docs/capture.md, Voice notes), or save the transcript as .txt";

export interface TranscribeConfig {
  provider: "command" | "openai" | "openai-compatible";
  command?: string[]; // provider command: argv, with {audio} where the file goes
  model?: string; // hosted: default whisper-1
  base_url?: string;
  api_key_env?: string;
  language?: string; // hosted: ISO-639-1 hint
  max_bytes?: number;
  timeout_ms?: number; // default 5 min
}

// Only the step itself turns transcription on: models.yaml's default never does, because the
// default is a chat model and sending audio out is a choice the owner makes on its own.
export function transcribeConfig(root: string): TranscribeConfig | undefined {
  const doc = readYaml<{ steps?: Record<string, TranscribeConfig> }>(join(root, "rules", "models.yaml"), {});
  return doc.steps?.[TRANSCRIBE_STEP] ?? undefined;
}

export const maxAudioBytes = (root: string) => transcribeConfig(root)?.max_bytes ?? MAX_BYTES;

// whisper.cpp prints "[00:00:00.000 --> 00:00:04.000]   text" lines and tags such as
// [BLANK_AUDIO] or (music) for silence; keep only the words.
export function cleanTranscript(raw: string): string {
  return raw.split(/\r?\n/)
    .map((l) => l.replace(/^\s*\[\d{2}:\d{2}[:.\d]*\s*-->\s*[\d:.]+\]\s*/, "").replace(/\[[A-Z_ ]+\]|\[(music|silence|inaudible|applause|laughter)\]|\((music|silence|inaudible|applause|laughter)\)/gi, ""))
    .map((l) => l.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
let fetchFn: Fetch | undefined;
// Tests swap the hosted API.
export function useTranscribeFetch(f: Fetch | undefined) { fetchFn = f; }

export type Transcriber = (path: string) => Promise<string>;

// The transcriber rules/models.yaml names, or why there is none (off, or misconfigured).
export function transcriberFor(root: string, by = "owner"): Transcriber | string {
  const c = transcribeConfig(root);
  if (!c) return OFF;
  const timeout = c.timeout_ms ?? 300_000;
  const done = (text: string) => { const t = cleanTranscript(text); if (!t) throw new Error("no speech heard in it"); return t; };

  if (c.provider === "command") {
    const argv = (c.command ?? []).map(String);
    if (!argv.length || !argv.some((a) => a.includes("{audio}"))) return "capture.transcribe: command needs an argument list with {audio} where the file goes";
    const home = (a: string) => a.replace(/^~(?=$|\/)/, homedir());
    return async (path) => {
      // No shell: the path is one argument, whatever its name holds.
      const p = Bun.spawn(argv.map((a) => home(a).replaceAll("{audio}", path)), { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const timer = setTimeout(() => p.kill(), timeout);
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]).finally(() => clearTimeout(timer));
      if (code !== 0) throw new Error(`${basename(argv[0])} exited ${code}: ${err.trim().split("\n").slice(-3).join(" ").slice(0, 300)}`);
      return done(out);
    };
  }

  if (c.provider === "openai" || c.provider === "openai-compatible") {
    const keyEnv = c.api_key_env ?? (c.provider === "openai" ? KEY_ENV.openai : undefined);
    const model = c.model ?? "whisper-1";
    const url = `${(c.base_url ?? "https://api.openai.com/v1").replace(/\/$/, "")}/audio/transcriptions`;
    return async (path) => {
      const why = pausedReason(root, TRANSCRIBE_STEP);
      if (why) throw new Error(why);
      const key = keyEnv ? process.env[keyEnv] : undefined;
      if (keyEnv && !key) throw new Error(`set ${keyEnv} for ${c.provider} transcription`);
      const form = new FormData();
      form.append("file", new Blob([readFileSync(path)]), basename(path));
      form.append("model", model);
      form.append("response_format", "text");
      if (c.language) form.append("language", c.language);
      const t0 = performance.now();
      const meter = (outcome: "ok" | "error", text = "") => record(root, { step: TRANSCRIBE_STEP, by, outcome, provider: c.provider, model,
        tokens_in: 0, tokens_out: Math.ceil(text.length / 4), estimated: true, seconds: Math.round((performance.now() - t0) / 10) / 100 }, model);
      let text: string;
      try {
        const r = await (fetchFn ?? ((u: string, i: RequestInit) => fetch(u, i)))(url, { method: "POST", headers: key ? { authorization: `Bearer ${key}` } : {}, body: form, signal: AbortSignal.timeout(timeout) });
        if (!r.ok) throw new Error(`${c.provider} ${r.status}: ${(await r.text()).slice(0, 300)}`);
        text = await r.text();
        // Some servers answer JSON whatever response_format says.
        if (/^\s*\{/.test(text)) { try { text = String(JSON.parse(text).text ?? ""); } catch { /* plain text after all */ } }
      } catch (e) { meter("error"); throw e; }
      meter("ok", text);
      return done(text);
    };
  }
  return `capture.transcribe: provider ${String((c as { provider?: unknown }).provider)} can't transcribe; use command, openai or openai-compatible`;
}
