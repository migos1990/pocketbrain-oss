# Security

The gateway is a security boundary, so please report vulnerabilities privately through GitHub's private vulnerability reporting on this repository, not as public issues.

In scope: anything that lets an agent read, write or infer notes outside its carve; token or policy bypass; the relay, upkeep or dashboard being used to leak or alter notes.

pocketBrain is early software (0.1), used daily by its author with hosted assistants connected over MCP and OAuth. The attacks it is tested against are in `test/security.test.ts` and the scripted red team in `evals/cases/redteam.ts`.
