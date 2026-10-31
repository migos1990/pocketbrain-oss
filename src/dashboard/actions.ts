// SPDX-License-Identifier: AGPL-3.0-only
// What Louis can do from the dashboard. Each action is the same function the CLI calls, so
// the dashboard adds no new way to change the brain; every change is a commit by the owner.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { loadRules } from "../rules";
import { git } from "../git";
import { decideProposal } from "../write";
import { decideHeld, fileTransport, type MailTransport } from "../relay";
import { confirmHeldAnswer, ownerDecide, CoreError } from "../core";
import { revokeTokens } from "../auth";
import { undoRun } from "../upkeep";
import { digest } from "../digest";
import { OWNER } from "../owner";
import { addAgent } from "../addagent";
import { bindClient, revokeClient, listPending, clientsOf, cutAtAuthServer, loadOAuth } from "../oauth";
import { setFact, saveNoteText, saveNoteBody, saveSection, confirmFact, undoOwnerEdit, setEditor, revertCommit, forgetNote, bringBack, markNeverRight, markDone, forgetFact, hideNoteFrom, showNoteTo, setNoteSensitivity } from "./edit";
import { decideCapture } from "../capture";
import { recordReexplain, recordOwnerTime } from "../measure";
import { setMonthlyCap } from "./usage";
import { approveAsk, declineAsk, cancelAsks } from "../asks";
import { approveAction, declineAction, cancelActions, clearLatch } from "../act";
import { approve as approveFix, decline as declineFix } from "../memsync";
import { standingAction, samePersonAction } from "./people";
import { undoAuto } from "../filing";
import { createInvite } from "../invite";
import { refusalWords } from "./labels";

const listPendingIds = (root: string) => listPending(root).map((p) => p.client_id);

export type AgentStatus = "active" | "paused" | "read-only";

export function setAgentStatus(root: string, agent: string, status: AgentStatus): string {
  const rules = loadRules(root);
  const a = rules.policy.agents[agent];
  if (!a || a.inside_wall) throw new CoreError(404, `${agent} isn't an outside agent in policy.yaml`);
  if ((a.status ?? "active") === status) return `${agent} is already ${status}`;
  const file = join(root, "rules", "policy.yaml");
  const doc = YAML.parseDocument(readFileSync(file, "utf8"));
  if (status === "active") doc.deleteIn(["agents", agent, "status"]);
  else doc.setIn(["agents", agent, "status"], status);
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
  git(root, ["add", "rules/policy.yaml"]);
  git(root, ["commit", "-q", "-m", `owner: ${agent} ${status}\n\nKind: kill-switch`, "--", "rules/policy.yaml"], OWNER);
  // A paused or read-only agent has no actions (loadRules); its waiting mail is cancelled now.
  if (status !== "active") cancelActions(root, agent, `${agent} set to ${status}`);
  return status === "active" ? `${agent} is active again` : `${agent} is ${status}`;
}

export interface ActionContext { root: string; transport?: () => MailTransport }

