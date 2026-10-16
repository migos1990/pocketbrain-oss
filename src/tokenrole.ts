// SPDX-License-Identifier: AGPL-3.0-only
// Token roles (eval gap G18). A core agent's pasted token can be split in two: a reader token
// (its slice below private, no dispute or owner-channel routes; the one a vendor's API config
// holds) and a resolver token (only those routes). A token with no role works as before.
// The server runs each request under its token's role; the read and write paths ask for it here,
// so the reader's cap holds in every carve made for that agent during the request.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Sensitivity } from "./brain";
import { sensitivityRank } from "./brain";

export type TokenRole = "reader" | "resolver";
export const TOKEN_ROLES: readonly TokenRole[] = ["reader", "resolver"];
// The highest level a reader token sees: everything below private.
export const READER_CEILING: Sensitivity = "personal";

const current = new AsyncLocalStorage<{ agent: string; role: TokenRole }>();

export function withTokenRole<T>(agent: string, role: TokenRole | undefined, fn: () => T): T {
  return role ? current.run({ agent, role }, fn) : current.exit(fn);
}

// Outside the role, for work done on the agent's behalf that isn't a read for this token (cells).
export const withoutTokenRole = <T>(fn: () => T): T => current.exit(fn);

export function tokenRole(agent: string): TokenRole | undefined {
  const s = current.getStore();
  return s?.agent === agent ? s.role : undefined;
}

export function capForRole(agent: string, ceiling: Sensitivity): Sensitivity {
  return tokenRole(agent) === "reader" && sensitivityRank(ceiling) > sensitivityRank(READER_CEILING) ? READER_CEILING : ceiling;
}
