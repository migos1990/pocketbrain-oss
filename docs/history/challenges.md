# pocketBrain: the case against (a brainstorm)

> **Design record from 2026-10-08, kept for history.** It was written before the code and is not kept up to date. Current behaviour is in the [README](../../README.md), [CLAUDE.md](../../CLAUDE.md) and the guides in [docs/](..).

Written 2026-10-08 to argue with [README.md](README.md) and [architecture.md](architecture.md). Each challenge is numbered so you can push back on one by number. Where I say "inferred", I'm reasoning, not citing.

---

## The one number that reframes everything

The Notion brain today (the Notion mapping (private, not published)) holds **about 67 content rows** (7 decisions, 19 projects, 24 people, 13 notes, 4 money, 0 receipts) plus ~30 agent-capability rows.

That is roughly 20 to 40k tokens. It fits, whole, in the context window of every assistant you use. The architecture proposes, for that corpus: an OAuth 2.1 authorization server, Cedar policy compiled from YAML, hybrid FTS5 + vector search with RRF, a hash-chained audit log with OpenTelemetry, a tokenization vault with per-agent HMAC keys, an LLM auditor with per-agent baselines, a reflect loop, agent mail with leases, A2A guest endpoints and a passkey control panel. Nine-plus milestones.

Almost every challenge below is a version of: **the design is sized for a brain you don't have yet, and defends against an adversary you haven't met yet.**

---

## A. Premises

### 1. Is the pain "memory" or "agent churn"?
You rebuild memory because you keep adding assistants (Instinct, Town, Muse "on trial", Claude). That's a choice, and in 2026 it may be a phase: assistants are consolidating and vendors have started shipping memory import/export. If you settled on two assistants in a year, how much of this problem is left?

*Counter you'll probably make:* churn is permanent, new assistants will keep coming. Fine, but then the durable investment is the **format** (Markdown + frontmatter in git), not the gateway. The format survives any outcome; the gateway only pays off if the multi-assistant world persists *and* each assistant supports custom remote MCP.

### 2. The gating fact is still unanswered
Architecture question 1 asks whether Instinct, Town and Muse can connect to a custom remote MCP server with OAuth. Everything downstream depends on it, and it's an hour of testing. If one of them can't, that assistant gets a pasted file anyway, and the gateway serves fewer agents than the design assumes. **This should be answered before another line of design.**

### 3. Will they actually call it?
Hosted assistants use MCP tools when prompted or when their instructions say so. The hard problem in cross-assistant memory is usually not storage, it's *recall timing*: getting each assistant to pull context at the right moment and write back at the right moment. The Notion notes already show this ("read the start page every session", procedures "each agent rediscovers"). The proposal doesn't specify this layer at all; `capabilities()` helps only once the agent decides to call something. *Inferred:* this is where the experience will succeed or fail, not in ranking quality.

### 4. Who exactly is the adversary?
The control stack (kill switches, canaries, scraping detection, tokenization, auditor) treats your own chosen assistants as potentially hostile. Two problems:

- **The real boundary is the union of everything an agent can reach.** If Town reads your Gmail and calendar, hiding `money/` from Town while it reads the bank's emails is theater. The policy needs to be compared against each agent's other connectors, or it protects less than it seems to. Which of your agents have Gmail/Drive access today?
- **The vendor is the actual exposure.** Whatever the gateway returns goes into the vendor's cloud and model. Fine-grained policy reduces *what* leaves, but the realistic risk is "vendor retains/logs it" or "prompt injection makes the agent leak it", not "Muse starts scraping". Canaries and minimization address that; behavioural baselines over four low-volume agents mostly won't (see 12).

---

## B. Portability vs. control: do they actually conflict?

### 5. Less than the README implies, but in a different place
Format portability and access control live at different layers, so they mostly don't fight. The real tension is elsewhere:

- **"git clone moves the brain" stops being true** as state accumulates outside the Markdown: token maps (encrypted vault), audit log, approvals, salience scores, `disputed` states, OAuth clients, auditor baselines, suppressions learned from your dismissals. Each is reasonable; together they mean the brain is the repo *plus* a database that also needs backing up and migrating. That's GBrain's "DB-only state" caveat, which the README cites against GBrain.
- **Policy only holds if agents never touch the repo.** "Any tool can read it without pocketBrain" is also "any tool with repo access bypasses every policy". Today Claude Code with filesystem access is exactly that tool. Decide which agents are "inside the wall" (see the repo directly, fully trusted) and which are outside (gateway only), and stop pretending one model covers both.
- **Encryption of `secret` notes and tokenization cut portability on purpose.** That's a fine trade, just name it.

