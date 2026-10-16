---
name: release
description: Ordered release checklist for pocketBrain (public repo, npm, hosted door); ends with the launch-blockers critic
disable-model-invocation: true
---

Run in order; each step shows its command and result line. Stop at the first failure. Nothing here pushes, publishes or tags: those wait for the owner's own word.

1. Main is green: `bun scripts/gate.ts` on main's tip finds nothing, and the latest CI run on main passed (`gh run list --branch main -L 1`).
2. Public scrub: `sh scripts/check-public.sh <private denylist>` passes, `gitleaks git --redact .` passes, no film tooling or history docs the owner chose to drop (cleanup audit).
3. Fresh history: the public repo starts from a new root commit (not this repo's history); diff its tree against main's tree and show it is identical apart from what step 2 dropped.
4. Licence: LICENSE (AGPL-3.0) and CLA.md present; the lawyer pass is recorded as done in the backlog.
5. Package contents: `npm pack --dry-run` lists only what `files` in package.json names; `test/init.test.ts` passes.
6. Clean install: on a machine (or VM) that never had it, `install.sh`, then `pocketbrain init` from `examples/seed/`, `pocketbrain doctor` clean.
7. Backup drill: `pocketbrain backup drill` passes on a copy (`docs/backup.md`).
8. Outbound hosts: `test/outbound.test.ts` passes and `scripts/outbound-hosts.txt` matches the privacy page.
9. Docs: README quickstart run start to finish as written; `test/docs.test.ts` passes.
10. Launch blockers: hand the results to the `launch-critic` agent. Its list is the release verdict: SHIP only when it lists nothing blocking.
