# How innovative is pocketBrain? (assessed 2026-10-08)

> **Design record from 2026-10-08, kept for history.** It was written before the code and is not kept up to date. Current behaviour is in the [README](../../README.md), [CLAUDE.md](../../CLAUDE.md) and the guides in [docs/](..).

Blunt version: about a third of the design is novel, and it is the third that matters. The rest is assembly of parts that exist, which is fine for a prototype as long as we don't pretend otherwise.

## Piece by piece

| Piece | Verdict | Evidence |
|---|---|---|
| Markdown + frontmatter in git as the memory, derived index, hybrid search | **Not new.** | GBrain and Basic Memory both do exactly this; GBrain adds a graph, reranker and `think`. We should copy, not reinvent. |
| MCP gateway with OAuth 2.1 and per-agent tokens | **Not new.** | GBrain mints per-agent OAuth clients. Enterprise gateways (MintMCP, Peta, open-source `mcp-gateway-verify-vault`) do per-agent, per-tool policy with audit. |
| PII tokenization at a gateway | **Known technique, new target.** | LLM gateways (Future AGI, WSO2, Skyflow) tokenize PII before prompts leave an enterprise perimeter. Nobody I found does it for a consumer against their *own* assistants, with per-agent stable tokens and detokenization on the way back. The mechanism is standard; the direction (protecting the user from the agent vendor) is not. |
| Staleness, conflict and consolidation (reflect loop) | **Active research area, no consumer product.** | Hindsight (vectorize.io) has freshness grading and a reflect agent; agentmem does conflict and staleness scoring for coding agents; a May 2026 Hindsight post says most memory systems are "silent about consolidation policy". Nothing applies this to a personal brain shared by hosted assistants. |
| Agent-to-agent comms through the memory, with an auditor | **Partially new.** | A2A-style protocols and "auditor" rule sets for agent mailboxes exist as ideas and ad-hoc conventions. A relay that inspects each message against the sender's and recipient's memory grants is something I found no prior art for. |
| Default-deny, per-agent, code-enforced sensitivity views for an end user | **This is the novel part.** | Every product that has per-agent access control (GBrain, Mem0, Letta, enterprise gateways) assumes the operator controls the agents. The products aimed at users (Notion, OpenMemory, Memxus, MemX) give a single shared view with page-level sharing at best. Policy papers (New America, 2026) ask for "compartmentalized memory with revocable consent" and name no product that delivers it. |
| User-controlled memory, vendor-controlled agents, as the whole framing | **Novel as a product thesis.** | MacPaw's "Portable Memory" proposal and the `.aim` prior-art filing argue for it at the standards level. No shipping product combines portability, per-agent policy, tokenization and audit for this user. |

## What that means

1. **The moat is not technology.** Any of the pieces could be built by GBrain in a week. The moat is the point of view: treating the assistant vendor as the untrusted party, and designing every feature (grants, tokens, auditor, reflect) from the user's side of that line. GBrain's own README says memories default to brain-wide visibility because its user runs the agents. We start from the opposite assumption.
2. **Reuse aggressively.** Storage format, indexing and search should be GBrain-compatible or Basic Memory-compatible. Spending effort there is spending it on the non-novel third.
3. **Where to put the effort:** the policy engine with filter-before-rank, per-agent tokenization, the reflect loop, and the auditor. Those are the parts with no off-the-shelf answer and the parts that make the thesis real.
4. **Risk:** the big vendors are moving. Anthropic, Google and OpenAI shipped one-way memory import/export in spring 2026. If one of them ships a "bring your own memory" connector with per-app permissions, the framing becomes mainstream and the differentiator shrinks to being open and self-hosted. That is still a position, but a narrower one.

## Sources

- GBrain: https://github.com/garrytan/gbrain
- Basic Memory: https://github.com/basicmachines-co/basic-memory
- MintMCP agent gateways: https://www.mintmcp.com/blog/agent-gateways-ai-startups
- mcp-gateway-verify-vault: https://github.com/iamidentity-ai/mcp-gateway-verify-vault
- New America, AI agents and memory: https://www.newamerica.org/insights/ai-agents-and-memory/
- PII redaction at LLM gateways: https://futureagi.com/blog/best-ai-gateways-pii-redaction-llm-calls-2026/
- Hindsight on consolidation: https://hindsight.vectorize.io/blog/2026/05/21/agent-memory-consolidation
- Hindsight on staleness: https://hindsight.vectorize.io/blog/2026/06/17/freshness-aware-memory
- MacPaw Portable Memory proposal: https://research.macpaw.com/publications/portable-memory.md
- Memxus: https://mcp.so/servers/memxus-remote-mcp
- MemX: https://memx.app/blog/can-you-export-your-ai-memory/
