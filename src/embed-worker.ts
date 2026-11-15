// SPDX-License-Identifier: AGPL-3.0-only
// The worker thread semantic search runs its model in (src/semantic.ts), so a model call never
// blocks the hub's event loop. Its first message names the model dir (a worker sees the
// environment the process started with, not the one the hub thread has now, G910); it loads the
// model from there with downloads off, and answers {id, v} (one vector per text) or {id, error}.
// It receives texts only from the hub.
import { loadLocalEmbedder, type Embedder } from "./semantic";

declare const self: Worker;
let model: Promise<Embedder> | undefined;
self.onmessage = async (ev: MessageEvent<{ dir: string } | { id: number; texts: string[] }>) => {
  if ("dir" in ev.data) {
    model = loadLocalEmbedder({ dir: ev.data.dir });
    model.catch(() => undefined); // each request reports the error
    return;
  }
  const { id, texts } = ev.data;
  try {
    if (!model) throw new Error("the model dir was not given");
    postMessage({ id, v: await (await model).embed(texts) });
  } catch (e) { postMessage({ id, error: String((e as Error)?.message ?? e) }); }
};
