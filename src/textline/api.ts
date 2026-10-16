// SPDX-License-Identifier: AGPL-3.0-only
// The Instinct side of the text channel, served under /v1/owner/ (legacy alias /v1/louis/) to one
// agent only: the owner_channel in policy.yaml (legacy louis_channel; default: the resolver).
// Instinct's own 5-minute routine:
//   GET  /v1/owner/outbox              texts waiting for the owner, plus the poller's heartbeat
//   POST /v1/owner/outbox/{id}/sent    after texting one ({message_id})
//   POST /v1/owner/replies             each reply from the owner ({message_id, text, in_reply_to?})
// If the GET fails, or the heartbeat is old, the hub or its poller is down: Instinct texts
// the owner that itself (see docs/text-channel.md). Replies posted here are relayed, so poll.ts
// only lets them decide non-private items or tighten.
import { loadRules, ownerName } from "../rules";
import { tokenRole } from "../tokenrole";
import { CoreError } from "../core";
import { loadEscalation } from "./policy";
import { lastHeartbeat } from "./items";
import { outbox, markOutbox, recordPull, queueReply } from "./transport";
import { retireAnsweredTexts } from "./poll";

export function louisChannel(root: string): string | undefined {
  const p = loadRules(root).policy;
  return p.owner_channel ?? p.louis_channel ?? p.resolver;
}

export function louisApi(root: string, agent: string, method: string, rawPath: string, body: Record<string, unknown>, now = new Date()): unknown {
  const rules = loadRules(root), O = ownerName(rules);
  const path = rawPath.replace(/^\/v1\/louis\//, "/v1/owner/");
  if (louisChannel(root) !== agent) throw new CoreError(403, `only the agent that texts ${O} uses /v1/owner`);
  if (tokenRole(agent) === "reader") throw new CoreError(403, "this is a reader token: disputes and the owner's texts take the resolver token");
  const status = rules.policy.agents[agent]?.status;
  if (method === "GET" && path === "/v1/owner/outbox") {
    recordPull(root);
    retireAnsweredTexts(root);
    const hb = lastHeartbeat(root);
    const cadence = loadEscalation(root).cadence_minutes;
    const pollerOk = !!hb && now.getTime() - new Date(hb).getTime() < 3 * cadence * 60_000;
    return {
      texts: outbox(root).filter((m) => m.status === "queued").map(({ id, text, at }) => ({ id, text, at })),
      poller: { ok: pollerOk, heartbeat: hb ?? null, cadence_minutes: cadence },
      instructions: `Text each one to ${O} exactly as written, then POST /v1/owner/outbox/{id}/sent. Post every reply ${O} sends to /v1/owner/replies with its message id. If this call fails or poller.ok is false twice in a row, text ${O}: pocketBrain hub not answering.`,
    };
  }
  const sent = path.match(/^\/v1\/owner\/outbox\/([A-Za-z0-9_-]+)\/sent$/);
  if (method === "POST" && sent) {
    if (!markOutbox(root, sent[1], "sent", body.message_id ? String(body.message_id).slice(0, 120) : undefined)) throw new CoreError(404, `no text ${sent[1]}`);
    return { id: sent[1], status: "sent" };
  }
  if (method === "POST" && path === "/v1/owner/replies") {
    if (status === "read-only") throw new CoreError(403, `${agent} is read-only by ${O}; replies aren't relayed`);
    const message_id = String(body.message_id ?? "").trim(), text = String(body.text ?? "").trim();
    if (!message_id || !text) throw new CoreError(400, "a reply needs message_id and text");
    if (text.length > 500) throw new CoreError(413, "a reply is a few words; this is too long");
    queueReply(root, { id: message_id.slice(0, 120), text, at: String(body.received_at ?? now.toISOString()), in_reply_to: body.in_reply_to ? String(body.in_reply_to) : undefined });
    return { queued: true, note: `applied on the poller's next tick; ${O} gets a confirmation text` };
  }
  throw new CoreError(404, `no route ${method} ${path}`);
}

export const LOUIS_OPENAPI = {
  "/v1/owner/outbox": { get: { summary: "Owner channel only: texts waiting to go to the owner, and the poller heartbeat. Call every 5 minutes. (/v1/louis/... is an alias.)", responses: { "200": { description: "{texts, poller}" } } } },
  "/v1/owner/outbox/{id}/sent": { post: { summary: "Owner channel only: mark one text as sent ({message_id})", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "sent" } } } },
  "/v1/owner/replies": { post: { summary: "Owner channel only: relay one reply from the owner ({message_id, text, in_reply_to?, received_at?})", responses: { "200": { description: "queued" } } } },
};