---

## C. Build vs. adopt

### 6. "Filter before ranking" is the wrong reason to build
Option B was rejected because you can't guarantee filter-before-ranking through someone else's search. At 67 notes, two cheap answers make that moot:

- **Partition instead of filter.** Keep 2 or 3 physical brains by trust tier (e.g. `open`, `personal`, `private`), and mount the ones an agent is allowed to see. Each can be an unmodified Basic Memory or GBrain instance. Access control becomes "which servers is this agent connected to", which is auditable by looking at a list. You lose some cross-tier links; with this corpus there are few.
- **Compile views instead of evaluating policy at runtime.** `build --agent town` produces a filtered, read-only folder (or one Markdown file) per agent from `policy.yaml`. Policy becomes a build step you can diff and unit-test. No Cedar, no runtime authz bugs, no query-time leakage, because the hidden notes physically aren't in Town's view.

Either one gets you per-agent default-deny with a fraction of the code.

### 7. Writing your own OAuth server is the riskiest line in the design
The gateway "is its own authorization server" with dynamic client registration, for a single user. Self-built auth is the most likely way this system actually gets breached, and it guards the whole brain. If remote OAuth is needed, use a hosted AS (WorkOS, Stytch, Cloudflare Access, Auth0 free tier) from day one, not "later". *Inferred:* the security machinery as designed is a larger attack surface than the threats it detects.

### 8. Hosted memory APIs deserve one more look, for a narrower job
Mem0/Zep were dismissed as "memory engines for apps you build". True for the brain. But for the *reflect loop's* hard part (temporal facts, "what was true in March", conflict detection), Graphiti does that already. Consider using it as a derived engine behind your files, the way the index is derived, rather than writing a conflict judge.

---

## D. Can one person keep this alive?

### 9. Your own workspace is the evidence
From the Notion mapping: "Agent safety and tests" has **20 weekly test cases and an empty test log**. Receipts and expenses has a full schema and **0 rows**. That's not a criticism of you, it's the base rate: designing process is fun, operating it weekly isn't. pocketBrain adds more operations, not fewer: approving proposals, reading the reflect digest, triaging auditor findings, answering `ask` prompts, rotating keys, upgrading the box, keeping MCP/OAuth up with spec changes.

### 10. Approval fatigue turns safety into a rubber stamp
Default write mode is `propose`. Town syncs daily. Four agents, plus reflect findings, plus auditor flags, plus step-up `ask` on sensitive reads. If that's 15 items a day, by week three you approve without reading, and the safety is cosmetic while the friction is real. The architecture says "review must be fast or it dies", agreed, but the cheapest fast review is *fewer reviews*: direct writes into an agent's own area (git makes them reversible), review only cross-area or sensitive writes.

### 11. Count the moving parts
Gateway, OAuth AS, Cedar compiler, index, embedding API, vault, audit chain, auditor worker + LLM, upkeep worker + LLM, mail, panel with passkeys, push/Telegram channel, VPS, GitHub sync. Fourteen things that can break for one user. A useful test: which of these would you notice was broken within a week? Anything you wouldn't notice is a liability, not a feature.

---

## E. Over-engineered

### 12. Behavioural auditor with baselines
Four agents, low call volume, irregular use. There isn't enough data for a baseline to mean anything, and an LLM judge on sparse summaries will mostly produce noise you'll learn to ignore. **Keep canary notes** (cheap, high signal, as the doc says) and the hash-chained log; drop baselines and the LLM judge until there's volume.

### 13. Tokenization
Clever, and the most likely to be abandoned:
- It breaks usefulness in exactly the tasks agents do: emailing, booking, scheduling all need the real value, which means an `ask` per action (see 10).
- **Detokenization has a hole.** The design detokenizes outputs that come back *through the gateway* (`remember`, mail). But most agent output goes to you through the vendor's own chat UI, which the gateway never sees. "Dinner with [[person:7f3a]]" will show up in Instinct's chat, tokenized.
- Context re-identifies, as the doc admits. For a personal brain, "my co-founder at Lumen Labs" is the name.
Simpler: don't give a low-trust agent the note at all (partition or view), or give it a hand-written redacted summary.

