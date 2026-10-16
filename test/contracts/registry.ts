// SPDX-License-Identifier: AGPL-3.0-only
// Fragile surfaces: the source files where a point fix has the most room to break something
// else (who sees or writes what). Each has one contract suite, test/contracts/<name>.contract.test.ts,
// holding its must-never properties as table rows. A bug fixed on a surface adds a row to its
// contract in the same branch. A new access-core file must be registered here before it merges
// (test/contracts/registry.test.ts fails otherwise).
export const ACCESS_CORE = /^(carve|write|checks|auth|oauth|cell|view|relay|act)\.ts$/; // same set as rule 6 and the slice audit

export const FRAGILE: Record<string, { src: string; why: string }> = {
  carve: { src: "src/carve.ts", why: "computes each agent's slice; a slip leaks a note or a value" },
  view: { src: "src/view.ts", why: "what an agent's read and search return" },
  cell: { src: "src/cell.ts", why: "the per-agent copy the server reads from" },
  write: { src: "src/write.ts", why: "the only path into the brain; routing, flags, commits" },
  checks: { src: "src/checks.ts", why: "the write checks, security ones always on" },
  auth: { src: "src/auth.ts", why: "token to identity" },
  oauth: { src: "src/oauth.ts", why: "client binding to identity, revocation" },
  relay: { src: "src/relay.ts", why: "agent mail between assistants; value matching and holds" },
  act: { src: "src/act.ts", why: "an agent asks to send mail out; approval, sending once, what a body may carry" },
};

export const contractFile = (name: string) => `test/contracts/${name}.contract.test.ts`;
