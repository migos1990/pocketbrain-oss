// SPDX-License-Identifier: AGPL-3.0-only
// The child process `pocketbrain search setup` runs the model download and load check in
// (setupInChild in src/semantic.ts). It writes one line per event with writeSync, so each line is
// out before ONNX Runtime's teardown at exit, which aborts on macOS, can cut the process short.
import { writeSync } from "node:fs";
import { setupModel } from "./semantic";

const say = (l: string) => writeSync(1, `${l.replace(/\n/g, " ")}\n`);
try {
  const r = await setupModel((file) => say(`got ${file}`));
  say(`done ${JSON.stringify(r)}`);
  process.exit(0);
} catch (e) {
  say(`error ${(e as Error)?.message ?? e}`);
  process.exit(1);
}