// One dispatcher, so the HTTP layer only parses the form and checks the session.
export function runAction(ctx: ActionContext, action: string, f: Record<string, string>): string {
  const { root } = ctx;
  const need = (k: string) => {
    const v = f[k]?.trim();
    if (!v) throw new CoreError(400, `missing ${k}`);
    return v;
  };
  switch (action) {
    case "ask-approve": return approveAsk(root, need("id"), need("note"), { via: "dashboard", by: OWNER });
    case "ask-decline": return declineAsk(root, need("id"));
    case "act-approve": {
      const hash = need("hash");
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new CoreError(400, "bad hash");
      return approveAction(root, need("id"), hash, { via: "dashboard", by: OWNER });
    }
    case "act-decline": return declineAction(root, need("id"));
    case "act-unlatch": return clearLatch(root, need("agent"));
    case "memsync-approve": return approveFix(root, need("id"));
    case "memsync-decline": return declineFix(root, need("id"));
    case "proposal-accept":
    case "proposal-reject": {
      const file = need("file");
      if (!/^[A-Za-z0-9._-]+\.yaml$/.test(file)) throw new CoreError(400, "bad proposal name");
      // One card per fact: the twins this card showed are answered with it, no others.
      const shown = (f.twins ?? "").split(",").map((t) => t.trim()).filter(Boolean);
      if (shown.some((t) => !/^[A-Za-z0-9._-]+\.yaml$/.test(t))) throw new CoreError(400, "bad proposal name");
      const r = decideProposal(root, file, action === "proposal-accept" ? "accept" : "reject", undefined, shown);
      if (r.outcome === "refused") throw new CoreError(422, refusalWords(r.message));
      return action === "proposal-reject" ? `rejected ${file}` : r.message;
    }
    case "mail-release":
    case "mail-drop":
      return decideHeld(root, (ctx.transport ?? (() => fileTransport(root)))(), need("id"), action === "mail-release" ? "release" : "drop");
    case "dispute-decide":
      return ownerDecide(root, need("id"), need("choice"));
    case "dispute-confirm":
    case "dispute-reject":
      return confirmHeldAnswer(root, need("id"), action === "dispute-confirm" ? "confirm" : "reject");
    case "usage-cap":
      return setMonthlyCap(root, f.monthly ?? "");
    case "agent-status": {
      const s = need("status");
      if (!["active", "paused", "read-only"].includes(s)) throw new CoreError(400, "bad status");
      return setAgentStatus(root, need("agent"), s as AgentStatus);
    }
    // G184: the owner's yes for a new token made in a terminal. A one-time code (an invite: 15
    // minutes, works once, for this agent only); the terminal passes it as --code, or the agent
    // redeems it itself at POST /v1/enroll. The server shows it on the page, never in a URL.
    // G245: the code is for one kind of key (role: none, reader or resolver). G240: the gardener's
    // code is for its rotation only.
    case "token-code": {
      const agent = need("agent");
      const role = f.role === "reader" || f.role === "resolver" ? f.role : undefined;
      const gardener = loadRules(root).policy.agents[agent]?.role === "gardener";
      let inv: ReturnType<typeof createInvite>;
      try { inv = createInvite(root, agent, { minutes: 15, role, ...(gardener ? { purpose: "rotate" as const } : {}) }); } catch (e) { throw new CoreError(400, (e as Error).message); }
      const until = `works once, until ${inv.until.slice(11, 16)} UTC`;
      if (gardener) return `Rotation code for ${agent}: ${inv.code} (${until}). In a terminal: pocketbrain gardener rotate --code ${inv.code} (or, setting it up, pocketbrain tend --managed --apply --code ${inv.code}).`;
      const r = role ? ` --role ${role}` : "";
      return `One-time code for ${agent}${role ? `'s ${role} key` : ""}: ${inv.code} (${until}). In a terminal: pocketbrain token --agent ${agent}${r} --code ${inv.code}${role === "resolver" ? "" : ` (or pocketbrain connect ${agent} --code ${inv.code})`}.${role ? "" : " The assistant can also redeem it itself at POST /v1/enroll."}`;
    }
    case "agent-revoke": {
      const agent = need("agent");
      const ids = clientsOf(root, agent);
      // G352: paused first (no lock needed), so a revoke that fails on a busy invites lock still
      // leaves the agent cut off; it goes back to how it was only once the revoke went through.
      const pa = loadRules(root).policy.agents[agent];
      const was = !pa || pa.inside_wall ? "paused" : pa.status ?? "active"; // only an outside agent has a status to set
      if (was !== "paused") setAgentStatus(root, agent, "paused");
      let n: number;
      try { n = revokeTokens(root, agent); } catch (e) { cancelAsks(root, agent); throw new CoreError(409, `${(e as Error).message} ${agent} is paused meanwhile.`); }
      if (was !== "paused") setAgentStatus(root, agent, was as AgentStatus);
      cancelAsks(root, agent);
      cancelActions(root, agent, "access revoked");
      if (!ids.length || !loadOAuth(root)?.management_client_id) return `revoked ${n} token(s) for ${agent}`;
      void cutAtAuthServer(root, ids).catch(() => {});
      return `revoked ${n} token(s) for ${agent}; removing its connection at the sign-in service too`;
    }
    case "upkeep-undo": {
      const run = need("run");
      if (!/^reflect-[0-9T-]+$/.test(run)) throw new CoreError(400, "bad run id");
      return undoRun(root, run);
    }
    case "fact-set":
      return setFact(root, need("id"), need("attribute"), f.value ?? "", f.as_of);
    case "note-save":
      return saveNoteText(root, need("id"), f.text ?? "");
    case "note-body-save":
      return saveNoteBody(root, need("id"), f.body ?? "");
    case "section-save":
      return saveSection(root, need("id"), need("heading"), f.text ?? "");
    case "fact-confirm":
      return confirmFact(root, need("id"), need("attribute"));
    case "note-forget":
      return forgetNote(root, need("id"));
    case "note-bring-back":
      return bringBack(root, need("hash"));
    case "fact-done":
      return markDone(root, need("id"), need("attribute"));
    case "fact-forget":
      return forgetFact(root, need("id"), need("attribute"));
    case "fact-wrong":
      return markNeverRight(root, need("id"), need("attribute"));
    case "note-hide":
      return hideNoteFrom(root, need("id"), need("agent"));
    case "note-show":
      return showNoteTo(root, need("id"), need("agent"));
    case "note-sensitivity":
      return setNoteSensitivity(root, need("id"), need("sensitivity"));
    case "capture-release":
    case "capture-discard": {
      const r = decideCapture(root, need("file"), action === "capture-release" ? "release" : "discard");
      if (r.outcome === "refused") throw new CoreError(404, r.message);
      return r.message;
    }
    case "owner-undo-auto":
      return undoAuto(root, need("key"));
    case "owner-undo":
      return undoOwnerEdit(root, need("hash"));
    case "editor-set":
      return setEditor(root, need("agent"));
    case "editor-clear":
      return setEditor(root, undefined);
    case "commit-revert":
      return revertCommit(root, need("hash"));
    case "reexplain":
      return recordReexplain(root, need("agent"), need("what"), "dashboard");
    case "minutes": {
      const n = Number(need("minutes"));
      if (!Number.isFinite(n) || n < 0 || n > 600) throw new CoreError(400, "minutes: a number from 0 to 600");
      recordOwnerTime(root, "self", Math.round(n));
      return `noted: ${Math.round(n)} min today`;
    }
    case "oauth-bind": {
      const id = need("client_id");
      if (id.length > 300) throw new CoreError(400, "bad client id");
      if (!listPendingIds(root).includes(id)) throw new CoreError(404, "that connection isn't waiting any more");
      const name = f.name?.trim().slice(0, 60);
      const old = bindClient(root, id, need("agent"), name || undefined);
      return `connection approved: it now connects as ${need("agent")}${old.length ? `. It replaced ${old.length} old connection(s), cut off now; delete ${old.length === 1 ? "it" : "them"} at the sign-in service below` : ""}`;
    }
    case "oauth-new-agent": {
      const id = need("client_id");
      if (id.length > 300 || !listPendingIds(root).includes(id)) throw new CoreError(404, "that connection isn't waiting any more");
      const agent = need("agent").trim();
      const name = f.name?.trim().slice(0, 60) || undefined;
      const slices = need("slices").split(",").map((x) => x.trim()).filter(Boolean);
      try { addAgent(root, { agent, slices, name }); } catch (e) { throw new CoreError(400, (e as Error).message); }
      bindClient(root, id, agent, name);
      return `${agent} added as a trial agent; that connection now connects as ${agent}`;
    }
    case "oauth-decline":
      revokeClient(root, need("client_id"));
      return "connection declined";
    case "standing-approve":
    case "standing-set":
    case "standing-dismiss":
    case "standing-pin":
    case "standing-undismiss":
      return standingAction(root, action, f, need);
    case "same-person-merge":
    case "same-person-not":
    case "same-person-undo":
      return samePersonAction(root, action, f, need);
    case "digest":
      return `digest written: ${digest(root).needsLouis} item(s) need you`;
  }
  throw new CoreError(404, `no action ${action}`);
}