### 14. Agent mail, claims/leases, A2A, guest identities, memory passport
Four of your own agents coordinating is a real need; building a mail system with leases, threading, read receipts and a cross-vendor protocol is not. A `comms/` folder of dated files written through the same write path gives you authenticated authorship (the token) and an audit trail. A2A and guest sharing have no named user yet: who is the first person you'd share a slice with, and for what?

### 15. Hybrid vector + keyword search with RRF
At 67 notes, `grep` plus "send the whole granted view" beats any ranking. Add search when the corpus outgrows a context window, not before.

---

## F. Under-specified

### 16. What is a "fact"?
Conflict detection, supersede, shelf life and freshness all hinge on the unit of truth. Is it a note? A frontmatter field? A sentence inside a note? The Notion `Fact key` works because one row is one fact. A Markdown note about a person holds dozens of facts with different shelf lives (role: 6 months, phone: years, "met at demo day": forever). The design treats notes and facts interchangeably; it needs to pick.

### 17. Concurrency and the git write path
The hosted gateway commits and pushes; you might edit in Obsidian on your laptop; Town syncs daily. Who wins on conflict? Does the gateway pull before every read? What happens to the index when you force-push? Not hard, but unstated, and it's where "git as truth" bites in practice.

### 18. How each assistant is instructed
For each of Instinct, Town, Muse and Claude: what goes in its system prompt or custom instructions so it calls `context_pack` at the start and `remember` at the right moments? That text is part of the product, and it's per vendor.

### 19. Success criteria
What would tell you, in a month, that pocketBrain is working? "I didn't re-explain X to Muse"? Fewer duplicate rows? Without a measure, the build order will keep favouring what's interesting to build over what fixes the pain.

---

## G. Order of work, if you build anyway

The architecture itself calls upkeep "the heart" (the brain notices when it's wrong). The build order puts it after OAuth, the panel, the auditor and tokenization. If truthfulness is the real value, and a 67-note brain is mostly at risk of going stale rather than being scraped, reorder:

1. Format + Notion export (M0, M9 pulled forward).
2. Per-agent compiled views (challenge 6) served over whatever each assistant supports.
3. One write path into `inbox/`, direct writes to own area.
4. Freshness labels and a staleness/conflict check on write, rules only.
5. Canary notes.
6. Then, only if 1 to 5 are used daily for a month: remote OAuth via a hosted AS, panel, kill switches.

Everything else waits for a named need.

---

## H. The smallest experiment that proves or kills it

**Week 0, one evening: the zero-code test.**
Export the Notion brain to Markdown (one file per row, the frontmatter you already have). Concatenate a per-agent view into one file. Paste it into each assistant's project knowledge or custom instructions, with a short "how to use this and when to propose an update" block.

**Then use them normally for one week and log three things:**
- Times you had to re-explain context to an assistant (the pain this is supposed to fix).
- Times an assistant wanted to write something back, and what.
- Times you wished an assistant *couldn't* see something in its view.

**Day 1, in parallel:** check whether each hosted assistant can connect a custom remote MCP server (try Basic Memory or GBrain behind a tunnel, unmodified).

**Kill / pivot criteria:**
- Re-explaining drops to near zero with pasted files → the product is "a git repo + an export script per vendor". Build that and stop.
- Re-explaining stays high because files go stale between pastes → you need live read access. Build the read side (views over MCP) only.
- Write-backs are frequent and valuable → build the single write path.
- You never once wished an agent couldn't see something → the policy engine, tokenization and auditor are optional; keep canaries.
- Two or more assistants can't connect a custom remote MCP → the gateway is not the center of the design; the file format and exporters are.

---

## Where I think the proposal is right

So this isn't one-sided:
- Files in git as the truth and a derived index is the correct core, and it's the part that survives every scenario above.
- Gateway-stamped identity instead of typed `Author agent` labels fixes a real, observed problem (test case 3).
- Freshness at read time ("stale since 2026-09-01") is the single most useful idea in the documents, and it's cheap.
- Canary notes are the best cost/signal ratio of any control proposed.
- "Messages are data, never instructions" is already your rule and should stay central.

## Questions to argue back on

1. How many minutes a week do you actually lose rebuilding context today?
2. Can Instinct, Town and Muse each connect a custom remote MCP server?
3. Which agents already have Gmail, calendar or Drive access?
4. Name one concrete time an agent saw something it shouldn't have.
5. Who is the first person you'd share a slice of the brain with?
6. Would you be happy if pocketBrain were 300 lines of code and a folder?
