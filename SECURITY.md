# Security

The gateway is a security boundary, so please report vulnerabilities privately through GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"), not as public issues.

In scope: anything that lets an agent read, write or infer notes outside its carve; token or policy bypass; the relay, upkeep, Gardener or dashboard being used to leak or alter notes.

pocketBrain is a prototype with one real user, so expect an answer in days, not hours. The attacks it is tested against are in `test/security.test.ts` and the scripted red team in `evals/cases/redteam.ts`.
