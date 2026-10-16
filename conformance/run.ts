// SPDX-License-Identifier: AGPL-3.0-only
// Run the Memory Passport conformance suite against any server loaded with conformance/fixture.json.
//   bun conformance/run.ts <base url> --full <token> --limited <token> [--resolver <token>] [--waiting <token>] [--fixture <file>]
// --resolver is a route-limited credential for the full agent, --waiting one for a sign-in the
// owner hasn't approved; without them, their checks (P1, P2, Q1) are skipped.
// Exits 1 when a MUST check fails. It writes to the server (W1 to W5): use a throwaway copy.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runConformance, report, type Fixture } from "./suite";

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const base = args[0]?.replace(/\/$/, "");
const fullToken = arg("--full"), limitedToken = arg("--limited");
if (!base || base.startsWith("--") || !fullToken || !limitedToken) {
  console.error("usage: bun conformance/run.ts <base url> --full <token> --limited <token> [--resolver <token>] [--waiting <token>] [--fixture <file>]");
  process.exit(2);
}
const fx: Fixture = JSON.parse(readFileSync(arg("--fixture") ?? join(import.meta.dir, "fixture.json"), "utf8"));
const results = await runConformance((path, init) => fetch(`${base}${path}`, init), fx,
  { name: fx.agents.full.name, token: fullToken }, { name: fx.agents.limited.name, token: limitedToken }, { resolver: arg("--resolver"), waiting: arg("--waiting") });
console.log(report(results));
process.exit(results.some((r) => r.level === "MUST" && !r.ok) ? 1 : 0);
