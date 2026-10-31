// SPDX-License-Identifier: AGPL-3.0-only
// The worker thread semantic search runs its model in (src/semantic.ts), so a model call never
// blocks the hub's event loop. It loads the model from the model dir with downloads off, and
// answers {id, v} (one vector per text) or {id, error}. It receives texts only from the hub.
import { loadLocalEmbedder } from "./semantic";

declare const self: Worker;
const model = loadLocalEmbedder();
model.catch(() => undefined); // each request reports the error
self.onmessage = async (ev: MessageEvent<{ id: number; texts: string[] }>) => {
  const { id, texts } = ev.data;
  try { postMessage({ id, v: await (await model).embed(texts) }); } catch (e) { postMessage({ id, error: String((e as Error)?.message ?? e) }); }
};
