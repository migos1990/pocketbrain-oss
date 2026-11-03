#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// pocketbrain CLI. The brain folder comes from --brain, $PB_BRAIN, or the current directory.
import { findOverlaps } from "./overlap";
import { catchUpDiary } from "./diary-catchup";
import { forgetPerson, planForget, undoForget } from "./forget";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { supportBundle } from "./support";
import { join, resolve, relative, extname, dirname } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import { loadBrain, saveParseSnapshots } from "./brain";
import { loadRules, gardeners, type Rules } from "./rules";
import { carve, grantFor, explain, renderPreview } from "./carve";
import { buildView } from "./view";
import { loadStanding, setStanding, suggestStanding, approveSuggestion, orphanStanding, unpinnedAddresses, droppedStanding } from "./standing";
import { write, decideProposal } from "./write";
import { digest } from "./digest";
import { importNotion } from "./import/notion";
import type { WriteRequest } from "./checks";
import { upkeep, undoRun, fileLiveSource } from "./upkeep";
import { sourceBackfill } from "./backfill";
import { judgeDuplicates } from "./judge";
import { sleep, STEP as SLEEP_STEP } from "./sleep";
import { mergeNotes } from "./merge";
import { foldTwins, undoFold } from "./fold";
import { samePersonProposals, mergeSamePerson, notSamePerson, undoPersonMerge, personMerges } from "./sameperson";
import { explainAgent } from "./explain";
import { readsByDay, readsReport } from "./whoread";
import { AUDIO, transcriberFor } from "./transcribe";
import { capture, parseEmail, STEP as CAPTURE_STEP, type CaptureInput, extractPending, heldCaptures, decideCapture, captureConfig, releaseHeld, heldCount, sweepOwnerProposals } from "./capture";
import { intakeTick, dropOnce, mailOnce, mailSourceFor, type IntakeItem } from "./intake";
import { loadSources, pullSource, pullAll, type PullResult } from "./pull";
import { connectGoogle } from "./google";
import { recordCheckedRefs, registerLouisMessages } from "./louis";
import { exportBrain, exportSlice, importBundle } from "./passport";
import { modelFor, pausedReason, summary, capState, money, fmtMinutes } from "./usage";
import { routing, modelConfigFor, KEY_ENV } from "./model";
import { serve, serial } from "./server";
import * as hub from "./hub";
import { doctor, renderDoctor } from "./doctor";
import { applyFixes, fixPlan, renderDone, renderPlan } from "./doctor-fix";
import { useCells, startCells, cellsOn } from "./cell";
import { serveDashboard, mintPhoneLink } from "./dashboard/server";
import { appPhones, removeAppPhones } from "./dashboard/phone-app";
import { runAutoByHand } from "./filing";
import { revokeTokens, rotateToken, tokenInfo, retainTokens } from "./auth";
import { sha256 } from "./util";
import { TOKEN_ROLES, type TokenRole } from "./tokenrole";
import { openWindow, cleanup, rotate } from "./gardener";
import { namePlan } from "./mentions";
import { gardenerSetup, setNight, setPublicUrl, setFgaModel, setAskToSee, setWikiSync, setNightlyBackfill, setFileAll, setOwnerAliases, setNextStepNewest, suggestOwnerName, ownerSpellings, ownerNameReport, setLinkNames, setFamilyLinks, setAftercheckClassify, setDashboardTailnet, setAgentTier, setDescribeOrgs, setFoldTwins, DESCRIBE_LINE, OwnerSetError } from "./ownerset";
import { tailnetSettings, tailnetSelf, phoneLinkUrl } from "./dashboard/tailnet";
import { tendPlan, writeTendFiles, applyManaged, applyDescribe, manualSteps, type TendPlan } from "./tend";
import { pilotDoor, installDoor } from "./door";
import { loadKeys, keysDir } from "./secrets";
import * as asks from "./asks";
import { cancelActions } from "./act";
import * as oauth from "./oauth";
import * as fga from "./fga";
import { startOffboarding } from "./offboard";
import { confirmHeldAnswer, CoreError, ownerWhy } from "./core";
import { whyText } from "./why";
import { handover } from "./handover";
import { standingInstruction } from "./orientation";
import { addAgent, checkNotAnArea, likeAgent, previewNewAgent, checkNewAgent, type NewAgent } from "./addagent";
import { comingBack, comingBackText } from "./access-request";
import * as share from "./share";
import { createInvite, mintFromShell, shellMintRefusal, reachRefusal } from "./invite";
import { initBrain, interview, InitError, AGENT_KINDS, KIND_NAME, type AgentKind, type InitOptions } from "./init";
import { timezoneOf } from "./clock";
import { APP_LABEL, INSTRUCTION_PLACE, agentKeyFile, bridge, configPath, dropAgentKey, isLocalApp, isLoopback, mergeConfig, saveAgentKey, snippet, stdinLines, writeAppConfig } from "./local-apps";
import { tick, watch, watchdog, loadTextState } from "./textline/poll";
import { ESCALATION_TEMPLATE, loadEscalation, useTransport, TRANSPORTS } from "./textline/policy";
import { makeTransport, fakeReply } from "./textline/transport";
import { openItems } from "./textline/items";
import { existsSync } from "node:fs";
import { git, commitPaths } from "./git";
import { browserInstruction } from "./browser";
import * as bk from "./backup";
import { offsiteCopy, offsiteOn, offsiteOff } from "./offsite";
import { relayTick, fileTransport, agentMailTransport, loadRelayConfig, blockListPlan, decideHeld, relayCheck } from "./relay";
import { ingestLog, searchLogs, readLog, listLogs, decideLog } from "./logs";
import { parseExport, type LogFormat } from "./import/logs";
import { OWNER } from "./owner";
import { watchdogTick } from "./watchdog";
import { recordReexplain, recordOwnerTime, recordDrill, recordFix, recordRepair, appBuild, handFixNotice, noteStart, noteStop, startKind, bar, week, addTask, doneTask, openTasks } from "./measure";
import { startJobs, hubPlists } from "./start";
import { uninstallPlan, runUninstall, planText } from "./uninstall";
import { formatProblem, migrate, renderMigrate } from "./format";
import { menuState, menuTitle, installedBrain, installHub, restartHub, setupBrain, openDashboard, type Run } from "./menubar";
import { pairPhone } from "./phone";
import { runAction } from "./dashboard/actions";
import * as consent from "./consent";
import type { Model } from "./model";
import { auditCarve } from "./audit";
import { trustReport, trustText, recordTrust, sweep } from "./trust";
import { setupInChild, modelDir, MODEL_ID, MODEL_PAGE, MODEL_FILE_HOST } from "./semantic";
import { probeInit, findCanaries } from "./canary";
import * as memsync from "./memsync";
import * as beliefsMod from "./beliefs";
import * as quizplan from "./quizplan";
import * as fillMod from "./fill";
import { examRun } from "./exam";
import { runGolden } from "./golden";
import { importMemory, skippedMemory, afterImport, ME } from "./memimport";
import { listHandoffs, decideHandoff } from "./handoff";
import * as edge from "./edge";
import { ownerError } from "./owner-errors";
import { trace, traceText, type Trace } from "./trace";

// What a new owner needs; everything else is under `help --all` or a dashboard button.
const SHORT_USAGE = `pocketbrain <command>

  init [<dir>]                       a new brain (default ~/my-brain); asks a few questions, or
                                     --name "You" --from-text notes.txt; remembered, so no --brain later
  start [--port 8787]                the hub in one process: agents' server, dashboard, text channel,
                                     relay, nightly upkeep and sleep, morning digest
  start --launchd [--tunnel <name>] [--write]   launchd files to keep it running on a Mac
  add <agent> --kind <kind> [--write] [--url https://brain.example] [--yes]
                                     connect one assistant in one command: its door, a preset slice, then at most
                                     two pastes; kinds: claude-ai, claude-code, cursor, vscode, codex, gemini, claude-desktop, mcp, town, browser
                                     (--write puts an app's entry into its config, after a backup; docs/connect.md)
  add <agent> --slices a,b [--door mcp|oauth|api|local|invite] [--url https://brain.example] [--yes]
                                     a new trial agent in one go: preview, grant, then its token or sign-in
                                     and what to paste where (docs/add-an-agent.md)
  add <new> --like <old> [--slices extra] [--yes]   switch day: the new assistant starts from the old one's
                                     slice, as trial, with an invite code (docs/switch-day.md)
  connect <agent> [--url https://brain.example] [--code <code>]   a token for an agent, and what to paste where
                                     (a trial agent; a wider one needs the dashboard's one-time code)
  connect <agent> --kind claude-code [--code <code>]   connect an existing agent to Claude Code on this machine: runs
                                     claude mcp add and writes its standing instruction into ~/.claude/CLAUDE.md
  consent <agent> "what it is for"   say in one sentence what an assistant is for; get the slice it would
                                     see, with examples, and the line that applies it (docs/consent.md)
  connect <agent> --browser [--key-only]   sign-in page for an agent that only browses (docs/browser-door.md)
  doctor                             is everything healthy
  handover --to "Name" --out <dir>  give the whole brain to a person
  export --out <file>                the brain (or --agent's slice) as a Memory Passport bundle
  token --revoke <agent>             cut one assistant off at once (and delete its key file on this computer)

  help --all                         every command, including the weekly scorecard and the real-use bar
  The brain is --brain <dir>, or $PB_BRAIN, or the current directory, or the one init made last.
`;

const USAGE = `pocketbrain <command>

  init <dir> --name "Your name" [--kind claude-code|cursor|vscode|codex|gemini|claude-desktop|mcp|claude-ai|town|browser] [--write] [--agent <name>] [--areas work,personal]
       [--from-text notes.txt|dir]… [--from-mbox mail.mbox]… [--from-ics calendar.ics]… [--me you@example.com]…
       [--export-area personal] [--no-token]
  init <dir> --interview             a new brain from nothing: rules/, one trial agent and its token,
                                     named after the assistant kind (--kind); Claude Code is connected right away;
                                     notes seeded from plain text, a Gmail/calendar export or a guided interview
  import-notion                      raw Notion snapshot (import/raw) -> brain files + import/REPORT.md
  carve <agent> --preview            what <agent> would see, from rules/policy.yaml
  consent <agent> "<one sentence>" [--rules-only]   propose a slice from what the agent is for: a model picks
                                     from the brain's slice names (never all, money out unless asked), the real
                                     carve shows 3 notes it would and wouldn't see; nothing changes
  consent <agent> --apply --slices a,b --exclude-types money|none   apply it to an agent already in policy.yaml
                                     (one owner commit); a new agent uses add
  carve <agent> --slices a,b --preview   try a carve before granting it
  carve <agent> --slices a,b --confirm   grant it (owner commit to policy.yaml, tier trial) and build the view;
                                     an existing agent may only shrink here (widen on the dashboard)
  carve <agent> --why <id>[#attr]    why a note or fact is in or out
  build --agent <agent> | --all      compile views/<agent>.md and its manifest
  write --as <agent> --json '{...}'  one write through the write path (or --file req.json)
  relay --once [--agentmail] [--no-model]  check new agent-to-agent mail (code checks, then the request check), forward or hold, record in comms/
                                     (default transport: relay/incoming files; --agentmail uses $AGENTMAIL_RELAY_KEY)
  relay --release <id> | --drop <id> your decision on a held message
  handoff list | release <id> | drop <id>  handoffs between assistants: held and open ones, your decision on a held one
  upkeep [--live export.json]        the reflect agent: link/date fixes, freshness, duplicates, rechecks
  refs --load <file.json>            record which Gmail/calendar refs exist ({"gmail:<id>": true|false}), from a connector
  owner --msg <id> [--msg <id>…]     register your real message ids (imsg:phonemsg-… or owner:<date>/<channel>)
  sleep [--live export.json] [--no-upkeep] [--no-judge]
                                     the nightly pass: upkeep, then forget unused facts far past their shelf
                                     life (kept in history, undo --run), journal lines -> inbox proposals
                                     (model sleep.consolidate), duplicate review (judge), morning note
  merge <keep-id> <drop-id>          your yes to a duplicate: facts move across, disagreements become disputes
  migrate [--apply]                  bring an older brain to this version's format: a dry run on a copy, then
                                     --apply runs it in place as one commit (start does this by itself)
  reads <agent> [--days N] [--json]  what <agent> read and searched for, day by day, with an unusual line
                                     when most of a day is outside its usual areas (log/reads.jsonl). Only you.
  same-person [--json]               person notes that share a trusted email, phone or handle, with the evidence
  forget <people/id> [--yes]         take a person out of the brain on request: their note, links ([[redacted]]),
                                     standing, inbox items; without --yes it only shows what would go (docs/forget.md)
  forget --undo <people/id>          put a forgotten person back, within 14 days
  same-person merge <id> [--swap] | not <id> | undo <id>   your answer; a merge is undone while neither note changed
  explain <agent> [topic|id|id#attr] what <agent>'s slice holds about a topic, why each note and fact is in
                                     or out, and who was handed it (log/reads.jsonl). Only you.
  why <id#attr> [--json]             where a fact came from: its sources and their strength, earlier values,
                                     and every write on it, refused and held ones included. Only you.
  audit trust [--json] [--check N]  can you trust the brain? Facts checked against their source, ones that need a
                                     look and why, no-source reasons, assistants behind, your spot checks; counts only.
                                     --check N first reads N cited items and rechecks the facts that cite them
  audit carve [--json] [--dry-run]  did any agent's reach grow since the last audit without your commit? Every
                                     widening, traced to its commits; the rest become alerts (start runs it Sundays)
  probe init [--rotate]              plant decoy notes in the probe area, each with a unique canary; print the list
                                     (rules/canaries.yaml, never served). Only a slice naming the probe area sees them
  probe check <file|-> [--as <agent>]   the leak oracle: canaries found in a text (with --as, only those <agent>
                                     can't see); exits 1 on a find
  judge                              model-judged upkeep: near-duplicates, with the model from rules/models.yaml
                                     (bring your own: anthropic, openai, gemini, openai-compatible; key from env)
  capture --text "…" | --voice <transcript.txt|audio> | --email <message.eml> [--as <agent>]
                                     your quick capture: stored in inbox/captures/, facts extracted by the
                                     capture.extract model, checked against the brain, one inbox proposal per new fact.
                                     On a replica it is queued as a signed op; the hub stores and extracts it
  capture drop [--dir <folder>] [--settle <s>]   one pass over the phone drop folder (policy capture.drop_folder)
  capture mail                       one pass over the capture mailbox (policy capture.mail)
  capture watch [--dir <folder>]     mailbox + drop folder (+ extraction on the hub) every capture.poll_minutes
  capture pending                    (hub) extract every stored capture still waiting for the model
  standing list | standing set <person> <inner|close|known|none> [--authority owner|them|none] [--pin a,b]
                                     who matters to you (rules/standing.yaml): assistants weigh a sender's ask by it,
                                     never what they may see; inner and close pin the addresses you confirmed (--pin adds
                                     source-verified ones you name)
  standing suggest | standing approve <person>   tiers suggested from your own mail and texts (never inner); yours to approve
  sources list | sources pull [<name>]   read the places in rules/sources.yaml (Slack, Gmail, Calendar,
                                     Docs, Zoom): known facts re-confirmed, new ones proposed, facts whose
                                     source moved turn due. start runs it every poll_minutes.
  sources pull <name> --dry-run [--show]   read and extract, write nothing: counts per account and area
  sources backfill <name> [--max N] [--dry-run]   facts with no live source: search the mailbox for each value; a mail
                                     that states it and names the note becomes its source (value unchanged)
                                     (safe to paste); --show also prints the facts (don't paste those)
  sources connect <name>             sign in to a live Gmail, Calendar, Drive or Contacts source (read-only scope); the
                                     token is saved in the keys folder, never printed
  capture held                       captures held for you (injection shapes); nothing was sent to a model
  capture release <file> | capture discard <file>   your answer to a held capture
  usage [--month YYYY-MM] [--json]   the brain's own model spend (sleep, judge, capture, Ask): calls, tokens,
                                     minutes and cost per day and per step, against the caps in policy.yaml
  models [--json]                    which model each step runs on (executors cheap; steps: lines pick a step's model) and
                                     which line of rules/models.yaml picked it
  undo --run <run-id>                revert one upkeep run's auto-fixes and suppress them
  inbox --accept <file> | --reject <file>   your answer to a proposal
  inbox more [n]                     move n held new notes (over a source's new_notes_per_day) back to be filed
  digest [--since <iso time>]        what needs you, what happened on its own, numbers -> digest/<date>.md
  trace <request-id> [--json]        one request's path (door, log lines, commits) from the X-Request-Id an agent got
                                     back; names only, never note contents (docs/request-ids.md)
  reexplain <agent> "<what>"         log that you had to explain something to an agent again (the week's main number)
  minutes <n>                        log the minutes you spent on the brain today (replaces the dashboard estimate)
  fix "<what>"                       log a hand fix (a restart, a re-paste, an edit to unstick it); resets the real-use bar
  bar [--end <date>]                 the real-use bar: 14 days of daily use with no hand fix, plus a clean restore drill
  task ["<what>" [--cmd "<command>"]] | task --done <n>   add a hand task (only you can do it) with the exact
                                     command to run, list them, or close one; open ones go in the digest
  week [--end <date>] [--baseline <re-explanations/day before pocketBrain>]   7-day scorecard with
                                     first-week verdicts -> digest/week-<date>.md
  relay --block-plan                 the block lists you apply with the AgentMail admin key
  relay --check --from <agent> --to <agent> [--via <label>] < text
                                     the relay's checks for a message that travels another way (a group-chat bridge):
                                     prints the verdict as JSON, exit 0 deliver, 1 hold; recorded in comms/. See docs/relay.md
  start [--port 8787] [--no-cells]    serve + dashboard + text channel + relay (with AGENTMAIL_RELAY_KEY) + nightly
                                     upkeep/sleep (03:00) + digest (07:00), in one process
  start --launchd [--tunnel <name> [--tunnel-config <file>]] [--write]
                                     launchd plists for start and the Cloudflare tunnel
                                     (config defaults to ~/.cloudflared/config.yml)
  serve [--port 8787] [--host 127.0.0.1] [--dashboard] [--no-cells]   live server: MCP at /mcp, JSON API at /v1, spec at /openapi.json
  dashboard [--port 8788] [--agentmail] [--tailnet]   your control panel on localhost (and, with --tailnet or dashboard_tailnet, on your Tailscale address); prints a login link
  dashboard tailnet on --device <100.x> [--device …] | off   open the dashboard to your own devices on your tailnet (docs/dashboard-tailnet.md)
  phone [--device <name>] [--yes] [--no-restart]   pair your phone in one command: picks it from Tailscale, opens the
                                     dashboard to it (shows the rules lines first), tailscale serve, then a QR for the app
  dashboard phone-link [--port n]    a sign-in link for your phone: works once, for a day, on your tailnet
  dashboard phones [remove <name>|all]   the phones paired with the pocketBrain app; remove ends one's Face ID sign-in (docs/phone-app.md)
  filing now                           the hub's filing step by hand, only when no hub runs here: file what captures and sources found, expire what is past its deadline
  filing all on|off                    every fact your captures and sources find files itself, with Undo; only a conflict asks you
  me name [--suggested]                your full name as an alias (asked here, or the one your mail gives most), so facts about you land on your own page
  next-steps newest                    a newer next step replaces the older one (kept in history) instead of asking you
  invite <agent> [--minutes 15] [--url <public url>]   a one-time code the agent redeems at POST /v1/enroll for its own token
                                     (a narrow trial agent; a wider one's code comes from its dashboard page)
  share add <agent> --name "<person>" --slices a,b [--days 30] [--yes]   share a slice with a person's assistant,
                                     read-only until a date, personal at most, no money (docs/share.md)
  share list | extend <agent> --days N | end <agent>   who you share with; push the date; end it now (keys revoked)
  menubar [--json] | install [--tunnel <name>] | restart   what the Mac menu-bar app shows (hub up, day N of 14,
                                     agents, dashboard link) and does: install the hub under launchd, or restart it
                                     (docs/menubar.md)
  menubar setup --name "You" [--agent claude] [--dir ~/my-brain] [--from-text notes.txt] [--no-install]
                                     the app's first-run window: a new brain, the hub under launchd, and the
                                     first agent's token and standing instruction, as JSON
  agent tier <agent> core|trial [--dry-run]   core: the agent writes directly, no daily proposal cap; trial: it
                                     proposes. One owner commit with a Why (docs/gardener.md)
  agent pause|read-only|revoke <agent>   tighten one agent's switch, as the dashboard's buttons do; resuming is
                                     the dashboard's alone, behind your login
  menubar open-dashboard             open the dashboard signed in, without printing its login link
  watchdog [--url <hub>]            one look at the hub from outside: two missed /health answers restart it (launchd) and alert
  uninstall [--yes] [--remove-brain] what leaving takes: stop and remove the launchd jobs, logs, the tunnel config
                                     pocketBrain wrote, the menu-bar app and the keys folder; the brain and its
                                     backups stay (--remove-brain removes the brain, never backups); lists what to
                                     delete in your accounts. Prints the plan; --yes runs it (docs/quickstart.md#leaving)
  token --agent <agent> [--code <code>] | --revoke <agent>   issue a server token (printed once; only its hash
                                     is kept) or cut one off. A terminal mints alone only for a narrow trial agent;
                                     any other needs the one-time code from its dashboard page (docs/add-an-agent.md)
  token rotate <agent> [--role reader] [--overlap 24] [--code <code>] [--yes]   a new token; the old one keeps
                                     working for the overlap (hours), then stops, so the assistant never breaks while
                                     you re-paste. Like token, a wider agent needs the code from its dashboard page
  token --agent <agent> --role reader|resolver   a core agent's split token: reader = its slice below private, no
                                     dispute or owner routes (for a vendor's config); resolver = only those routes
  ask on [--approver dashboard|guardian] [--never a,b] [--max-per-day N] [--client-id id]
                                     turn ask-to-see on (rules/policy.yaml); counts as configuration, not a hand fix
  ask off                            turn it off
  ask list                           asks to see: what agents asked for, and what you decided
  ask approve <id>                   refused: approve on the dashboard or your phone (invariant 13, G244)
  ask decline <id>                   say no; the agent gets nothing
  ask test                           send one test push to your phone through Auth0 Guardian
  fga model | sync [--apply] | check <agent>   (model saves its model_id) OpenFGA as a second lock on slices (docs/fga.md)
  golden [agent] [--file f] [--json]   the golden set: the owner's weekly questions (evals/weekly.yaml in the
                                     brain) through each agent's view; top 5, the expected fact, fresh
  exam [agent] [--days 7] [--quiz [--n 3]]   memory exam: each agent's memory against the brain, brain-first
                                     reads, citations, slice; weekly in start -> digest/exam-<date>.md
  memsync off|on [part…] | run [agent] | scan <agent> | report <agent> [--json] | quiz <agent> | list | approve <id> | decline <id> | key | import <agent|me> [files] | ask <agent> | pointers <agent> | brainfirst [days]
                                     keep agents' own memories in line with the brain (docs/memory-sync.md)
  diary catchup [--dry-run]         the owner's diary: add lines for fact changes that came without one (counts only)
  fill [--days 7] [--json]           is the brain filling? per source: proposed, kept, dropped, re-confirmed,
                                     owner minutes, against 50 a week, 85% kept, 2 minutes a day
  beliefs [--agent a] [--red] [--json] | fix <key>   belief radar: what each assistant's memory holds per fact,
                                     graded against the brain now; fix one fact in every assistant at once
  beliefs plan [--per-week 10] [--ask] [--json]   quiz budget: the facts each assistant would be asked
                                     next, at most N a week; --ask asks them (docs/memory-sync.md)
  gardener describe-orgs [--yes]     add describe_orgs: true to rules/gardener.yaml (asks first; refuses if set)
  gardener setup [--profile p] [--lock <claude-lock.json>] [--agent g] [--mcp-url u] [--vault <id>]
                                     record the gardener's Anthropic side in rules/gardener.yaml (owner commit)
  night managed|local                who runs the nightly pass (rules/hub.yaml, or policy.yaml on one machine)
  overlaps                           assistants' routines that may do the same job, by page id (docs/wiki.md)
  fold [--apply] | fold on|off | fold undo <commit>   fold same-name project and org twins: dry run, now, nightly on or off, or put one back (docs/fold-twins.md)
  wiki sync on|off                   whether the Gardener's wiki_sync writes pages or only reports (policy.yaml; docs/wiki.md)
  backfill on|off                    whether the nightly source backfill attaches the mail it finds or only reports
                                     (policy.yaml; docs/sources-pull.md)
  aftercheck classify on|off [--cap <$>]  the second-opinion classifier after an agent's write, and its own monthly cap (docs/aftercheck.md)
  wiki family on|off                 whether upkeep links a person page with your surname to your page as maybe family (off: counts only; docs/owner-home.md)
  wiki links on|off|preview          whether upkeep links a name that fits exactly one note (off: nothing); preview lists what it would link (policy.yaml; docs/wiki.md)
  gardener open [minutes] [--agent g]  let the gardener connect outside its hours for a manual run (default 60)
  gardener cleanup                   delete its ended Anthropic sessions older than an hour (rules/gardener.yaml)
  gardener rotate --code <code>      new gardener token into its vault (on stdin), old credential archived, old tokens
                                     revoked; the code is the gardener page's "Rotation code" (the hub's weekly run needs none)
  tend --managed [--agent g] [--dir ~/pocketbrain-agents] [--url <public url>] [--profile pocketbrain]
      [--nightly-model m] [--weekly-model m] [--force] [--apply --code <code>]
                                     the gardener's Managed Agents files for your own Anthropic account; with --apply,
                                     run them through ant: vault, token on stdin, deployments created paused
                                     (--revoke also cuts the agent's OAuth connections)
  add <agent> --kind claude-ai|claude-code|cursor|vscode|codex|gemini|claude-desktop|mcp|town|browser [--slices a,b] [--url <public url>] [--write] [--yes]
                                     the door that kind uses, every area plus contacts-basic unless --slices,
                                     trial, money out; then only what is left for you, numbered (at most two
                                     steps). claude-code runs claude mcp add and writes ~/.claude/CLAUDE.md itself;
                                     an app on this computer (cursor … mcp) gets the stdio bridge, its key in
                                     agent-keys/<agent> (0600), and with --write its config entry, after a backup
  mcp --agent <agent> [--url http://127.0.0.1:8787]
                                     the stdio bridge an app on this computer starts: MCP over stdin and stdout to
                                     the hub here, with the agent's key from agent-keys/; refuses any other address
  add <agent> --slices a,b [--door mcp|oauth|api|local|invite] [--url <public url>] [--name <label>]
      [--exclude-types money] [--yes]  a new trial agent: preview its slice; with --yes grant it, then print its
                                     token (or, --door oauth, approve your next sign-in for 10 minutes) and what to paste
  add <new> --like <old> [--slices extra] [--door …] [--yes]   switch day: copy the old assistant's slices and
                                     leave-outs into a new trial agent (never its tier, ceiling or areas), then an invite
                                     code and the standing instruction; extra --slices add to the copy
  connect <agent> [--url <public url>] [--code <code>]   a token for an agent plus what to paste into its
                                     connector settings; a wider than trial agent needs the dashboard's one-time code
  connect <agent> --kind claude-code [--code <code>]   Claude Code on this machine, in one go: a new token handed to
                                     claude mcp add (never printed when that works) and the standing instruction in
                                     ~/.claude/CLAUDE.md; the same terminal gate as connect (G184)
  connect <agent> --browser [--key-only] [--code <code>] [--url <public url>]
                                     turn on the browser door (/b) for an agent whose vault only fills web
                                     forms; --key-only prints only the key on stdout (docs/browser-door.md)
  oauth setup --issuer <url> --resource <https://host/mcp/oauth> --owner-subject <id> [--jwks <url>]
                                     open the OAuth door for assistants that can't paste a token (docs/oauth.md)
  oauth status                       the door's settings, bound connections, and those waiting for you with what each asked for
  oauth bind <client-id> --agent <agent> [--name <label>] [--keep-old]   let a waiting connection in as that agent;
                                     it replaces the agent's old connection (a Reconnect), unless --keep-old
  oauth cleanup                      delete replaced connections' apps at the sign-in service (needs oauth management)
  oauth expect <agent> [--name <label>] [--minutes 10]   approve your own next new sign-in as that agent, once
  oauth revoke <client-id>           cut one OAuth connection off for good (and delete it at the AS when a management client is set)
  oauth management <client-id>|--clear   the AS app that may delete revoked clients; its secret is the key AUTH0_MGMT_CLIENT_SECRET
  oauth coworker add <subject> --name <name> --agent <agent>   let a coworker's own account in, as that agent only
  oauth coworker bind <subject> <client-id>                    approve one of their waiting connections
  oauth machine <client-id> --agent <gardener>                 let a machine app (client credentials) in as the gardener
  oauth coworker remove <subject>    cut the coworker and all their connections off
  dispute --confirm <c-NNNN> | --reject <c-NNNN>   your check on an answer the resolver relayed for a private fact
  textline once [--dry-run]          one tick of the text channel: read your replies, gather what needs you,
                                     text you per rules/escalation.yaml (tiers, quiet hours, batching)
  textline watch                     the routine: a tick every cadence_minutes (default 5); keep it running
  textline status                    open items, their tier, and what the next tick would do
  textline init                      write rules/escalation.yaml with the defaults (you only)
  textline use <instinct|imessage|fake> [--to <handle>|-]
                                     switch the transport: edits only the transport block of
                                     rules/escalation.yaml, commits as you; the handle is never shown
  textline reply "<text>"            fake transport: pretend you texted this back (tests, demo)
  textline watchdog --url <health>   from another machine: text you if the hub stops answering
  hub init --name <machine> [--key <ssh key>] [--signer <program>] [--git <url>] [--public-url <url>]
                                     name this clone and its signing key; the first clone becomes the hub
  hub add-replica <name> --pub "<ssh public key>" [--git <url>] [--no-hub]   (on the hub) list a replica
  hub url https://<host>             set the public door agents hold (rules/hub.yaml public_url)
  hub status                         who is hub, which epoch, what is queued
  hub sync [--from <url>]            replica: send queued ops, move to the hub's main. hub: ingest + replay
  hub promote <this machine> [--from <url>] [--force]   make this clone the hub: verify, bump the epoch,
                                     replay queued ops, print the DNS/tunnel step
  hub replay                         (hub) apply queued ops through the write path
  hub verify [--all]                 check commit signatures against rules/hub.yaml, and the write log
  hub tunnel-config                  the cloudflared ingress that exposes only the agent API
  door install <credentials.json> --hostname <host> [--name <machine>] [--force]
                                     a pilot's door: tunnel credentials (0600), agent-API-only ingress, public_url
  pilot door <name> --zone <zone> [--out ~/.cloudflared]   operator: a named tunnel and <name>.<zone> for a pilot
  edge enroll <agent> [--role reader] [--code <code>]   a new token that also opens the agent's sealed cell (shown once)
  edge publish --out <dir>           seal each enrolled agent's cell into <dir> (docs/edge.md)
  edge serve --from <dir> [--port 8789]   answer reads from the sealed cells, queue writes (a stand-in edge)
  edge replay --from <dir>           (hub) run the writes queued at the edge through the write path
  doctor [--offline] [--json]        hub, replicas, signatures, ops, server, public door, dashboard, snapshots
  doctor --fix [--yes]               preview the safe repairs doctor knows; --yes runs them and checks again
  search setup                       download the semantic-search model once (bge-m3, MIT licence, about 590 MB);
                                     searches then also match by meaning, run on this machine only. Off with
                                     PB_SEMANTIC=0 (docs/semantic-search.md)
  support bundle [--out <file>]      one file to send for help: versions, doctor, jobs, rules keys, log tails; no note content
  logs import --as <agent> --file <export> [--format auto|text|json|claude-code|claude-export|chatgpt-export] [--date YYYY-MM-DD]
                                     forward a vendor export into <agent>'s log archive (Claude Code .jsonl, claude.ai or
                                     ChatGPT conversations.json, our JSON, or plain text); same checks as logs agents send
  logs search "<words>" [--agent <a>] [--limit n]   your search over every agent's logs, held and archived included
  logs read <id>                     one log in full
  logs held                          logs waiting for you (injection shapes, withheld words)
  logs --release <file> | --drop <file>   your answer to a held log
  backup [--dest <dir>] [--if-due]   age-encrypted bundle of the whole brain (history, rules, ops, logs; never
                                     views or secrets) to rules/backup.yaml's folder, with rotation. The hub runs
                                     it from serve when main moved and every_hours passed
  backup --init --pub <age1...>      write rules/backup.yaml and rules/backup.pub (the public key only)
  backup offsite on <folder> | off   (Mac) a separate launchd job copies new backups from the local folder to
                                     <folder> (a synced one, like Drive) every hour, each copy under a time limit,
                                     so a hung synced folder never stalls the hub (docs/backup.md)
  restore <file.tar.age> --to <empty dir> --identity <key file | - > [--key <ssh signing key>] [--name <machine>]
                                     rebuild a working brain from one backup, check every hash, run doctor
  drill [--identity <key file>] [--key <ssh signing key>]   copy, back up, wipe, restore, diff, git fsck,
                                     note and fact counts, boot the hub on it; never touches the brain or the
                                     real backup folder
  drill --demo                       the same on the sample brain with a throwaway key; one line, nothing recorded
  export --out <file> [--agent <agent>]   a Memory Passport bundle (docs/export.md): the whole brain (notes and the
                                     rules a carve reads; no tokens, logs, inbox or secrets), or one agent's slice as its reads answer
  import <bundle> --into <dir>       a brain bundle into a fresh folder: same notes, same carve per agent, one owner commit
  handover --to "Name" --out <dir> [--age-key age1...] [--include-agents]
                                     full handover to a person: stripped, rewritten, fresh one-commit repo,
                                     verified, encrypted to their key, recorded in handovers/. Never sends.

  --brain <dir>                      brain folder (default $PB_BRAIN or .)`;

// Text a sign-in chose (client ids, user agents, request words) for the terminal: control
// characters, and the bidi, zero-width and soft-hyphen ones that can reorder or hide text.
const oauthPlain = (x: string) => x.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "");

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function args_(args: string[], name: string): string[] {
  return args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1]] : []));
}

// Where `init` remembers the brain, so later commands work from any folder without --brain.
function configDir(): string {
  return process.env.PB_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pocketbrain");
}
function rememberedBrain(): string | undefined {
  try { const p = readFileSync(join(configDir(), "brain"), "utf8").trim(); return p && existsSync(join(p, "rules", "policy.yaml")) ? p : undefined; } catch { return undefined; }
}
export function brainRoot(args: string[]): string {
  const given = arg(args, "--brain") ?? process.env.PB_BRAIN;
  if (given) return given;
  if (existsSync(join(process.cwd(), "rules", "policy.yaml"))) return process.cwd();
  return rememberedBrain() ?? process.cwd();
}

function runInit(args: string[]): number {
  const dir = args[0] && !args[0].startsWith("--") ? args[0] : arg(args, "--brain") ?? process.env.PB_BRAIN ?? join(homedir(), "my-brain");
  const opts: InitOptions = {
    owner: arg(args, "--name") ?? "",
    agent: arg(args, "--agent"),
    areas: arg(args, "--areas")?.split(",").map((x) => x.trim()).filter(Boolean),
    text: args_(args, "--from-text"),
    mbox: args_(args, "--from-mbox"),
    ics: args_(args, "--from-ics"),
    me: args_(args, "--me"),
    exportArea: arg(args, "--export-area"),
    token: !args.includes("--no-token"),
  };
  let seedText: string | undefined;
  const hasClaude = !!Bun.which("claude", { PATH: process.env.PATH ?? "" });
  // Which assistant comes first (row 388): it names the agent and picks the connect step.
  let kind = arg(args, "--kind") as AgentKind | undefined;
  if (kind !== undefined && !(AGENT_KINDS as readonly string[]).includes(kind)) { console.error(`init: --kind is one of ${AGENT_KINDS.join(", ")}`); return 2; }
  try {
    // With nothing to go on and a person at the keyboard, ask: plain `pocketbrain init` just works.
    const nothingGiven = !opts.owner && !opts.text!.length && !opts.mbox!.length && !opts.ics!.length;
    if (args.includes("--interview") || (nothingGiven && process.stdin.isTTY)) {
      const iv = interview((q) => prompt(q), (s) => console.log(`\n${s}`), { claudeCode: hasClaude });
      opts.owner = opts.owner || iv.owner;
      opts.agent ??= iv.agent;
      kind ??= iv.kind;
      opts.mbox = [...opts.mbox!, ...iv.mbox];
      opts.ics = [...opts.ics!, ...iv.ics];
      seedText = iv.text;
    } else if (nothingGiven) {
      // Piped, CI or some IDE terminals: no one to ask (backlog 389). Say so, and both ways on.
      console.error(`init: no terminal to ask in, so init can't ask its questions. Pass --name "Your name" (and --agent), or pipe the answers in, one per line, with --interview`);
      return 2;
    }
    if (kind) opts.agent ??= KIND_NAME[kind];
    // The token comes from that kind's connect (below, or once there is a public address): not two.
    const connectsItself = (kind === "claude-code" && hasClaude) || isLocalApp(kind), inCloud = !!kind && kind !== "claude-code" && !isLocalApp(kind);
    if (connectsItself || inCloud) opts.token = false;
    const r = initBrain(resolve(dir), { ...opts, seedText: seedText ? [{ name: "interview", text: seedText }] : undefined });
    // A second brain (a demo, a test) never takes over the remembered one: commands without
    // --brain keep finding the brain that was there first (eval gap G143).
    const kept = rememberedBrain();
    if (!kept) try { mkdirSync(configDir(), { recursive: true }); writeFileSync(join(configDir(), "brain"), r.root + "\n"); } catch { /* optional convenience */ }
    console.log(`\nYour brain is ready in ${r.root} (${r.notes} notes).`);
    const tz = loadRules(r.root).policy.owner?.timezone;
    console.log(tz ? `Your day (the nightly tidy pass, the morning digest, the brain's dates) runs in ${tz}, this computer's time zone.` : `Your day runs in ${timezoneOf(loadRules(r.root))}. If that isn't yours, set it in rules/policy.yaml, for example owner: { name: …, timezone: Europe/Paris }.`);
    if (kept && resolve(kept) !== r.root) console.log(`Commands without --brain still use ${kept}. To use this one, pass --brain ${r.root} or set PB_BRAIN.`);
    console.log(`\nWhat ${r.agent} will see:\n${r.preview}`);
    console.log(`\nWhat init removed, kept private or guessed: ${r.report}`);
    console.log(`\n1. Start it, and leave that window open:\n\n     pocketbrain start\n`);
    if (connectsItself) {
      const k = isLocalApp(kind) ? kind : "claude-code";
      console.log(`2. ${isLocalApp(k) ? APP_LABEL[k] : "Claude Code"}, connected now:\n`);
      // init's first agent is narrow (one area and contacts-basic, trial), so the G184 gate lets it through.
      try { return connectKind(r.root, r.agent, k, "http://127.0.0.1:8787", undefined, undefined, args.includes("--write")); } catch (e) { console.error(`init: ${(e as Error).message}`); return 1; }
    }
    if (inCloud) {
      // In the cloud: the brain needs a public address first (quickstart, "Connect an assistant in the cloud").
      console.log(`2. ${kind === "browser" ? "Your browsing assistant" : kind === "town" ? "Town" : "Claude on the web"} reaches your brain at a public address, not this machine. Once you have one (the quickstart's "Connect an assistant in the cloud"), connect it with one command:\n\n     pocketbrain connect ${r.agent} --kind ${kind} --url https://<your brain's address>\n`);
      console.log(`It prints what to paste where, and the instruction that makes ${r.agent} check the brain without being asked.`);
      return 0;
    }
    if (r.token) {
      const url = "http://127.0.0.1:8787/mcp";
      // With Claude Code here, one command connects it and writes its standing instruction (stranger rehearsal).
      if (Bun.which("claude", { PATH: process.env.PATH ?? "" })) console.log(`2. Connect Claude Code, in another window: pocketbrain connect ${r.agent} --kind claude-code\n   It runs claude mcp add and writes step 3 into ~/.claude/CLAUDE.md for you. Or paste:\n\n     claude mcp add --scope user --transport http pocketbrain ${url} --header "Authorization: Bearer ${r.token}"\n`);
      else console.log(`2. Connect ${r.agent}. In Claude Code, paste:\n\n     claude mcp add --scope user --transport http pocketbrain ${url} --header "Authorization: Bearer ${r.token}"\n`);
      console.log(`   In any other assistant, add a custom MCP connector with\n     URL:    ${url}\n     Header: Authorization: Bearer ${r.token}\n   (Claude Desktop, Claude on the web and other assistants in the cloud can't reach 127.0.0.1;\n    they need a public address: see the quickstart, "Connect an assistant in the cloud")\n`);
      console.log(`The token is shown once. Save it in your password manager; pocketbrain connect ${r.agent} makes a new one.`);
      console.log(`\n3. So ${r.agent} checks the brain without being asked, paste this once into its own custom instructions (Claude Code: ~/.claude/CLAUDE.md):\n\n${standingInstruction(loadRules(r.root), "mcp", "http://127.0.0.1:8787")}`);
    }
    return 0;
  } catch (e) {
    if (e instanceof InitError) { console.error(`init: ${e.message}`); return 2; }
    throw e;
  }
}

// `add --kind` (docs/add-an-agent.md#one-command-per-kind): the door each kind of assistant uses.
const KINDS = { "claude-ai": "oauth", "claude-code": "local", cursor: "local", vscode: "local", codex: "local", gemini: "local", "claude-desktop": "local", mcp: "local", town: "mcp", browser: "browser" } as const;
type Kind = keyof typeof KINDS;

// A trial agent's preset, so up to personal, money out, writes wait, plus names and roles. claude-ai
// gets every area: its door is your own sign-in, so no token is made here. A kind whose token the
// terminal makes gets one area (work if there is one, as init's first agent), which is what the
// terminal gate lets a shell mint for alone (G184, G241); widen it on the dashboard.
function slicePreset(rules: Rules, kind: Kind): string[] {
  const areas = Object.keys(rules.policy.areas ?? {});
  const pick = kind === "claude-ai" ? [...areas].sort() : areas.includes("work") ? ["work"] : areas.slice(0, 1);
  return [...pick.map((a) => `area:${a}`), ...(rules.slices["contacts-basic"] ? ["contacts-basic"] : [])];
}

// What is left for the owner after `add --kind`, as numbered steps: at most two, often none.
// G184: every token made here goes through the terminal gate (mintFromShell), as `connect` does: a
// narrow trial agent alone, a wider one with the owner's one-time code (--code). The gate runs before
// anything changes, so a refused kind leaves policy.yaml, Claude Code and ~/.claude/CLAUDE.md as they were.
function connectKind(root: string, agent: string, kind: Kind, url: string, name?: string, code?: string, write = false): number {
  const rules = loadRules(root);
  const via = `connect ${agent} --kind ${kind}${url === "http://127.0.0.1:8787" ? "" : ` --url ${url}`}`;
  const say = (steps: string[], after = "") => {
    console.log(steps.length ? `What's left for you:\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n\n")}` : "Nothing left to do.");
    if (after) console.log(`\n${after}`);
  };
  const instr = (transport: "mcp" | "api") => standingInstruction(rules, transport, url).trimEnd();
  if (kind === "claude-ai") {
    if (!oauth.loadOAuth(root)) { console.error("no OAuth door yet: set it up first (docs/oauth.md, pocketbrain oauth setup)"); return 1; }
    const e = oauth.expectClient(root, agent, { name });
    const mins = Math.round((Date.parse(e.until) - Date.parse(e.opened)) / 60_000);
    say([
      `In claude.ai, Settings > Connectors > Add custom connector, paste ${url}/mcp/oauth and sign in with your own account in the next ${mins} minutes.`,
      `In Settings > Profile, paste this once into your personal preferences:\n\n${instr("mcp")}`,
    ], `Then ask it something about you: it answers "from your brain".`);
    return 0;
  }
  if (kind === "browser") {
    // The key first (G242's order, as connectBrowser): a refused key leaves the door off.
    const tok = mintFromShell(root, agent, { via, code, role: "reader" });
    const file = join(root, "rules", "policy.yaml");
    const doc = YAML.parseDocument(readFileSync(file, "utf8"));
    doc.setIn(["agents", agent, "browser"], true);
    writeFileSync(file, doc.toString({ lineWidth: 0 }));
    git(root, ["add", "rules/policy.yaml"]);
    git(root, ["commit", "-q", "-m", `owner: browser door on for ${agent}`, "--", "rules/policy.yaml"], OWNER);
    say([
      `Save this sign-in in ${agent}'s own password vault:\n     Page:     ${url}/b\n     Username: ${agent}\n     Password: ${tok}`,
      `Paste this once into ${agent}'s custom instructions:\n\n${browserInstruction(loadRules(root), url)}`,
    ]);
    console.error(`key printed once; only its hash is in rules/tokens.yaml. Revoke: pocketbrain token --revoke ${agent}`);
    return 0;
  }
  if (isLocalApp(kind)) {
    // An app on this computer (src/local-apps.ts): its config starts the stdio bridge, and the key
    // waits in a 0600 file for it, never printed. --write puts the entry in the app's own config,
    // after a backup; a config it can't read stops here, before any key is made.
    const label = APP_LABEL[kind], path = configPath(kind);
    if (write) {
      if (!path) { console.error(`${label}'s config file isn't known, so --write can't put it there; leave --write out and paste the command`); return 2; }
      mergeConfig(kind, existsSync(path) ? readFileSync(path, "utf8") : undefined, agent);
    }
    const tok = mintFromShell(root, agent, { via: `${via}${write ? " --write" : ""}`, code });
    let keyFile = "";
    if (!write) keyFile = saveAgentKey(agent, tok);
    const steps: string[] = [];
    if (write) {
      let w: { path: string; backup?: string };
      // The config first, then the key file: a failed write leaves a key the app already uses as it was.
      try { w = writeAppConfig(kind, agent); keyFile = saveAgentKey(agent, tok); } catch (e) {
        // Nothing points at the new key, so only it is taken back; any key from before keeps working.
        try { retainTokens(root, agent, (h) => h !== sha256(tok)); }
        catch (r) { console.error(`The new key couldn't be taken back (${(r as Error).message}). Fix: pocketbrain token --revoke ${agent}, then connect it again.`); }
        console.error(`Couldn't write ${label}'s config (${(e as Error).message}), so its new key was taken back. Fix: run pocketbrain connect ${agent} --kind ${kind} without --write, and paste what it prints.`);
        return 1;
      }
      console.log(`Added pocketbrain to ${label}'s config, ${w.path}${w.backup ? ` (the file as it was is in ${w.backup})` : ""}.`);
      steps.push(`Quit ${label} and open it again, so it loads pocketbrain.`);
    } else if (path) {
      steps.push(`Add this to ${path}, beside anything already there, then restart ${label}. Or run the same command again with --write, and it does this for you after a backup of the file:\n\n${snippet(kind, agent)}`);
    } else {
      steps.push(`In ${label}'s settings, add an MCP server that starts this command (stdio), then restart it:\n\n${snippet(kind, agent)}`);
    }
    steps.push(`Paste this once into ${INSTRUCTION_PLACE[kind]}, so ${agent} checks the brain without being asked:\n\n${standingInstruction(rules, "mcp", "http://127.0.0.1:8787").trimEnd()}`);
    say(steps, `Then ask it something about you: it answers "from your brain". Keep pocketbrain start running.`);
    console.error(`key kept for ${label} in ${keyFile}, readable only by you, never printed; only its hash is in rules/tokens.yaml. Revoke (deletes that file too): pocketbrain token --revoke ${agent}`);
    return 0;
  }
  if (kind === "claude-code") {
    const local = "http://127.0.0.1:8787";
    const tok = mintFromShell(root, agent, { via, code });
    const add = ["mcp", "add", "--scope", "user", "--transport", "http", "pocketbrain", `${local}/mcp`, "--header", `Authorization: Bearer ${tok}`];
    const claude = Bun.which("claude", { PATH: process.env.PATH ?? "" });
    testRunGuard([process.env.HOME ?? homedir(), claude]);
    const cc = (a: string[]) => Bun.spawnSync([claude!, ...a], { stdout: "pipe", stderr: "pipe", env: process.env }).exitCode === 0;
    // An earlier pocketbrain server in Claude Code is replaced: the name is taken once.
    const ran = !!claude && (cc(add) || (cc(["mcp", "remove", "--scope", "user", "pocketbrain"]) && cc(add)));
    const md = writeClaudeMd(standingInstruction(rules, "mcp", local));
    console.log(`${ran ? "Added pocketbrain to Claude Code (claude mcp add, user scope). " : ""}Wrote the standing instruction into ${md}, between <!-- pocketbrain --> lines.`);
    say(ran ? [] : [`Claude Code isn't on this machine's PATH. Once it is, run:\n     claude ${add.slice(0, 9).join(" ")} --header "Authorization: Bearer ${tok}"`],
      "Then open a new Claude Code session and ask it something about you.");
    console.error(`${ran ? "token handed to Claude Code, not shown" : "token printed once"}; only its hash is in rules/tokens.yaml. Revoke: pocketbrain token --revoke ${agent}`);
    return 0;
  }
  const tok = mintFromShell(root, agent, { via, code });
  say([
    `In ${agent}'s connector settings, add a custom MCP server:\n     URL:    ${url}/mcp\n     Header: Authorization: Bearer ${tok}\n     (no header field? connect it with OAuth instead: docs/oauth.md)`,
    `Paste this once into ${agent}'s own custom instructions:\n\n${instr("mcp")}`,
  ]);
  console.error(`token printed once; only its hash is in rules/tokens.yaml. Revoke: pocketbrain token --revoke ${agent}`);
  return 0;
}

// G393: a test run (test/setup.ts sets PB_TEST_RUN_DIR) never changes the machine's own Claude Code.
// The home it would write and the claude it would run must both be inside the run's folder.
function testRunGuard(paths: (string | null)[]) {
  const run = process.env.PB_TEST_RUN_DIR;
  if (!run) return;
  const out = paths.filter((p): p is string => !!p && !resolve(p).startsWith(resolve(run) + "/"));
  if (out.length) throw new Error(`a test run won't change Claude Code outside its own folder (${out.join(", ")})`);
}

// The standing instruction in ~/.claude/CLAUDE.md, between marker lines: written once, replaced after.
function writeClaudeMd(text: string): string {
  const file = join(process.env.HOME ?? homedir(), ".claude", "CLAUDE.md");
  testRunGuard([file]);
  const block = `<!-- pocketbrain -->\n${text.trimEnd()}\n<!-- /pocketbrain -->\n`;
  const old = existsSync(file) ? readFileSync(file, "utf8") : "";
  const re = /<!-- pocketbrain -->\n[\s\S]*?<!-- \/pocketbrain -->\n?/;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, re.test(old) ? old.replace(re, block) : `${old}${old && !old.endsWith("\n\n") ? (old.endsWith("\n") ? "\n" : "\n\n") : ""}${block}`);
  return file;
}

// The token, where to paste it, and the standing instruction: `connect` and `add` print the same.
// G184: every token minted here goes through mintFromShell (narrow agent, or the owner's code).
function printConnect(root: string, agent: string, transport: "mcp" | "api", url: string, via = `connect ${agent}`, code?: string, token?: string) {
  const tok = token ?? mintFromShell(root, agent, { via, code });
  console.log(transport === "api"
    ? `${agent} uses the JSON API.\n  Base URL:  ${url}/v1\n  Header:    Authorization: Bearer ${tok}\n  Start with GET ${url}/v1/orientation; the spec is ${url}/openapi.json`
    : `${agent} uses MCP. Add a custom connector:\n  URL:    ${url}/mcp\n  Header: Authorization: Bearer ${tok}\n  (no header field? connect it with OAuth instead: docs/oauth.md)`);
  console.log(`\nThen paste this once into ${agent}'s own custom instructions, so it checks the brain without being asked:\n\n${standingInstruction(loadRules(root), transport, url)}`);
  console.error(`token printed once; only its hash is in rules/tokens.yaml. Revoke: pocketbrain token --revoke ${agent}`);
}

// A one-time code instead of a token (docs/add-an-agent.md): the agent redeems it itself.
// G184: an invite code is a token for whoever redeems it, so the terminal makes one only for a
// narrow agent. A wider agent's code comes from the dashboard (the agent's page).
function printInvite(root: string, agent: string, url: string, minutes?: number) {
  const why = shellMintRefusal(root, agent);
  if (why) throw new Error(`${agent}: ${why}, so a terminal alone can't invite it. On the dashboard, open ${agent}'s page (Assistants) and press "One-time code"; the agent can redeem that code itself at ${url}/v1/enroll`);
  const inv = createInvite(root, agent, { minutes, terminal: true });
  console.log(`Invite code for ${agent}: ${inv.code}\nIt works once, until ${inv.until}. Give it to ${agent} with this:\n\n  Connect to pocketBrain: POST ${url}/v1/enroll with {"code": "${inv.code}"}. Keep the token it returns as your secret, then follow the read_first link.\n\nThe doors are listed at ${url}/.well-known/pocketbrain. Revoke: pocketbrain token --revoke ${agent} (also cancels the code).`);
}

// The USAGE lines for one command, with their continuation lines.
function usageOf(cmd: string): string {
  const out: string[] = [];
  let on = false;
  for (const l of USAGE.split("\n")) {
    const t = l.trimStart();
    if (l.startsWith("  ") && !l.startsWith("    ")) on = t === cmd || t.startsWith(`${cmd} `);
    else if (!l.startsWith("    ")) on = false;
    if (on) out.push(l);
  }
  return out.length ? out.join("\n") : `no usage for "${cmd}"; see pocketbrain help --all`;
}

// The browser door (src/browser.ts): turn it on for this agent, as the owner, and give it a key.
// With --key-only the key is the only thing on stdout, so it can go straight to the clipboard.
function connectBrowser(root: string, agent: string, url: string, keyOnly: boolean, code?: string) {
  // G184, G242: the key is made first (the gate, or the owner's code, checked and spent), and the
  // door is turned on only after that, so a refused key or a wrong code leaves policy.yaml as it was.
  // A reader key (G18): its slice below private, no resolver routes. A browser can't settle disputes anyway.
  const tok = mintFromShell(root, agent, { via: `connect ${agent} --browser`, code, role: "reader" });
  const file = join(root, "rules", "policy.yaml");
  if (!loadRules(root).policy.agents[agent]?.browser) {
    const doc = YAML.parseDocument(readFileSync(file, "utf8"));
    doc.setIn(["agents", agent, "browser"], true);
    writeFileSync(file, doc.toString({ lineWidth: 0 }));
    git(root, ["add", "rules/policy.yaml"]);
    git(root, ["commit", "-q", "-m", `owner: browser door on for ${agent}`, "--", "rules/policy.yaml"], OWNER);
  }
  const say = keyOnly ? console.error : console.log;
  say(`${agent} can sign in on the browser door.\n  Sign-in page: ${url}/b\n  Agent:        ${agent}\n  Key:          ${keyOnly ? "(on stdout, not shown here)" : tok}\nSave the key in ${agent}'s own password vault for ${url}/b, then paste this once into its custom instructions:\n\n${browserInstruction(loadRules(root), url)}`);
  if (keyOnly) console.log(tok);
  console.error(`only its hash is in rules/tokens.yaml. Revoke: pocketbrain token --revoke ${agent}`);
}

// Commands that run before a brain exists, or beside one (the menu bar, a pilot's door, the edge).
const NO_BRAIN = new Set(["init", "uninstall", "search", "restore", "menubar", "door", "pilot", "edge", "import-notion", "import"]);
const KNOWN_COMMANDS = new Set([...USAGE.matchAll(/^\s{2}([a-z][a-z-]*)\b/gm)].map((m) => m[1]));

export function main(argv: string[]): number {
  const [cmd, ...args] = argv;
  const root = brainRoot(args);
  if (cmd === "--version" || cmd === "version") { console.log(JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version); return 0; }
  if (!cmd || cmd === "help" || cmd === "--help") { console.log(args.includes("--all") ? USAGE : SHORT_USAGE); return 0; }
  if (args.includes("--help") || args.includes("-h")) { console.log(usageOf(cmd)); return 0; }

  if (cmd === "init") return runInit(args);
  // A command that reads the brain, with no brain anywhere: say so, instead of running on this folder.
  // `drill --demo` brings its own sample brain (CI runs it from the repo, G540).
  const demoDrill = cmd === "drill" && args.includes("--demo");
  if (!NO_BRAIN.has(cmd) && !demoDrill && KNOWN_COMMANDS.has(cmd) && !arg(args, "--brain") && !process.env.PB_BRAIN && !existsSync(join(root, "rules", "policy.yaml"))) {
    console.error(ownerError("cli.no-brain", { dir: root }));
    return 1;
  }

  if (cmd === "import-notion") {
    const r = importNotion(root, arg(args, "--raw"));
    console.log(`imported ${r.rows} Notion rows into ${r.files} files; report: ${r.report}`);
    return 0;
  }

  if (cmd === "uninstall") return uninstallCli(args);
  // The stdio bridge an app on this computer starts (src/local-apps.ts, docs/connect.md): no brain
  // needed, only the agent's key file. Stdout carries MCP only; everything else goes to stderr.
  if (cmd === "mcp") {
    const agent = arg(args, "--agent"), url = arg(args, "--url") ?? "http://127.0.0.1:8787";
    if (!agent) { console.error("mcp --agent <name> [--url http://127.0.0.1:8787]"); return 2; }
    if (!isLoopback(url)) { console.error(`pocketbrain mcp: ${url} isn't this computer. The bridge only talks to the hub on this machine, so a key never leaves it.`); return 2; }
    bridge({ agent, url, lines: stdinLines(), write: (t) => { process.stdout.write(t); } }).then((c) => process.exit(c), (e) => { console.error(`pocketbrain mcp: ${(e as Error).message}`); process.exit(1); });
    return -1;
  }
  // The model is this user's, not the brain's: no brain needed.
  if (cmd === "search") return searchCli(args);

  // A bundle into a fresh folder: no brain needed yet.
  if (cmd === "import") {
    const file = args[0], into = arg(args, "--into");
    if (!file || file.startsWith("--") || !into) { console.error("import <bundle> --into <dir>"); return 2; }
    try { const r = importBundle(file, into); console.log(`imported ${r.notes} notes and rules/${r.rules.join(", rules/")} into ${into}`); return 0; }
    catch (e) { console.error(`import: ${(e as Error).message}`); return 1; }
  }

  // Backups work before (restore) or beside (drill) a loadable brain, but not beside one newer
  // than this code: its backup settings and layout may not be what this version reads. A restore
  // checks the format of what it unpacks (src/backup.ts).
  if (cmd === "backup" || cmd === "drill") {
    try { const p = formatProblem(root); if (p?.kind === "newer") { console.error(p.text); return 1; } } catch (e) { console.error((e as Error).message); return 1; }
  }
  if (cmd === "backup" || cmd === "restore" || cmd === "drill") return backupCli(cmd, args, root);

  // The brain's format (src/format.ts): a newer brain stops every command here, before anything is
  // read; an older one is migrated by start and serve (dry run first), and by migrate --apply.
  if (cmd === "migrate") {
    try { console.log(renderMigrate(migrate(root, { apply: args.includes("--apply") }))); return 0; } catch (e) { console.error((e as Error).message); return 1; }
  }
  try {
    const p = formatProblem(root);
    if (p?.kind === "older" && (cmd === "start" || cmd === "serve")) console.log(renderMigrate(migrate(root, { apply: true })));
    else if (p) { console.error(p.text); return 1; }
  } catch (e) { console.error((e as Error).message); return 1; }

  const rules = loadRules(root);
  const notes = loadBrain(root);

  const withoutKey = <T extends object>(o: T, k: string): T => Object.fromEntries(Object.entries(o).filter(([x]) => x !== k)) as T;
  if (cmd === "carve") {
    const agent = args[0];
    if (!agent || agent.startsWith("--")) { console.error("carve: name the agent"); return 2; }
    const slices = arg(args, "--slices")?.split(",").map((x) => x.trim()).filter(Boolean);
    if (!slices && !rules.policy.agents[agent]) { console.error(`${agent} isn't in policy.yaml; pass --slices to try a carve`); return 2; }
    const grant = grantFor(rules, agent, slices);
    const ex = arg(args, "--exclude-types");
    if (ex) grant.exclude_types = ex.split(",").map((x) => x.trim()).filter((x) => x && x !== "none");
    // G193: a new agent granted from here leaves money out unless --exclude-types says otherwise
    // ("none" for nothing), the same default as add; the preview below is that carve.
    else if (!rules.policy.agents[agent] && args.includes("--confirm")) grant.exclude_types = ["money"];
    const why = arg(args, "--why");
    if (why) { console.log(explain(notes, rules, grant, why).join("\n")); return 0; }
    const res = carve(notes, rules, grant);
    console.log(renderPreview(notes, res));
    if (args.includes("--confirm")) {
      const existing = rules.policy.agents[agent];
      // Any program with a shell can run this, an agent included (G107). So from here a new agent
      // gets add's rules (trial, never all), and an existing one may only see less than today;
      // showing it more needs the dashboard's login (consent box), as `agent resume` does.
      if (!existing) {
        // checkNotAnArea: a new agent named after an area would see that whole area.
        try { checkNewAgent(rules, { agent, slices: grant.slices }); checkNotAnArea(rules, notes, agent); } catch (e) { console.error((e as Error).message); return 2; }
      } else {
        // G179: compared on what the agent would receive (scrubs and hidden facts included).
        const m = consent.moreThanToday(notes, rules, agent, grant);
        if (consent.widensToday(m)) { console.error(`not granted: this shows ${agent} more than it sees today (${consent.moreText(m)}). From the command line a slice can only shrink; widen it on the dashboard, on ${agent}'s page ("What is it for?"), where it needs your login.`); return 1; }
      }
      const file = join(root, "rules", "policy.yaml");
      const doc = YAML.parseDocument(readFileSync(file, "utf8"));
      doc.setIn(["agents", agent], doc.createNode({
        // G229: the exclude_types written are the ones checked; an empty list removes the key
        // rather than leaving the existing line's.
        ...withoutKey(existing ?? { tier: "trial", transport: "paste" }, "exclude_types"),
        slices: grant.slices,
        ...(grant.exclude_types.length ? { exclude_types: grant.exclude_types } : {}),
      }, { flow: true }));
      writeFileSync(file, doc.toString({ lineWidth: 0 }));
      git(root, ["add", "rules/policy.yaml"]);
      git(root, ["commit", "-q", "-m", `owner: ${agent} sees ${grant.slices.join(", ")}${grant.exclude_types.length ? ` without ${grant.exclude_types.join(", ")}` : ""}\n\nKind: carve`, "--", "rules/policy.yaml"], OWNER);
      const b = buildView(notes, loadRules(root), res, root);
      console.log(`granted. view: ${b.file} (~${b.tokens} tokens)`);
    }
    return 0;
  }

  if (cmd === "consent") {
    // Consent in plain words (src/consent.ts, docs/consent.md): a sentence in, a proposed slice out.
    const agent = args[0] && !args[0].startsWith("--") ? args[0] : "";
    if (args.includes("--apply")) {
      const slices = (arg(args, "--slices") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      const ex = (arg(args, "--exclude-types") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      if (!agent || !slices.length || !ex.length) { console.error("consent <agent> --apply --slices a,b --exclude-types money|none (the line consent printed)"); return 2; }
      try { console.log(consent.applyChoice(root, agent, slices, ex, { tightenOnly: true })); } catch (e) { console.error((e as Error).message); return 1; }
      return 0;
    }
    const intent = args.slice(1).filter((x, i, a) => !x.startsWith("--") && !(i > 0 && a[i - 1] === "--brain")).join(" ");
    if (!agent || !intent.trim()) { console.error('consent <agent> "what it is for, in one sentence" [--rules-only]'); return 2; }
    let model: Model | undefined;
    if (!args.includes("--rules-only")) try { model = modelFor(root, consent.STEP, OWNER); } catch { model = undefined; }
    consent.propose(root, agent, intent, model).then((p) => { console.log(renderConsent(p)); process.exit(0); }, (e) => { console.error((e as Error).message); process.exit(1); });
    return -1;
  }

  if (cmd === "build") {
    const agents = args.includes("--all")
      ? Object.entries(rules.policy.agents).filter(([, a]) => !a.inside_wall).map(([k]) => k)
      : [arg(args, "--agent")!].filter(Boolean);
    if (!agents.length) { console.error("build: --agent <name> or --all"); return 2; }
    for (const a of agents) {
      const res = carve(notes, rules, grantFor(rules, a));
      const b = buildView(notes, rules, res, root);
      console.log(`${a}: ${res.visible.size} notes, ~${b.tokens} tokens -> ${b.file}${res.flags.length ? ` (${res.flags.length} preview flags)` : ""}`);
    }
    return 0;
  }

  if (cmd === "inbox") {
    if (args[0] === "more") {
      // New notes a source proposed over its daily count wait in inbox/held (backlog 396).
      try { hub.hubGate(root, ["commit"]); } catch { console.error("this machine is a replica: ask on the hub"); return 1; }
      const n = Number(args[1] && !args[1].startsWith("--") ? args[1] : 5);
      if (!Number.isInteger(n) || n < 1) { console.error("inbox more [n]: how many held new notes to move back to be filed (default 5)"); return 2; }
      const moved = releaseHeld(root, n);
      console.log(`${moved} new note(s) moved back to be filed; ${heldCount(root)} still held`);
      return 0;
    }
    const f = arg(args, "--accept") ?? arg(args, "--reject");
 if (!f) { console.error("inbox --accept <file> | --reject <file>"); return 2; }
    // A full or relative path to the proposal works as well as its name in inbox/.
    const rel = existsSync(f) && resolve(f).startsWith(resolve(root, "inbox") + "/") ? relative(resolve(root), resolve(f)) : f;
    const r = decideProposal(root, rel, args.includes("--accept") ? "accept" : "reject");
    console.log(`${r.outcome}: ${r.message}`);
    return r.outcome === "refused" ? 1 : 0;
  }
  if (cmd === "filing" && args[0] === "now") {
    try { hub.hubGate(root, ["commit"]); } catch { console.error("this machine is a replica: only the hub decides for you"); return 1; }
    runAutoByHand(root).then((r) => {
      if ("refused" in r) { console.error(r.refused); process.exit(1); }
      console.log(r.done.length ? r.done.map((d) => `${d.question}: the hub ${d.picked} (${d.why})`).join("\n") : "nothing past its deadline");
      process.exit(0);
    });
    return -1;
  }
  if (cmd === "digest") {
    const r = digest(root, arg(args, "--since"));
    console.log(r.text);
    return 0;
  }

  if (cmd === "why") {
    const key = args.find((a) => !a.startsWith("--") && a.includes("#"));
    if (!key) { console.error("usage: pocketbrain why <id#attribute>   e.g. people/jane-roy#role"); return 2; }
    try {
      const w = ownerWhy(root, key);
      console.log(args.includes("--json") ? JSON.stringify(w, null, 2) : whyText(w));
      return 0;
    } catch (e) { if (e instanceof CoreError) { console.error(e.message); return 1; } throw e; }
  }

  if (cmd === "trace") {
    const id = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
    if (!id) { console.error("usage: pocketbrain trace <request-id>   the X-Request-Id an agent got back"); return 2; }
    let t: Trace;
    try { t = trace(root, id); } catch (e) { console.error((e as Error).message); return 2; }
    if (!t.request && !t.logs.length && !t.commits.length) { console.error(`no request ${id} in this brain's logs or history`); return 1; }
    console.log(args.includes("--json") ? JSON.stringify(t, null, 2) : traceText(t));
    return 0;
  }

  if (cmd === "reexplain") {
    const [agent, ...what] = args.filter((a) => !a.startsWith("--"));
    if (!agent || !what.length) { console.error('usage: pocketbrain reexplain <agent> "<what you had to explain again>"'); return 2; }
    console.log(recordReexplain(root, agent, what.join(" "), "cli"));
    return 0;
  }

  if (cmd === "fix") {
    const what = args.filter((a) => !a.startsWith("--")).join(" ");
    if (!what.trim()) { console.error('usage: pocketbrain fix "<what you had to fix by hand>"'); return 2; }
    console.log(recordFix(root, what, "cli"));
    return 0;
  }

  if (cmd === "task") {
    const d = arg(args, "--done");
    if (d !== undefined) { console.log(doneTask(root, Number(d))); return 0; }
    const cmdArg = arg(args, "--cmd");
    const what = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--cmd" && args[i - 1] !== "--brain").join(" ");
    if (what.trim()) { console.log(addTask(root, what, "cli", cmdArg ?? undefined)); return 0; }
    const open = openTasks(root);
    console.log(open.length ? open.map((t) => `${t.id}. ${t.what} (since ${t.at.slice(0, 10)})${t.cmd ? `\n   run: ${t.cmd}` : ""}`).join("\n") : "no hand tasks open");
    return 0;
  }

  if (cmd === "bar") {
    const b = bar(root, arg(args, "--end") ?? undefined);
    console.log(b.text);
    return 0;
  }

  if (cmd === "minutes") {
    const n = Number(args[0]);
    if (!Number.isFinite(n) || n < 0 || n > 600) { console.error("usage: pocketbrain minutes <minutes you spent on the brain today>"); return 2; }
    recordOwnerTime(root, "self", Math.round(n));
    console.log(`noted: ${Math.round(n)} min today`);
    return 0;
  }

  if (cmd === "week") {
    const b = arg(args, "--baseline");
    const r = week(root, arg(args, "--end") ?? undefined, b !== undefined ? Number(b) : undefined);
    console.log(r.text);
    console.log(`-> ${r.file}`);
    return 0;
  }

  if (cmd === "start" && args.includes("--launchd")) {
    // Prints (or with --write, installs into ~/Library/LaunchAgents) the plists for a Mac hub.
    const home = process.env.HOME ?? "~";
    const plists = hubPlists(root, { bun: process.execPath, app: resolve(import.meta.dir, ".."), home, tunnel: arg(args, "--tunnel"), cloudflared: arg(args, "--cloudflared"), tunnelConfig: arg(args, "--tunnel-config") });
    for (const p of plists) {
      if (args.includes("--write")) { const f = join(home, "Library", "LaunchAgents", p.file); mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true }); writeFileSync(f, p.text); console.log(`wrote ${f}
  load it: launchctl bootstrap gui/$(id -u) ${f}`); }
      else console.log(`# ~/Library/LaunchAgents/${p.file}
${p.text}`);
    }
    return 0;
  }

  if (cmd === "serve" || cmd === "start") {
    const role = hub.hubRole(root);
    if (role.mode === "replica" || role.mode === "unnamed") {
      console.error(role.mode === "replica" ? `${role.name} is a replica; ${role.cfg.hub} is the hub (rules/hub.yaml). Serve from the hub, or move it here: pocketbrain hub promote ${role.name}` : "this clone has no replica name; run pocketbrain hub init --name <machine>");
      return 1;
    }
    // Model and relay keys from ~/.config/pocketbrain/keys/ (src/secrets.ts), for launchd.
    const keys = loadKeys();
    if (keys.loaded.length) console.log(`keys from ${keysDir()}: ${keys.loaded.join(", ")}`);
    if (keys.ignored.length) console.log(`keys NOT loaded from ${keysDir()}: ${keys.ignored.join("; ")}`);
    for (const k of keys.ignored) console.error(`key ignored: ${k}`);
    // Coworkers blocked or deleted at the sign-in service are refused here too (src/offboard.ts).
    startOffboarding(root).then((on) => { if (on) console.log("coworker offboarding: on, following the sign-in service"); }, () => {});
    // OpenFGA as a second lock on each agent's slices, when rules/fga.yaml exists (src/fga.ts).
    fga.startFga(root).then((on) => { if (on) { const st = fga.fgaStatus(); console.log(`fga: on, ${st.agents.length} agent(s) confirmed${st.last_error ? `, last error: ${st.last_error}` : ""}`); } }, (e) => console.error(`fga: ${(e as Error).message}; outside agents get no slices until it answers`));
    // Each agent's reads come from its own cell (src/cell.ts) unless --no-cells. Cells on disk are
    // kept and checked on each agent's first read, so a restart answers at once (row 217).
    if (!args.includes("--no-cells")) { useCells(true); startCells(root); }
    const s = serve(root, Number(arg(args, "--port") ?? 8787), arg(args, "--host") ?? "127.0.0.1");
    console.log(`pocketbrain serving ${root} on http://${s.hostname}:${s.port} (MCP /mcp, API /v1, /openapi.json)${cellsOn() ? ", reads from per-agent cells" : ""}`);
    if (role.mode === "hub") {
      // Every few minutes: step down if a newer hub exists, take replicas' ops, apply them.
      const every = (role.cfg.tick_minutes ?? 5) * 60000;
      setInterval(() => serial(() => { try { const r = hub.tick(root); if (r?.role === "replica") console.error(`stepped down: ${r.hub} is the hub (epoch ${r.epoch}); writes now queue as ops`); } catch (e) { console.error(`hub tick: ${(e as Error).message}`); } }), every);
    }
    // Capture channels: the mailbox and the drop folder, then extraction of whatever is pending
    // (from agents, the channels, or replicas' ops), every capture.poll_minutes.
    const cap = captureConfig(rules);
    setInterval(() => void intakeTick(root).then((r) => { for (const p of r.problems) console.error(`capture: ${p}`); }, (e) => console.error(`capture tick: ${(e as Error).message}`)), cap.poll_minutes * 60000);
    // Backups from the hub: an hourly look, a backup when main moved and every_hours passed, made by a
    // child process so a backup folder that stops answering can't freeze the hub; and main pushed to
    // the brain's origin hourly when rules/backup.yaml has push_origin: true (not under serial: a push
    // only reads). Each also runs a few minutes after start when its last run is over an hour old, so
    // frequent restarts can't starve it (src/backup.ts startBackupTimers).
    bk.startBackupTimers(root, { backup: () => serial(() => bk.backupApart(root), { name: "backup", limitMs: 30 * 60_000 }).then((p) => p) });
    if (cmd === "start" || args.includes("--dashboard")) {
      const d = serveDashboard(root, { port: Number(arg(args, "--dashboard-port") ?? 8788), tailnet: args.includes("--dashboard-tailnet") || !!tailnetSettings(root).dashboard_tailnet, tailnetLogin: tailnetSettings(root).dashboard_tailnet_login, tailnetDevices: tailnetSettings(root).dashboard_tailnet_devices });
      // Never a login key here: launchd keeps this output in a log (G609). The links are in an
      // owner-only file in the brain's .git folder (src/dashboard/server.ts loginLinkFile).
      console.log(d.loginSay);
      if ("servePort" in d) console.log(`  (after tailscale serve --bg --https=${d.servePort} http://127.0.0.1:${d.server.port}; never funnel)`);
      // A person at the terminal gets the three things that matter first; the lines after are the hub's log.
      // The dashboard line above says where its sign-in link is; no key is printed here either (G609).
      if (cmd === "start" && process.stdout.isTTY) console.log(`\nYour brain is running. Leave this window open while you use your assistants.\n  Your dashboard (this computer only): the line above says how to open it\n  Connect an app on this computer:    pocketbrain add cursor --kind cursor --write --yes   (or vscode, codex, gemini, claude-desktop, mcp; docs/connect.md)\n  Is everything healthy?              pocketbrain doctor\nWhat follows is the hub's own log.\n`);
      if ("tailnetProblem" in d) console.error(d.tailnetProblem);
    }
    // A stop (launchd, Ctrl-C) keeps what this hub parsed for the next start (src/brain.ts); start
    // exits through its own handlers below, which save it on exit too.
    if (cmd === "serve") for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { try { saveParseSnapshots(); } finally { process.exit(0); } });
    if (cmd === "start") {
      // Hand restarts count against the real-use bar (src/measure.ts noteStart); planned ones
      // don't count toward the probe's restart loop either (startKind, before noteStart logs this start).
      const b = appBuild(resolve(import.meta.dir, ".."));
      startJobs(root, { localUrl: `http://127.0.0.1:${s.port}`, startKind: startKind(root, { build: b.build, codeMovedAt: b.movedAt }) });
      const hand = noteStart(root, { build: b.build, codeMovedAt: b.movedAt });
      if (hand) console.log(handFixNotice(hand));
      for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { try { noteStop(root, sig); } finally { process.exit(0); } });
    }
    return -1; // keep running
  }
  if (cmd === "watchdog") {
    // One look at the hub from outside it (launchd runs this every 5 minutes; src/watchdog.ts).
    watchdogTick(root, { url: arg(args, "--url") ?? "http://127.0.0.1:8787", uid: process.getuid?.() ?? 501, platform: process.platform,
      run: (c) => { const p = Bun.spawnSync(c, { stdout: "pipe", stderr: "pipe", timeout: 30_000 }); return { code: p.exitCode ?? 1, out: `${p.stdout}${p.stderr}` }; } }).then((r) => {
      if (r.action !== "ok") console.log(`${new Date().toISOString()} watchdog ${r.action}: ${r.detail}`);
      process.exit(r.action === "ok" || r.action === "waiting" ? 0 : 1);
    }, (e) => { console.error(`watchdog: ${(e as Error).message}`); process.exit(1); });
    return -1;
  }
  if (cmd === "dashboard" && args[0] === "tailnet") {
    const on = args[1] === "on";
    if (!on && args[1] !== "off") { console.error("dashboard tailnet on --device <Tailscale address> [--device …] | off"); return 2; }
    const devices = args.flatMap((a, i) => (args[i - 1] === "--device" ? [a] : []));
    try { console.log(setDashboardTailnet(root, on, devices)); }
    catch (e) { console.error((e as Error).message); return e instanceof OwnerSetError && !/on the hub|couldn't commit/.test((e as Error).message) ? 2 : 1; }
    console.log(`restart the hub to apply it (${on ? "then pocketbrain dashboard phone-link gives a link to open on the device" : "the dashboard goes back to this machine only"})`);
    return 0;
  }
  // The phone app's paired phones (docs/phone-app.md): names and dates only, never a key.
  if (cmd === "dashboard" && args[0] === "phones") {
    if (args[1] === "remove") {
      const which = args[2];
      if (!which || which.startsWith("--")) { console.error("usage: pocketbrain dashboard phones remove <name>|all"); return 2; }
      const gone = removeAppPhones(root, which);
      if (!gone.length) { console.error(`No paired phone is called "${which}" (pocketbrain dashboard phones lists them)`); return 1; }
      console.log(`Removed ${gone.join(", ")}: its Face ID sign-in and its sign-ins end now`);
      return 0;
    }
    const phones = appPhones(root);
    if (!phones.length) { console.log("No phone is paired. Open a phone link (pocketbrain dashboard phone-link) in the pocketBrain app to pair one."); return 0; }
    for (const p of phones) console.log(`${p.name}: paired ${p.at.slice(0, 10)}${p.last ? `, last signed in with Face ID ${p.last.slice(0, 10)}` : ""}`);
    return 0;
  }
  // Pair the owner's phone in one command (src/phone.ts, docs/phone-app.md): the tailnet settings
  // shown and written only on a yes, tailscale serve, a hub restart, then the pair link as a QR.
  if (cmd === "phone") {
    const home = process.env.HOME ?? homedir();
    const mac = process.platform === "darwin" && !!installedBrain(home);
    const run: Run = (c) => { const r = Bun.spawnSync(c, { stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode ?? 1, out: `${r.stdout}${r.stderr}` }; };
    try {
      return pairPhone({
        device: arg(args, "--device"), yes: args.includes("--yes"),
        ask: process.stdin.isTTY ? (q) => prompt(q) : undefined,
        port: Number(arg(args, "--port") ?? tailnetSettings(root).dashboard_port ?? 8788),
        restart: mac && !args.includes("--no-restart") ? () => restartHub({ home, uid: process.getuid?.() ?? 501, run }) : undefined,
        mint: () => mintPhoneLink(root), setTailnet: (devices, login) => setDashboardTailnet(root, true, devices, login),
        settings: () => tailnetSettings(root), rulesFile: hub.loadHub(root) ? "rules/hub.yaml" : "rules/policy.yaml",
        say: (t) => console.log(t),
      });
    } catch (e) { console.error((e as Error).message); return 1; }
  }
  // A sign-in link for the phone that outlives a restart: once, for a day, on the tailnet only.
  if (cmd === "dashboard" && args[0] === "phone-link") {
    const t = tailnetSelf();
    if (!tailnetSettings(root).dashboard_tailnet || !t?.address) { console.error("the dashboard isn't on your tailnet: pocketbrain dashboard tailnet on --device <your phone's Tailscale address>"); return 1; }
    console.log(`open on your phone or paste in the pocketBrain app (works once, for a day): ${phoneLinkUrl(t, tailnetSettings(root).dashboard_tailnet_login, mintPhoneLink(root), Number(arg(args, "--port") ?? 8788))}`);
    return 0;
  }
  if (cmd === "dashboard") {
    const key = process.env.AGENTMAIL_RELAY_KEY;
    if (args.includes("--agentmail") && !key) { console.error("set AGENTMAIL_RELAY_KEY (a key scoped to the relay inbox only)"); return 2; }
    const transport = args.includes("--agentmail") ? () => agentMailTransport(loadRelayConfig(root), key!) : undefined;
    const d = serveDashboard(root, { port: Number(arg(args, "--port") ?? 8788), transport, tailnet: args.includes("--tailnet") || !!tailnetSettings(root).dashboard_tailnet, tailnetLogin: tailnetSettings(root).dashboard_tailnet_login, tailnetDevices: tailnetSettings(root).dashboard_tailnet_devices });
    console.log(`owner dashboard for ${root}\nopen (this machine only, link works until restart): ${d.loginUrl}`);
    if ("tailnetLoginUrl" in d) console.log(`on your tailnet (your devices only): ${d.tailnetLoginUrl}`);
    if ("serveLoginUrl" in d) console.log(`  or over https, after tailscale serve --bg --https=${d.servePort} http://127.0.0.1:${d.server.port} (never funnel): ${d.serveLoginUrl}`);
    if ("tailnetProblem" in d) console.error(d.tailnetProblem);
    return -1;
  }
  if (cmd === "connect") {
    const agent = args.find((a) => !a.startsWith("--"));
    if (!agent) { console.error("connect <agent> [--url https://brain.example] [--code <one-time code>]"); return 2; }
    const a = loadRules(root).policy.agents[agent];
    if (!a || a.inside_wall) { console.error(`no outside agent ${agent} in rules/policy.yaml`); return 1; }
    const url = (arg(args, "--url") ?? "http://127.0.0.1:8787").replace(/\/$/, "");
    const code = arg(args, "--code");
    try {
      if (args.includes("--browser")) { connectBrowser(root, agent, url, args.includes("--key-only"), code); return 0; }
      // An existing agent (the one init made) connected to Claude Code in one go, as add --kind does.
      const kind = arg(args, "--kind");
      if (kind !== undefined) {
        if (!(kind in KINDS)) { console.error(`connect --kind takes ${Object.keys(KINDS).join(", ")}`); return 2; }
        return connectKind(root, agent, kind as Kind, url, undefined, code, args.includes("--write"));
      }
      printConnect(root, agent, a.transport === "api" ? "api" : "mcp", url, `connect ${agent}`, code);
    } catch (e) { console.error((e as Error).message); return 1; }
    return 0;
  }
  if (cmd === "add") {
    const agent = args[0] && !args[0].startsWith("--") ? args[0] : "";
    // Switch day: --like starts from another agent's carve and defaults to an invite.
    const like = arg(args, "--like");
    // --kind: the kind of assistant picks the door and, without --slices, a preset slice.
    const kind = arg(args, "--kind");
    if (kind !== undefined && !(kind in KINDS)) { console.error(`--kind is ${Object.keys(KINDS).join(", ")}`); return 2; }
    const kindDoor = kind ? KINDS[kind as Kind] : undefined;
    if (kindDoor && arg(args, "--door") && arg(args, "--door") !== kindDoor) { console.error(`--kind ${kind} uses --door ${kindDoor}; leave --door out`); return 2; }
    const door = kindDoor ?? arg(args, "--door") ?? (like ? "invite" : "mcp");
    const name = arg(args, "--name");
    if (!["mcp", "oauth", "api", "local", "invite", "browser"].includes(door) || (door === "browser" && !kind)) { console.error("--door is mcp, oauth, api, local or invite"); return 2; }
    if (door === "oauth" && !oauth.loadOAuth(root)) { console.error("no OAuth door yet: set it up first (docs/oauth.md, pocketbrain oauth setup)"); return 1; }
    const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    let req: NewAgent = {
      agent, name, transport: door === "api" ? "api" : "mcp",
      slices: kind && !arg(args, "--slices") ? slicePreset(loadRules(root), kind as Kind) : list(arg(args, "--slices")),
      exclude_types: list(arg(args, "--exclude-types") ?? "money").filter((x) => x !== "none"),
    };
    try {
      if (like) {
        // Extra --slices and --exclude-types add to the copy; nothing given here can drop one of its leave-outs.
        const base = likeAgent(loadRules(root), like);
        req = { ...req, ...base, slices: [...new Set([...base.slices, ...req.slices])], exclude_types: [...new Set([...base.exclude_types!, ...list(arg(args, "--exclude-types")).filter((x) => x !== "none")])], transport: door === "api" ? "api" : door === "invite" ? base.transport : "mcp" };
      }
      const head = like ? `${agent || "<new>"} like ${like}: ${req.slices.join(", ")}, leaving out ${req.exclude_types!.join(", ")}${req.exclude?.length ? ` and ${req.exclude.length} note(s) by name` : ""}. Trial, whatever ${like} is: it sees up to ${req.max_sensitivity ?? "personal"} and its writes wait for you.\n` : "";
      if (!args.includes("--yes")) {
        console.log(head + previewNewAgent(root, req).text);
        if (kind) console.log(`\nSlices: ${req.slices.join(", ")}; money left out; trial (its writes wait for you).`);
        // On a terminal, --kind asks here instead of making you run the command again.
        if (!(kind && process.stdin.isTTY && /^y(es)?$/i.test(String(prompt("Grant it? [y/N]") ?? "").trim()))) { console.log(`\nNothing granted yet. If this is right, run the same command with --yes.`); return 0; }
      }
      // G241: a door that makes a token here needs an agent no wider than add's default; checked
      // before anything is granted. The OAuth door needs your own sign-in, so it isn't limited.
      if (door !== "oauth") {
        const r0 = loadRules(root);
        const hypo = { ...r0, policy: { ...r0.policy, agents: { ...r0.policy.agents, [agent]: { tier: "trial" as const, slices: req.slices, exclude_types: req.exclude_types, ...(req.max_sensitivity ? { max_sensitivity: req.max_sensitivity } : {}) } } } };
        const why = reachRefusal(hypo, agent);
        if (why) { console.error(`${agent}: ${why}, so a terminal alone can't make it a ${door === "invite" ? "code" : "token"}. Nothing granted. Narrow it (one area, money left out), or use --door oauth (your own sign-in), or add it on the dashboard and make its key with a one-time code from its page.`); return 1; }
      }
      console.log(head + addAgent(root, req).text);
    } catch (e) { console.error(`add <agent> --kind claude-ai|claude-code|cursor|vscode|codex|gemini|claude-desktop|mcp|town|browser | --slices a,b | --like <agent> [--door mcp|oauth|api|local|invite] [--url https://brain.example] [--name Label] [--yes]\n${(e as Error).message}`); return agent && (req.slices.length || like) ? 1 : 2; }
    const fresh = loadRules(root);
    const url = (arg(args, "--url") ?? "http://127.0.0.1:8787").replace(/\/$/, "");
    console.log(`\n${agent} added as a trial agent: it sees the slice above, and everything it writes waits for you.\n`);
    // G184: add grants the agent; its token still passes the terminal gate (a wider preset needs the code).
    if (kind) { try { return connectKind(root, agent, kind as Kind, url, name, undefined, args.includes("--write")); } catch (e) { console.error((e as Error).message); return 1; } }
    if (door === "oauth") {
      const e = oauth.expectClient(root, agent, { name });
      const mins = Math.round((Date.parse(e.until) - Date.parse(e.opened)) / 60_000);
      console.log(`In ${agent}'s connector settings, add the MCP server ${url}/mcp/oauth and sign in with your own account.\nYour next new sign-in in the next ${mins} minutes (until ${e.until}) is approved as ${agent}, once. A later one waits for you on the dashboard's Assistants page.`);
      console.log(`\nThen paste this once into ${agent}'s own custom instructions, so it checks the brain without being asked:\n\n${standingInstruction(fresh, "mcp", url)}`);
      return 0;
    }
    if (door === "invite") {
      printInvite(root, agent, url);
      console.log(`\n${agent} finds its standing instruction in its orientation and saves it itself. If it keeps no instructions of its own, paste this once where it does:\n\n${standingInstruction(fresh, req.transport ?? "mcp", url)}`);
      if (like) console.log(`\nOnce ${agent} answers from your brain, cut ${like} off: pocketbrain token --revoke ${like}`);
      return 0;
    }
    if (door === "local") {
      const tok = mintFromShell(root, agent, { via: `add ${agent}` });
      console.log(`For Claude Code on this machine:\n  claude mcp add --scope user --transport http pocketbrain http://127.0.0.1:${arg(args, "--port") ?? "8787"}/mcp --header "Authorization: Bearer ${tok}"`);
      console.log(`\nThen add this once to ~/.claude/CLAUDE.md, so it checks the brain without being asked:\n\n${standingInstruction(fresh, "mcp", url)}`);
      console.error(`token printed once; only its hash is in rules/tokens.yaml. Revoke: pocketbrain token --revoke ${agent}`);
      return 0;
    }
    printConnect(root, agent, door === "api" ? "api" : "mcp", url, `add ${agent}`);
    return 0;
  }
  if (cmd === "invite") {
    const agent = args[0] && !args[0].startsWith("--") ? args[0] : "";
    if (!agent) { console.error("invite <agent> [--minutes 15] [--url https://brain.example]"); return 2; }
    try { printInvite(root, agent, (arg(args, "--url") ?? "http://127.0.0.1:8787").replace(/\/$/, ""), arg(args, "--minutes") ? Number(arg(args, "--minutes")) : undefined); }
    catch (e) { console.error((e as Error).message); return 1; }
    return 0;
  }
  if (cmd === "share") {
    // Slice sharing for a collaborator (src/share.ts): previews first; --yes is the owner's click.
    const [sub, agent] = args;
    const days = arg(args, "--days") ? Number(arg(args, "--days")) : undefined;
    try {
      if (sub === "list") {
        const rows = share.listShares(root);
        for (const r of rows) console.log(`${r.agent}  ${r.name}  ${r.slices.join(", ")}  ${r.ended ? `ended ${r.ended}` : r.active ? `until ${r.until}` : `ran out ${r.until}`}`);
        if (!rows.length) console.log("not sharing with anyone");
        return 0;
      }
      if (sub === "add" && agent && !agent.startsWith("--")) {
        const req = { agent, name: arg(args, "--name") ?? "", slices: (arg(args, "--slices") ?? "").split(",").map((x) => x.trim()).filter(Boolean), days };
        const p = args.includes("--yes") ? share.addShare(root, req) : share.previewShare(root, req);
        console.log(p.text);
        if (!args.includes("--yes")) { console.log(`\n${p.name} would see this, read-only, until ${p.until}. Nothing shared yet. If this is right, run the same command with --yes.`); return 0; }
        console.log(`\nShared with ${p.name} as ${agent} until ${p.until}, read-only.\nTheir assistant connects with a one-time code: ${shellMintRefusal(root, agent) ? `on the dashboard, open ${agent}'s page and press "One-time code" (this share is wider than a terminal may invite for); their assistant redeems it at <your public url>/v1/enroll` : `pocketbrain invite ${agent} --url <your public url>`}\n(or, with the sign-in door, pocketbrain oauth coworker add <subject> --name "${p.name}" --agent ${agent}). End it any time: pocketbrain share end ${agent}`);
        return 0;
      }
      if (sub === "extend" && agent && days !== undefined) { console.log(share.extendShare(root, agent, days)); return 0; }
      if (sub === "end" && agent) { console.log(share.endShare(root, agent)); asks.cancelAsks(root, agent); cancelActions(root, agent, "share ended"); return 0; }
    } catch (e) { console.error((e as Error).message); return 1; }
    console.error('share add <agent> --name "<person>" --slices a,b [--days 30] [--yes] | list | extend <agent> --days N | end <agent>');
    return 2;
  }
  if (cmd === "menubar") return menubarCli(args, root);
  if (cmd === "agent" && args[0] === "tier") {
    try { const r = setAgentTier(root, args[1] ?? "", args[2] ?? "", { dryRun: args.includes("--dry-run") }); console.log(r); return 0; }
    catch (e) { console.error((e as Error).message); return e instanceof OwnerSetError && !/on the hub|couldn't commit|by hand/.test((e as Error).message) ? 2 : 1; }
  }
  if (cmd === "agent") {
    // The owner's switches for one agent, from the menu-bar app or a terminal. Here they only tighten
    // (active, then read-only, then paused, or revoke): anything that can run a shell can call this,
    // so loosening a switch is the dashboard's, behind the owner's login (docs/menubar.md).
    const [verb, agent] = args;
    if (verb === "resume") { console.error("resume an agent on the dashboard's Assistants page: loosening a switch needs your login"); return 2; }
    const status = verb === "pause" ? "paused" : verb === "read-only" ? "read-only" : undefined;
    if (!agent || agent.startsWith("--") || (!status && verb !== "revoke")) { console.error("agent pause|read-only|revoke <agent>"); return 2; }
    const RANK = { active: 0, "read-only": 1, paused: 2 } as const;
    const now = loadRules(root).policy.agents[agent]?.status ?? "active";
    if (status && RANK[status] < RANK[now]) { console.error(`${agent} is ${now}; making it ${status} loosens the switch, so do it on the dashboard's Assistants page`); return 1; }
    try { console.log(runAction({ root }, status ? "agent-status" : "agent-revoke", { agent, status: status ?? "" })); }
    catch (e) { if (e instanceof CoreError) { console.error(e.message); return 1; } throw e; }
    return 0;
  }
  if (cmd === "token" && args[0] === "rotate") {
    // A new token with the old one still working for an overlap (docs/add-an-agent.md#rotating-a-token).
    const agent = args[1] && !args[1].startsWith("--") ? args[1] : "";
    const role = arg(args, "--role") as TokenRole | undefined;
    const overlapHours = Number(arg(args, "--overlap") ?? 24);
    if (!agent) { console.error("token rotate <agent> [--role reader] [--overlap <hours, default 24>] [--url https://brain.example] [--code <code>] [--yes]"); return 2; }
    const rules = loadRules(root), a = Object.hasOwn(rules.policy.agents, agent) ? rules.policy.agents[agent] : undefined;
    const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
    if (!args.includes("--yes")) {
      if (!a || a.inside_wall) { console.error(`${agent} isn't an outside agent in policy.yaml`); return 1; }
      const old = (tokenInfo(root)[agent] ?? []).filter((e) => (e.role ?? undefined) === role);
      const ends = new Date((process.env.PB_NOW ? Date.parse(process.env.PB_NOW) : Date.now()) + overlapHours * 3_600_000).toISOString();
      console.log(`${agent} sees: ${(a.slices ?? []).join(", ") || "nothing"}${a.exclude_types?.length ? ` (minus ${a.exclude_types.join(", ")})` : ""}
A new ${role ? `${role} ` : ""}token for ${agent}, with the same slice. ${old.length ? `Its ${old.length} current ${role ? `${role} ` : ""}token(s) keep working until ${when(ends)}, then stop.` : "It has no current token to end."}

Nothing changed yet. If this is right, run the same command with --yes${shellMintRefusal(root, agent) && !arg(args, "--code") ? ` --code <code> (from the terminal, ${agent} needs your one-time code: on the dashboard, open its page and press "One-time code")` : ""}.`);
      return 0;
    }
    // G184: rotating mints a token, so it passes the terminal gate like every other door.
    let r!: ReturnType<typeof rotateToken>;
    try { mintFromShell(root, agent, { via: `token rotate ${agent}${role ? ` --role ${role}` : ""} --yes`, code: arg(args, "--code"), role, mint: () => (r = rotateToken(root, agent, { role, overlapHours })).token }); } catch (e) { console.error((e as Error).message); return 1; }
    const url = (arg(args, "--url") ?? hub.loadHub(root)?.public_url ?? "http://127.0.0.1:8787").replace(/\/$/, "");
    // An app on this computer reads its key from its key file (src/local-apps.ts): the new key goes
    // there, never on screen, so the app keeps working once the old one stops.
    let hasKeyFile = false;
    try { hasKeyFile = existsSync(agentKeyFile(agent)); } catch { /* not a plain name: no key file can exist */ }
    if (!role && hasKeyFile) {
      const file = saveAgentKey(agent, r.token);
      console.log(`The new key for ${agent} is in ${file}, readable only by you. Quit the app and open it again so it uses it: ${r.expiring ? `the old key keeps working until ${when(r.expires)}, then stops` : "it had no other key"}.`);
      return 0;
    }
    if (role) console.log(`${role} token for ${agent}: ${r.token}`);
    else printConnect(root, agent, a!.transport === "api" ? "api" : "mcp", url, `token rotate ${agent}`, undefined, r.token);
    console.log(`\nPaste the new token into ${agent} now: ${r.expiring ? `the old token keeps working until ${when(r.expires)}, then stops` : "it had no other token"}.`);
    return 0;
  }
  if (cmd === "token") {
    const rev = arg(args, "--revoke");
    if (rev) {
      // G336: a revoke that can't take the invites lock throws before any key goes; asks and actions are cancelled either way.
      let code = 0;
      try { console.log(`revoked ${revokeTokens(root, rev)} token(s) for ${rev}`); if (dropAgentKey(rev)) console.log(`deleted ${rev}'s key file on this computer`); } catch (e) { console.error((e as Error).message); code = 1; }
      asks.cancelAsks(root, rev); cancelActions(root, rev, "access revoked");
      return code;
    }
    const agent = arg(args, "--agent");
    const role = arg(args, "--role");
    if (!agent || (role !== undefined && !TOKEN_ROLES.includes(role as TokenRole))) { console.error("token --agent <agent> [--role reader|resolver] [--code <one-time code>] | --revoke <agent>"); return 2; }
    // G184: a narrow agent, or the owner's one-time code from the dashboard (src/invite.ts).
    try { console.log(mintFromShell(root, agent, { via: `token --agent ${agent}${role ? ` --role ${role}` : ""}`, code: arg(args, "--code"), role: role as TokenRole | undefined })); } catch (e) { console.error((e as Error).message); return 1; }
    console.error(`${role ? `${role} ` : ""}token for ${agent} printed once; only its hash is in rules/tokens.yaml`);
    return 0;
  }
  if (cmd === "ask" && args[0] !== "on" && args[0] !== "off") {
    const sub = args[0];
    if (sub === "list") {
      for (const a of asks.listAsks(root).slice(-30)) console.log(`${a.id}  ${a.at.slice(0, 16)}  ${a.agent}  ${a.state}  "${a.what}"  ${a.candidates.map((c) => c.id).join(", ") || "(no match)"}${a.approved ? `  approved via ${a.approved.via}: ${a.approved.note}` : ""}`);
      return 0;
    }
    // G244 (invariant 13): an approval comes only from the dashboard or a CIBA approval. Any program
    // with a shell can run the CLI, an agent that asked included, so `approve` isn't here.
    if (sub === "approve") { console.error("approve an ask on the dashboard (Overview, Asks to see) or on your phone: an approval from a terminal could be the asking agent's own"); return 1; }
    if (sub === "decline" && args[1]) { console.log(asks.declineAsk(root, args[1], "cli")); return 0; }
    if (sub === "test") {
      loadKeys();
      asks.testPush(root).then((m) => { console.log(m); process.exit(/^(approved|denied)/.test(m) ? 0 : 1); }, (e) => { console.error((e as Error).message); process.exit(1); });
      return -1;
    }
    console.error("ask on [flags] | off | list | decline <id> | test (approve on the dashboard)");
    return 2;
  }
  if (cmd === "golden") {
    // The golden set (src/golden.ts): the owner's weekly questions through an agent's view.
    const r = runGolden(root, { agent: args[0] && !args[0].startsWith("--") ? args[0] : undefined, file: arg(args, "--file") });
    console.log(args.includes("--json") ? JSON.stringify(r.rows) : r.text);
    return r.file && !r.rows.some((x) => x.grade === "fail") ? 0 : 1;
  }
  if (cmd === "exam") {
    // The memory exam (src/exam.ts): each agent's own memory against the brain, from the logs.
    // --quiz first asks each agent fresh questions; they're graded when it next calls memory_check.
    const agent = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
    if (args.includes("--quiz")) console.log(`asked: ${JSON.stringify(memsync.syncPass(root, Number(arg(args, "--n") ?? 3), agent ? [agent] : undefined))}`);
    const r = examRun(root, Number(arg(args, "--days") ?? 7), agent);
    console.log(r.text);
    console.log(`-> ${r.file}`);
    return r.rows.some((x) => x.grade === "fail") ? 1 : 0;
  }
  if (cmd === "diary" && args[0] === "catchup") {
    // The owner's diary catching up with fact changes that came without a line (src/diary-catchup.ts).
    // --dry-run reads and counts only: nothing is written, not even the cursor.
    const r = catchUpDiary(root, new Date(), { dryRun: args.includes("--dry-run") });
    console.log(JSON.stringify(r, null, 2));
    return r.unsaved ? 1 : 0;
  }
  if (cmd === "fill") {
    // Is the brain filling? (src/fill.ts): the capture pipeline per source, against the targets.
    const f = fillMod.fill(root, Number(arg(args, "--days") ?? 7));
    console.log(args.includes("--json") ? JSON.stringify(f, null, 2) : fillMod.renderFill(f));
    return 0;
  }
  if (cmd === "beliefs") {
    // Belief radar (src/beliefs.ts): every assistant's memory per fact, and fix-everywhere.
    if (args[0] === "fix" && args[1]) {
      try { console.log(JSON.stringify(beliefsMod.fixEverywhere(root, args[1]), null, 2)); return 0; } catch (e) { console.error((e as Error).message); return 1; }
    }
    if (args[0] === "plan") {
      // Quiz budget (src/quizplan.ts): report by default; --ask spends it.
      const perWeek = Number(arg(args, "--per-week") ?? quizplan.QUIZ_PER_WEEK);
      if (!Number.isInteger(perWeek) || perWeek < 0) { console.error("--per-week takes a whole number"); return 1; }
      if (args.includes("--ask")) { console.log(JSON.stringify(quizplan.runQuizPlan(root, { perWeek }), null, 2)); return 0; }
      const p = quizplan.quizPlan(root, { perWeek });
      console.log(args.includes("--json") ? JSON.stringify(p, null, 2) : quizplan.renderPlan(p, perWeek));
      return 0;
    }
    const b = beliefsMod.beliefs(root);
    if (args.includes("--json")) console.log(JSON.stringify(b, null, 2));
    else console.log(beliefsMod.renderBeliefs(b, { onlyRed: args.includes("--red"), agent: arg(args, "--agent") }));
    return 0;
  }
  if (cmd === "memsync") {
    // Agent memory sync (src/memsync.ts): scan readable memories, quiz the others, and decide.
    const sub = args[0];
    // The kill switch: prints the policy.yaml edit; rules/ is the owner's to change.
    if (sub === "off" || sub === "on") {
      try { console.log(memsync.switchEdit(root, sub, args.slice(1))); return 0; } catch (e) { console.error((e as Error).message); return 2; }
    }
    if (sub === "run") { console.log(JSON.stringify(memsync.syncPass(root, Number(arg(args, "--n") ?? 3), args[1] && !args[1].startsWith("--") ? [args[1]] : undefined), null, 2)); return 0; }
    if (sub === "scan" && args[1]) {
      const f = memsync.scan(root, args[1]);
      for (const x of f) console.log(`${x.file}:${x.line}  ${x.key}  ${x.kind}  "${x.wrong}"${x.correction ? `  -> ${x.correction}` : "  (already proposed)"}`);
      if (!f.length) console.log(`nothing out of sync in ${memsync.memoryFiles(loadRules(root), args[1]).length} file(s)`);
      return 0;
    }
    if (sub === "report" && args[1]) {
      const r = memsync.driftReport(root, args[1]);
      console.log(args.includes("--json") ? JSON.stringify(r, null, 2) : memsync.renderDrift(r));
      return 0;
    }
    if (sub === "quiz" && args[1]) { for (const q of memsync.quiz(root, args[1], Number(args[2] ?? 3))) console.log(`${q.id}  ${q.key}  ${q.question}`); return 0; }
    if (sub === "list") {
      const s = memsync.state(root);
      const all = args.includes("--all");
      // Agent-written text, quoted on one line: no escapes or forged lines reach the terminal (G195).
      const t = (x: string) => JSON.stringify(memsync.oneLine(x));
      for (const q of s.quizzes.filter((x) => all || x.state === "open" || x.verdict === "drift" || x.verdict === "differs").slice(-30))
        console.log(`${q.id}  ${q.agent}  ${q.key}  ${q.state}${q.verdict ? ` ${q.verdict}: ${t(q.answer ?? "")}` : ""}${q.recheck ? `  (recheck of ${q.recheck})` : ""}`);
      for (const c of s.corrections.filter((x) => all || !["declined", "verified"].includes(x.state)).slice(-30))
        console.log(`${c.id}  ${c.agent}  ${c.state}  ${c.kind} ${memsync.oneLine(c.about)}: ${t(c.wrong)}${c.right ? ` -> ${t(c.right)}` : ""}  ${c.from.file ? `${t(c.from.file)}:${c.from.line}` : `quiz ${c.from.quiz}`}${c.note ? `  (${memsync.oneLine(c.note)})` : ""}`);
      return 0;
    }
    if (sub === "approve" && args[1]) { console.log(memsync.approve(root, args[1])); return 0; }
    if (sub === "decline" && args[1]) { console.log(memsync.decline(root, args[1])); return 0; }
    if (sub === "key") { console.log(memsync.publicKey()); return 0; }
    // Bring memory in: an agent's files (default: its memory.files) or the owner's own notes ("me").
    // Every fact becomes a proposal; nothing is committed until the owner accepts it.
    if (sub === "import" && args[1]) {
      loadKeys(); // ANTHROPIC_API_KEY (or the step's key) from ~/.config/pocketbrain/keys/, as the hub does
      { const why = pausedReason(root, CAPTURE_STEP); if (why) { console.error(`import ${why}`); return 1; } }
      const who = args[1];
      // Without the step's key every file is still stored, for the hub's capture pass to read once
      // it has one (G580: the first file's model call threw and the rest were never stored).
      const cfg = modelConfigFor(root, CAPTURE_STEP), env = cfg.api_key_env ?? KEY_ENV[cfg.provider];
      const model = env && !process.env[env] ? undefined : modelFor(root, CAPTURE_STEP, who === ME ? "capture" : who);
      const given = args.slice(2).filter((x) => !x.startsWith("--"));
      for (const s of skippedMemory(given)) console.log(`${s.name}: ${s.shape === "gemini-activity" ? "Gemini activity" : "chat history"}, not memory; nothing imported (pocketbrain logs import keeps chats)`);
      importMemory(root, who, given, model).then((rs) => {
        for (const { name, result: r } of rs) {
          const state = r.refused ? `refused: ${r.refused}` : r.duplicate ? "already imported" : r.held ? `held for you: ${r.held.join("; ")}` : r.queued ? `queued as ${r.queued}` : !model ? "stored, waiting for a model to read it" : `${r.items.filter((i) => i.proposal).length} proposal(s), ${r.items.filter((i) => i.status === "known").length} already known`;
          console.log(`${name}: ${state}`);
        }
        if (!model) console.log("No model key, so nothing was read yet: the hub's capture pass reads these once it has one (ANTHROPIC_API_KEY in ~/.config/pocketbrain/keys/, or the step rules/models.yaml names).");
        console.log(afterImport(root, who));
        process.exit(0);
      }, (e) => { console.error(String(e.message ?? e)); process.exit(1); });
      return -1;
    }
    if (sub === "ask" && args[1]) { console.log(memsync.askDump(root, args[1])); return 0; }
    if (sub === "pointers" && args[1]) {
      const f = memsync.pointers(root, args[1]);
      for (const x of f) console.log(`${x.file}:${x.line}  ${x.key}  copy of "${x.wrong}"${x.correction ? `  -> ${x.correction}` : "  (already proposed)"}`);
      if (!f.length) console.log("no copied facts found");
      return 0;
    }
    if (sub === "brainfirst") {
      for (const u of memsync.brainFirst(root, Number(args[1] ?? 7))) {
        console.log(`${u.agent}: ${u.unread.length} of ${u.writes} write(s) without reading the brain first`);
        for (const x of u.unread.slice(-10)) console.log(`  ${x.at.slice(0, 16)}  ${x.key}  ${x.outcome}`);
      }
      return 0;
    }
    console.error("memsync off|on [corrections|change_feed|quiz…] | run [agent] [--n 3] | scan <agent> | report <agent> [--json] | quiz <agent> [n] | list [--all] | approve <id> | decline <id> | key | import <agent|me> [files…] | ask <agent> | pointers <agent> | brainfirst [days]");
    return 2;
  }
  if (cmd === "tend") {
    if (!args.includes("--managed")) { console.error("tend --managed [--agent g] [--dir ~/pocketbrain-agents] [--url https://brain.example] [--profile pocketbrain] [--nightly-model m] [--weekly-model m] [--force] [--apply --code <code>]"); return 2; }
    // G240/G285: --apply puts the gardener's token in a vault through ant, so from a terminal it
    // needs the gardener's rotation code; refused here, before anything reaches ant.
    if (args.includes("--apply") && !args.includes("--describe") && arg(args, "--code") === undefined) { console.error(`tend --managed --apply needs your yes: on the dashboard, open the gardener's page, press "Rotation code", then run the same command with --code <code>. Nothing changed.`); return 1; }
    let plan: TendPlan;
    try { plan = tendPlan(root, { agent: arg(args, "--agent"), dir: arg(args, "--dir"), url: arg(args, "--url"), profile: arg(args, "--profile"), nightlyModel: arg(args, "--nightly-model"), weeklyModel: arg(args, "--weekly-model") }); }
    catch (e) { console.error((e as Error).message); return 1; }
    const w = writeTendFiles(plan, { force: args.includes("--force") });
    console.log(`The gardener (${plan.agent}) for ${plan.owner}, at ${plan.mcpUrl}, ${plan.timezone}: nightly "${plan.nightlyCron}", weekly "${plan.weeklyCron}".`);
    for (const f of w.written) console.log(`  wrote ${join(plan.dir, f)}`);
    for (const f of w.kept) console.log(`  kept  ${join(plan.dir, f)} (yours; --force to replace)`);
    for (const f of w.fixed) console.log(`  fixed ${join(plan.dir, f)}: its budget was 10 cents, now 1000 cents ($10); the next --apply updates the deployment`);
    if (args.includes("--describe")) {
      if (!args.includes("--apply")) { console.log(`\nNothing sent to Anthropic yet. Next: pocketbrain tend --managed --describe --apply, then pocketbrain gardener open 60 and ant --profile ${plan.profile} beta:deployments run --deployment-id <describe id in claude-lock.json>.`); return 0; }
      const d = applyDescribe(root, plan);
      for (const l of d.lines) (d.ok ? console.log : console.error)(`  ${l}`);
      if (d.ok) console.log(`\nThe describe deployment is paused. First run by hand: pocketbrain gardener open 60, then ant --profile ${plan.profile} beta:deployments run --deployment-id <describe id>. Its suggestions wait on each org's page.`);
      return d.ok ? 0 : 1;
    }
    if (!args.includes("--apply")) { console.log(`\nNothing sent to Anthropic yet. Next:\n${manualSteps(plan)}`); return 0; }
    const r = applyManaged(root, plan, { code: arg(args, "--code") });
    for (const l of r.lines) (r.ok ? console.log : console.error)(`  ${l}`);
    if (r.ok) console.log(`\nBoth deployments are paused. First run by hand: pocketbrain gardener open 60, then ant --profile ${plan.profile} beta:deployments run --deployment-id <nightly id>. Read its proposals in the dashboard before you unpause anything.`);
    return r.ok ? 0 : 1;
  }
  // The owner's rules setters (src/ownerset.ts): a bad value exits 2, a refusal (replica, git) 1.
  const ownerSet = (f: () => string | string[]): number => {
    try { const r = f(); console.log(Array.isArray(r) ? r.join("\n") : r); return 0; }
    catch (e) { console.error((e as Error).message); return e instanceof OwnerSetError && !/on the hub|couldn't commit/.test((e as Error).message) ? 2 : 1; }
  };
  if (cmd === "ask") return ownerSet(() => setAskToSee(root, args[0] === "on", { approver: arg(args, "--approver"), never: arg(args, "--never"), maxPerDay: arg(args, "--max-per-day"), clientId: arg(args, "--client-id") }));
  if (cmd === "night") return ownerSet(() => setNight(root, args[0] ?? ""));
  if (cmd === "filing" && args[0] === "all") return ownerSet(() => setFileAll(root, args[1] ?? ""));
  if (cmd === "me" && args[0] === "name") {
    // The owner's full name as an alias, then the open proposals that named the owner moved onto
    // one page. --suggested takes the name the proposals give most, so nothing is typed or printed.
    const guess = suggestOwnerName(root);
    let full: string | undefined;
    if (args.includes("--suggested")) full = guess;
    else if (process.stdin.isTTY) full = String(prompt(`Your first and last name${guess ? " (Enter: the one your mail gives you most)" : ""}:`) ?? "").trim() || guess;
    else { console.error("me name: run it in your own terminal, or with --suggested"); return 2; }
    if (!full) { console.error(`me name: no name to set (your open proposals don't settle your full name; type it in your own terminal)\n${ownerNameReport(root)}`); return 2; }
    const name = full;
    return ownerSet(() => { const set = setOwnerAliases(root, name, args.includes("--suggested") || name === guess ? ownerSpellings(root) : []); const r = sweepOwnerProposals(root); return [set, `${r.moved} open proposal(s) about you moved onto your page (${r.onPage} onto a page that exists)`]; });
  }
  if (cmd === "next-steps") {
    if (args[0] !== "newest") { console.error("next-steps newest"); return 2; }
    return ownerSet(() => setNextStepNewest(root));
  }
  if (cmd === "aftercheck") {
    if (args[0] !== "classify") { console.error("aftercheck classify on | off [--cap <dollars a month>]"); return 2; }
    return ownerSet(() => setAftercheckClassify(root, args[1] ?? "", arg(args, "--cap")));
  }
  if (cmd === "backfill") return ownerSet(() => setNightlyBackfill(root, args[0] ?? ""));
  if (cmd === "wiki") {
    if (args[0] === "links" && args[1] === "preview") {
      // The owner's own terminal: what upkeep would link, with the names (docs/wiki.md).
      const plan = namePlan(loadBrain(root), loadRules(root));
      for (const p of plan) {
        for (const l of p.link) console.log(`${p.from}: "${l.name}" -> [[${l.to}]]`);
        for (const l of p.blind) console.log(`${p.from}: "${l.name}" not linked: some assistants that see this note can't see ${l.to}`);
        if (p.ambiguous) console.log(`${p.from}: ${p.ambiguous} name${p.ambiguous === 1 ? "" : "s"} fit more than one note`);
      }
      console.log(`${plan.reduce((a, p) => a + p.link.length, 0)} links would be added in ${plan.filter((p) => p.link.length).length} notes`);
      return 0;
    }
    if (args[0] === "links") return ownerSet(() => setLinkNames(root, args[1] ?? ""));
    if (args[0] === "family") return ownerSet(() => setFamilyLinks(root, args[1] ?? ""));
    if (args[0] !== "sync") { console.error("wiki sync on | off, wiki links on | off, or wiki family on | off"); return 2; }
    return ownerSet(() => setWikiSync(root, args[1] ?? ""));
  }
  if (cmd === "gardener") {
    const sub = args[0];
    if (sub === "setup") return ownerSet(() => gardenerSetup(root, { profile: arg(args, "--profile"), lock: arg(args, "--lock"), agent: arg(args, "--agent"), mcpUrl: arg(args, "--mcp-url"), vault: arg(args, "--vault") }));
    if (sub === "open") {
      const agent = arg(args, "--agent") ?? gardeners(loadRules(root))[0];
      if (!agent) { console.error("no agent has role: gardener in policy.yaml"); return 2; }
      const min = Number(args[1] && /^\d+$/.test(args[1]) ? args[1] : 60);
      console.log(openWindow(root, agent, min));
      return 0;
    }
    if (sub === "describe-orgs") {
      console.log(`This adds one line to rules/gardener.yaml:\n  ${DESCRIBE_LINE}\nThe Gardener's web-only run may then look up org names below private (docs/gardener.md, "What an org is").`);
      const yes = args.includes("--yes") || (process.stdin.isTTY && /^y(es)?$/i.test(String(prompt("Add it? [y/N]") ?? "").trim()));
      if (!yes) { console.log("Nothing changed. To add it, answer y, or run the same command with --yes."); return 0; }
      return ownerSet(() => setDescribeOrgs(root));
    }
    if (sub === "cleanup") { const r = cleanup(root); console.log(r.message); return r.ok ? 0 : 1; }
    // G240: from a terminal, rotation needs the owner's one-time code from the gardener's page.
    if (sub === "rotate") { const r = rotate(root, { code: arg(args, "--code") }); (r.ok ? console.log : console.error)(r.message); return r.ok ? 0 : 1; }
    console.error("gardener open [minutes] | setup | cleanup | rotate [--code <code>]");
    return 2;
  }
  if (cmd === "fga") {
    const sub = args[0];
    const c = fga.loadFga(root);
    if (!c) { console.error("no rules/fga.yaml (api_url, store_id, token_issuer, client_id; secret in the key FGA_CLIENT_SECRET)"); return 1; }
    loadKeys();
    const client = new fga.FgaClient(c);
    const fail = (e: unknown) => { console.error(String((e as Error).message ?? e)); process.exit(1); };
    if (sub === "model") { client.writeModel().then((id) => { process.exit(ownerSet(() => `model ${id} written; ${setFgaModel(root, id)}`)); }, fail); return -1; }
    if (sub === "sync") {
      fga.syncFga(root, { apply: args.includes("--apply"), client }).then((d) => {
        for (const t of d.add) console.log(`+ ${t.user} ${t.relation} ${t.object}`);
        for (const t of d.remove) console.log(`- ${t.user} ${t.relation} ${t.object}`);
        console.log(!d.add.length && !d.remove.length ? "FGA matches policy.yaml" : args.includes("--apply") ? "written" : "dry run; add --apply to write");
        process.exit(0);
      }, fail);
      return -1;
    }
    if (sub === "check" && args[1]) { client.canRead(args[1]).then((s) => { console.log(s.size ? [...s].join(", ") : "no slices"); process.exit(0); }, fail); return -1; }
    console.error("fga model | sync [--apply] | check <agent>");
    return 2;
  }
  if (cmd === "oauth") {
    const sub = args[0];
    if (sub === "setup") {
      const issuer = arg(args, "--issuer"), resource = arg(args, "--resource"), owner_subject = arg(args, "--owner-subject");
      if (!issuer || !resource || !owner_subject) { console.error("oauth setup --issuer <url> --resource <https://host/mcp/oauth> --owner-subject <id> [--jwks <url>]"); return 2; }
      oauth.setupOAuth(root, { issuer, resource, owner_subject, ...(arg(args, "--jwks") ? { jwks_uri: arg(args, "--jwks") } : {}) });
      console.log(`OAuth door set: give the assistant ${resource}`);
      return 0;
    }
    if (sub === "status") {
      const c = oauth.loadOAuth(root);
      if (!c) { console.log("no OAuth door (rules/oauth.yaml); pasted tokens only"); return 0; }
      console.log(`issuer ${c.issuer}\nresource ${c.resource}\nowner subject ${c.owner_subject}`);
      for (const [id, b] of Object.entries(c.clients ?? {})) console.log(oauthPlain(`bound   ${id} -> ${b.agent}${b.name ? ` (${b.name})` : ""} since ${b.bound}`));
      for (const [id, m] of Object.entries(c.machines ?? {})) console.log(oauthPlain(`machine ${id} as ${m.agent}, since ${m.bound}`));
      for (const [id, r] of Object.entries(c.replaced ?? {})) console.log(oauthPlain(`replaced ${id} (${r.agent}, on ${r.on}): refused here; delete it at the sign-in service with pocketbrain oauth cleanup, or undo with oauth bind ${id} --agent ${r.agent} --keep-old`));
      for (const [s, w] of Object.entries(c.coworkers ?? {})) console.log(`coworker ${w.name} (${s}) as ${w.agent}: ${Object.keys(w.clients ?? {}).length} connection(s)`);
      for (const p of oauth.listCoworkerPending(root)) console.log(oauthPlain(`waiting coworker ${c.coworkers?.[p.subject]?.name ?? p.subject} ${p.client_id}: ${p.calls} call(s)`));
      // The access request each waiting sign-in filed, as on the dashboard card: its own words, cleaned.
      // Client ids come from whoever registered, so every line with one is cleaned too.
      const rules = loadRules(root);
      for (const p of oauth.listPending(root)) {
        console.log(oauthPlain(`waiting ${p.client_id}: ${p.calls} call(s), first ${p.first_seen}, last ${p.last_seen}`) + (p.user_agent ? `, ${oauthPlain(p.user_agent)}` : ""));
        const rq = p.request;
        if (!rq) continue;
        console.log(oauthPlain(`  asks to be ${rq.agent}, a new trial agent. In its own words: name "${rq.said ?? rq.name}", purpose "${rq.purpose}"; slices: ${rq.slices.join(", ") || "none"}`));
        const back = comingBack(rules, c, rq);
        if (back) console.log(`  careful: you ${comingBackText(back)}. Check it is the same assistant you meant to stop.`);
      }
      return 0;
    }
    if (sub === "bind" && args[1] && arg(args, "--agent")) {
      const agent = arg(args, "--agent")!;
      const old = oauth.bindClient(root, args[1], agent, arg(args, "--name"), { keepOld: args.includes("--keep-old") });
      console.log(oauthPlain(`${args[1]} now connects as ${agent}`));
      // A reconnect (backlog 289): the old connection is cut here; its app still counts at the AS.
      // Until cleanup deletes it there, binding it again with --keep-old undoes the replace.
      if (old.length) console.log(oauthPlain(`replaced ${old.join(", ")}: refused from now on. Delete ${old.length === 1 ? "it" : "them"} at the sign-in service: pocketbrain oauth cleanup. To keep ${old.length === 1 ? "it" : "them"} after all: ${old.map((id) => `pocketbrain oauth bind ${id} --agent ${agent} --keep-old`).join("; ")}`));
      return 0;
    }
    if (sub === "cleanup") {
      loadKeys();
      oauth.cleanupReplaced(root).then((cut) => {
        if (cut.skipped) console.log(`nothing deleted: ${cut.skipped}`);
        if (cut.deleted.length) console.log(oauthPlain(`deleted ${cut.deleted.length} old app(s) at the sign-in service: ${cut.deleted.join(", ")}`));
        for (const f of cut.failed) console.log(oauthPlain(`not deleted: ${f.client_id}: ${f.why} (it stays refused here)`));
        process.exit(cut.failed.length ? 1 : 0);
      }).catch((e) => { console.error(`oauth cleanup: ${(e as Error).message}`); process.exit(1); });
      return -1;
    }
    if (sub === "expect") {
      const agent = args[1];
      if (!agent || agent.startsWith("--")) { console.error("oauth expect <agent> [--name <label>] [--minutes 10]"); return 2; }
      try {
        const e = oauth.expectClient(root, agent, { name: arg(args, "--name"), minutes: arg(args, "--minutes") ? Number(arg(args, "--minutes")) : undefined });
        console.log(`your next new sign-in until ${e.until} is approved as ${agent}, once`);
      } catch (err) { console.error((err as Error).message); return 1; }
      return 0;
    }
    if (sub === "machine" && args[1] && arg(args, "--agent")) { oauth.bindMachine(root, args[1], arg(args, "--agent")!); console.log(`${args[1]} connects as ${arg(args, "--agent")} with its own credentials`); return 0; }
    if (sub === "coworker") {
      const [op, subject, client] = args.slice(1);
      if (op === "add" && subject && arg(args, "--name") && arg(args, "--agent")) { oauth.addCoworker(root, subject, arg(args, "--name")!, arg(args, "--agent")!); console.log(`${arg(args, "--name")} can connect as ${arg(args, "--agent")}; approve each connection with: pocketbrain oauth coworker bind ${subject} <client-id>`); return 0; }
      if (op === "bind" && subject && client) { oauth.bindCoworkerClient(root, subject, client); console.log("connection approved"); return 0; }
      if (op === "remove" && subject) { console.log(oauth.removeCoworker(root, subject) ? "coworker removed; their connections stop on the next request" : "no such coworker"); return 0; }
      console.error("oauth coworker add <subject> --name <name> --agent <agent> | bind <subject> <client-id> | remove <subject>");
      return 2;
    }
    if (sub === "revoke" && args[1]) {
      oauth.revokeClient(root, args[1]);
      console.log(`${args[1]} revoked`);
      loadKeys();
      oauth.cutAtAuthServer(root, [args[1]]).then((cut) => {
        if (cut.deleted.length) console.log("deleted at the authorization server too");
        for (const f of cut.failed) console.log(`not deleted at the authorization server: ${f.why} (it stays refused here)`);
        process.exit(0);
      });
      return -1;
    }
    if (sub === "management" && args[1]) {
      oauth.setManagement(root, args[1] === "--clear" ? undefined : args[1]);
      console.log(args[1] === "--clear" ? "management client cleared" : `management client ${args[1]} set; put its secret in the key file AUTH0_MGMT_CLIENT_SECRET`);
      return 0;
    }
    console.error("oauth setup | status | bind <client-id> --agent <agent> [--keep-old] | cleanup | revoke <client-id> | management <client-id>|--clear | coworker add|bind|remove | machine <client-id> --agent <gardener>");
    return 2;
  }
  if (cmd === "dispute") {
    const id = arg(args, "--confirm") ?? arg(args, "--reject");
    if (!id) { console.error("dispute --confirm <id> | --reject <id>"); return 2; }
    try { console.log(confirmHeldAnswer(root, id, args.includes("--confirm") ? "confirm" : "reject")); return 0; }
    catch (e) { if (e instanceof CoreError) { console.error(e.message); return 1; } throw e; }
  }

  if (cmd === "door" || (cmd === "pilot" && args[0] === "door")) {
    const target = args[1] && !args[1].startsWith("--") ? args[1] : "";
    const r = cmd === "pilot"
      ? (target && arg(args, "--zone") ? pilotDoor(target, { zone: arg(args, "--zone")!, out: arg(args, "--out") }) : undefined)
      : (args[0] === "install" && target && arg(args, "--hostname") ? installDoor(root, { credentials: target, hostname: arg(args, "--hostname")!, name: arg(args, "--name"), force: args.includes("--force") }) : undefined);
    if (!r) { console.error(cmd === "pilot" ? "pilot door <name> --zone <zone> [--out ~/.cloudflared]" : "door install <credentials.json> --hostname <host> [--name <machine>] [--force]"); return 2; }
    for (const l of r.lines) (r.ok ? console.log : console.error)(l);
    return r.ok ? 0 : 1;
  }

  if (cmd === "edge") {
    const sub = args[0];
    if (sub === "enroll" && args[1]) {
      const role = arg(args, "--role");
      if (role && role !== "reader") { console.error("edge enroll <agent> [--role reader] [--code <code>]: the resolver's routes need the hub"); return 2; }
      // G184: the token passes the terminal's gate first; enroll only wraps it for the sealed cell.
      let tok: string;
      try { tok = mintFromShell(root, args[1], { via: `edge enroll ${args[1]}${role ? " --role reader" : ""}`, code: arg(args, "--code"), role: role as "reader" | undefined }); } catch (e) { console.error((e as Error).message); return 1; }
      // If the edge can't take it (its home state can't be written), the token nobody was shown is revoked (G314).
      try { console.log(edge.enroll(root, args[1], role as "reader" | undefined, tok)); }
      catch (e) { const h = sha256(tok); retainTokens(root, args[1], (x) => x !== h); console.error(`edge enroll ${args[1]}: ${(e as Error).message}; the new token was revoked`); return 1; }
      console.error(`${role ? "reader " : ""}token for ${args[1]}: shown once; it reads from the hub and from the sealed edge`); return 0;
    }
    const dir = arg(args, sub === "publish" ? "--out" : "--from");
    if (sub === "publish" && dir) {
      const r = edge.publish(root, dir);
      console.log(`sealed: ${r.published.join(", ") || "none"}`);
      for (const [a, why] of Object.entries(r.left_out)) console.log(`left out: ${a} (${why})`);
      return 0;
    }
    if (sub === "serve" && dir) { const s = edge.serveEdge(dir, Number(arg(args, "--port") ?? 8789)); console.log(`edge serving sealed cells from ${dir} on http://127.0.0.1:${s.port}`); return -1; }
    if (sub === "replay" && dir) {
      edge.replay(root, dir).then((rs) => { for (const r of rs) console.log(`${r.id} ${r.agent ?? "?"} ${r.tool ?? "?"}: ${r.outcome}${r.message ? ` (${r.message})` : ""}`); if (!rs.length) console.log("nothing queued"); process.exit(0); }, (e) => { console.error(String(e.message ?? e)); process.exit(1); });
      return -1;
    }
    console.error("edge enroll <agent> [--role reader] | edge publish --out <dir> | edge serve --from <dir> [--port 8789] | edge replay --from <dir>");
    return 2;
  }

  if (cmd === "hub") {
    const sub = args[0];
    if (sub === "url") return ownerSet(() => setPublicUrl(root, args[1] ?? ""));
    if (sub === "init") {
      const name = arg(args, "--name");
      if (!name) { console.error("hub init --name <machine> [--key <ssh private key>] [--git <url>] [--public-url <url>]"); return 2; }
      console.log(hub.init(root, { name, key: arg(args, "--key"), git: arg(args, "--git"), publicUrl: arg(args, "--public-url"), signer: arg(args, "--signer") }).join("\n"));
      return 0;
    }
    if (sub === "add-replica") {
      const name = args[1];
      if (!name || name.startsWith("--")) { console.error('hub add-replica <name> --pub "<ssh public key>" [--git <url>] [--no-hub]'); return 2; }
      console.log(hub.addReplica(root, name, { ...(arg(args, "--pub") ? { signing_key: arg(args, "--pub") } : {}), ...(arg(args, "--git") ? { git: arg(args, "--git") } : {}), ...(args.includes("--no-hub") ? { can_be_hub: false } : {}) }));
      return 0;
    }
    if (sub === "status") {
      const role = hub.hubRole(root);
      if (role.mode === "single") { console.log("one machine (no rules/hub.yaml)"); return 0; }
      console.log(`${role.name ?? "(unnamed clone)"}: ${role.mode}; hub ${role.cfg.hub}, epoch ${role.cfg.epoch}${role.cfg.previous ? `, previously ${role.cfg.previous}` : ""}`);
      for (const [n, r] of Object.entries(role.cfg.replicas)) console.log(`  ${n === role.cfg.hub ? "*" : " "} ${n}${r.git ? `  ${r.git}` : ""}${r.signing_key ? "  signed" : "  UNSIGNED"}${r.can_be_hub === false ? "  never hub" : ""}`);
      return 0;
    }
    if (sub === "sync") {
      const r = hub.sync(root, { from: arg(args, "--from") });
      if (r.role === "hub") {
        const got = Object.entries(r.ingest?.received ?? {}).filter(([, n]) => n).map(([k, n]) => `${n} from ${k}`);
        console.log(`${r.hub} is hub (epoch ${r.epoch}): received ${got.join(", ") || "nothing"}; applied ${r.replay?.applied.length ?? 0} op(s)`);
        for (const a of r.replay?.applied ?? []) console.log(`  ${a.outcome.padEnd(9)} ${a.op}  ${a.message}`);
        for (const [k, why] of Object.entries(r.ingest?.refused ?? {})) console.log(`  REFUSED from ${k}: ${why}`);
        const waiting = (r.replay?.applied ?? []).filter((a) => a.outcome === "inbox" && /^stored /.test(a.message)).length;
        if (waiting) console.log(`  ${waiting} capture(s) stored; facts are extracted by serve's next capture tick, or now with: pocketbrain capture pending`);
      } else console.log(`${r.fetched ? `synced with ${r.hub} (epoch ${r.epoch}) at ${r.fetched}` : "not synced"}; sent ${r.pushed} op(s)`);
      for (const p of r.problems) console.error(`  ! ${p}`);
      return r.problems.length ? 1 : 0;
    }
    if (sub === "promote") {
      const name = args[1];
      if (!name || name.startsWith("--")) { console.error("hub promote <this machine> [--from <url>] [--force]"); return 2; }
      const r = hub.promote(root, name, { from: arg(args, "--from"), force: args.includes("--force") });
      recordRepair(root, "hub promote");
      console.log(`${r.to} is the hub now (epoch ${r.epoch}, was ${r.from}); ${r.verified} commit(s) verified; replayed ${r.replay.applied.length} op(s)`);
      for (const a of r.replay.applied) console.log(`  ${a.outcome.padEnd(9)} ${a.op}  ${a.message}`);
      for (const p of r.problems) console.error(`  ! ${p}`);
      console.log(`\nYour part:\n${r.next.map((x) => `  - ${x}`).join("\n")}`);
      return 0;
    }
    if (sub === "replay") {
      const r = hub.replay(root);
      recordRepair(root, "hub replay");
      console.log(`applied ${r.applied.length} op(s)`);
      for (const a of r.applied) console.log(`  ${a.outcome.padEnd(9)} ${a.op}  ${a.message}`);
      for (const s of r.skipped) console.error(`  ! ${s}`);
      return 0;
    }
    if (sub === "verify") {
      const v = args.includes("--all") ? hub.verifyHistory(root, undefined) : hub.verifyNew(root);
      const l = hub.verifyWriteLog(root);
      console.log(`${v.checked} commit(s) checked; write log ${l.entries} entries`);
      for (const p of [...v.problems, ...l.problems.map((x) => `log/writes.jsonl ${x}`)]) console.error(`  ! ${p}`);
      return v.problems.length || l.problems.length ? 1 : 0;
    }
    if (sub === "tunnel-config") { console.log(hub.tunnelConfig(root)); return 0; }
    console.error("hub init | add-replica | status | sync | promote | replay | verify | tunnel-config");
    return 2;
  }
  if (cmd === "support") {
    if (args[0] !== "bundle") { console.error("support bundle [--out <file>]"); return 2; }
    const out = resolve(arg(args, "--out") ?? `pocketbrain-support-${new Date().toISOString().slice(0, 10)}.txt`);
    supportBundle(root).then((text) => {
      writeFileSync(out, text, { mode: 0o600 });
      chmodSync(out, 0o600);
      console.log(`wrote ${out} (${text.split("\n").length - 1} lines, readable only by you). It has no note content; read it before you send it.`);
      process.exit(0);
    }, (e) => { console.error((e as Error).message); process.exit(1); });
    return -1;
  }

  if (cmd === "doctor") {
    const offline = args.includes("--offline");
    doctor(root, { offline }).then(async (f) => {
      if (!args.includes("--fix")) {
        console.log(args.includes("--json") ? JSON.stringify(f, null, 2) : renderDoctor(f));
        process.exit(f.some((x) => x.level === "FAIL") ? 1 : 0);
      }
      // --fix previews the repairs; --fix --yes runs them and checks again (src/doctor-fix.ts).
      const plan = fixPlan(root, f);
      if (!args.includes("--yes") || !plan.length) { console.log(`${renderDoctor(f)}\n\n${renderPlan(plan)}`); process.exit(0); }
      const done = applyFixes(root, f);
      const after = await doctor(root, { offline });
      console.log(`${renderDone(done)}\n\nafter the repairs:\n${renderDoctor(after)}`);
      process.exit(done.some((d) => !d.ok) || after.some((x) => x.level === "FAIL") ? 1 : 0);
    });
    return -1;
  }

  if (cmd === "export") {
    const out = arg(args, "--out"), agent = arg(args, "--agent");
    if (!out) { console.error("export --out <file> [--agent <agent>]"); return 2; }
    if (existsSync(out)) { console.error(`export: ${out} exists; pick a new file`); return 1; }
    try {
      const b = agent ? exportSlice(root, agent) : exportBrain(root);
      writeFileSync(out, JSON.stringify(b, null, 2) + "\n", { mode: 0o600 });
      console.log(`${agent ? `${agent}'s slice` : "the brain"}: ${b.notes.length} notes in ${out}. It is the owner's memory in clear: keep it like a backup.`);
      return 0;
    } catch (e) { console.error(`export: ${(e as Error).message}`); return 1; }
  }

  if (cmd === "handover") {
    const to = arg(args, "--to"), out = arg(args, "--out");
    if (!to || !out) { console.error('handover --to "Name" --out <dir> [--age-key age1...]'); return 2; }
    const r = handover(root, { to, out, ageKey: arg(args, "--age-key"), includeAgents: args.includes("--include-agents") });
    if (r.problems.length) { console.error(`handover FAILED verification, nothing kept:\n  ${r.problems.join("\n  ")}`); return 1; }
    console.log(`handed over ${r.kept} notes from ${r.sourceCommit}; stripped ${r.stripped.length}; ${r.openDisputes.length} open disputes`);
    for (const [k, v] of Object.entries(r.rewrites)) console.log(`  ${v} ${k}`);
    console.log(r.package ? `package: ${r.package} (encrypted). Send it yourself.` : `folder: ${r.out} (NOT encrypted; pass --age-key to encrypt)`);
    return 0;
  }

  if (cmd === "upkeep") {
    const live = arg(args, "--live");
    const r = upkeep(root, { live: live ? [fileLiveSource(live)] : [] });
    if (r.queued) { console.log(`${r.run}: queued as ${r.file} (this clone is a replica); the hub runs it after the next sync`); return 0; }
    const n = (k: string) => r.findings.filter((f) => f.kind === k).length;
    console.log(`${r.run}: ${n("escalate")} escalated, ${n("auto-fix")} fixed, ${n("review")} to review -> ${r.file}`);
    return 0;
  }
  if (cmd === "sleep") {
    const live = arg(args, "--live");
    if (!args.includes("--no-upkeep")) {
      const u = upkeep(root, { live: live ? [fileLiveSource(live)] : [] });
      console.log(`${u.run}: ${u.findings.length} findings -> ${u.file}`);
    }
    // Metered; past the spend cap each model step is held (the morning note says so).
    const judge = args.includes("--no-judge") ? undefined : modelFor(root, "upkeep.duplicates");
    sleep(root, { model: modelFor(root, SLEEP_STEP), judge }).then((r) => {
      console.log(r.file ? `${r.run} -> ${r.file}` : r.run);
      for (const l of r.morning) console.log(l);
      process.exit(0);
    }, (e) => { console.error(String(e.message ?? e)); process.exit(1); });
    return -1;
  }
  if (cmd === "forget") {
    // Someone asks to be taken out (docs/forget.md): an owner commit, undone within 14 days.
    const id = args[0] === "--undo" ? args[1] : args[0];
    if (!id || id.startsWith("--")) { console.error("forget <people/id> [--yes] | forget --undo <people/id>"); return 2; }
    try {
      if (args[0] === "--undo") { console.log(undoForget(root, id)); return 0; }
      if (!args.includes("--yes")) {
        const p = planForget(root, id);
        console.log(`Would forget ${p.title} (${id}): the note, ${p.links.length} link(s) to them${p.links.length ? ` in ${p.links.join(", ")}` : ""}, ${p.inbox.length} inbox item(s), ${p.disputes.length} settled dispute(s)${p.standing ? ", their standing" : ""}.`);
        if (p.named.length) console.log(`Still named in plain text, by name or address, in ${p.named.join(", ")}: a forget rewrites links, not prose, so edit those notes too.`);
        console.log(`Nothing changed. To go ahead: pocketbrain forget ${id} --yes`);
        return 1;
      }
      console.log(forgetPerson(root, id).message);
      return 0;
    } catch (e) { console.error((e as Error).message); return 1; }
  }
  if (cmd === "same-person") {
    const [sub, id] = args.filter((x, i) => !x.startsWith("--") && args[i - 1] !== "--brain");
    const run = (f: () => string) => { try { console.log(f()); return 0; } catch (e) { console.error((e as Error).message); return 1; } };
    if (sub === "merge" && id) return run(() => mergeSamePerson(root, id, { swap: args.includes("--swap") }));
    if (sub === "not" && id) return run(() => notSamePerson(root, id));
    if (sub === "undo" && id) return run(() => undoPersonMerge(root, id));
    if (sub) { console.error("same-person [merge <id> [--swap] | not <id> | undo <id>]"); return 2; }
    const ps = samePersonProposals(root);
    if (args.includes("--json")) { console.log(JSON.stringify({ proposals: ps, merges: personMerges(root) }, null, 2)); return 0; }
    if (!ps.length) console.log("no same-person proposals");
    // The card already says why a blocked pair can't merge; only the ways that can are offered.
    for (const p of ps) console.log(`${p.id}  ${p.card}${p.blocked && p.swap_blocked ? "" : !p.blocked
      ? `\n    pocketbrain same-person merge ${p.id}   (keeps ${p.keep}${p.swap_blocked ? "" : `; --swap keeps ${p.drop}`})`
      : `\n    pocketbrain same-person merge ${p.id} --swap   (keeps ${p.drop})`}
    pocketbrain same-person not ${p.id}`);
    for (const m of personMerges(root)) console.log(`merged: ${m.drop} into ${m.keep}  (undo: pocketbrain same-person undo ${m.id})`);
    return 0;
  }
  // Routines that may do the same job (src/overlap.ts, docs/wiki.md, G641): owner only, ids only.
  if (cmd === "overlaps") {
    const o = findOverlaps(loadBrain(root));
    for (const g of o) console.log(`${g.ids.join(", ")}: ${g.ids.length > 2 ? "all" : "both"} run on their own, read ${g.sources.join(" and ")} and send ${g.job}`);
    console.log(`${o.length} group${o.length === 1 ? "" : "s"} of routines may do the same job.`);
    return 0;
  }
  if (cmd === "fold" && (args[0] === "on" || args[0] === "off")) return ownerSet(() => setFoldTwins(root, args[0]!));
  if (cmd === "fold") {
    // One thing, one page (src/fold.ts, docs/fold-twins.md): a dry run by default; --apply folds;
    // undo <commit> puts one back.
    if (args[0] === "undo") {
      const c = args[1];
      if (!c) { console.error("fold undo <commit>"); return 2; }
      try { console.log(undoFold(root, c)); return 0; } catch (e) { console.error((e as Error).message); return 1; }
    }
    const apply = args.includes("--apply");
    const r = foldTwins(root, { apply });
    // Counts and ids only: an id is a slug, never a value.
    for (const f of r.folds) console.log(`${apply ? "folded" : "would fold"} ${f.drop} into ${f.keep}${f.disputes ? ` (${f.disputes} conflict${f.disputes === 1 ? "" : "s"} to settle)` : ""}${f.commit ? ` [${f.commit.slice(0, 8)}]` : ""}`);
    for (const f of r.refused) console.log(`held: ${f.drop} into ${f.keep}: ${f.why}`);
    console.log(`${r.folds.length} ${apply ? "folded" : "would fold"}, ${r.refused.length} held, ${r.disputes} new conflict${r.disputes === 1 ? "" : "s"} to settle.${apply || !r.folds.length ? "" : " Run with --apply to fold them."}`);
    return 0;
  }
  if (cmd === "merge") {
    const [keep, drop] = args.filter((x, i) => !x.startsWith("--") && args[i - 1] !== "--brain");
    if (!keep || !drop) { console.error("merge <keep-id> <drop-id>"); return 2; }
    const r = mergeNotes(root, keep, drop);
    console.log(r.message);
    return r.ok ? 0 : 1;
  }
  if (cmd === "audit" && args[0] === "trust") {
    // Can the brain be trusted? Counts only, no model (src/trust.ts, docs/trust.md).
    const n = arg(args, "--check");
    if (n !== undefined && !/^\d+$/.test(n)) { console.error("audit trust --check <number of source items to read>"); return 2; }
    const report = () => {
      const t = trustReport(root);
      const weekAgo = recordTrust(root, t);
      console.log(args.includes("--json") ? JSON.stringify(t, null, 2) : trustText(t, weekAgo));
    };
    if (!n) { report(); return 0; }
    sweep(root, Number(n)).then((s) => {
      console.log(`Read ${s.read} source item(s): ${s.confirmed} fact(s) confirmed, ${s.due} now need a look, ${s.unreachable} couldn't be read.`);
      report();
      process.exit(0);
    }, (e) => { console.error(String((e as Error).message ?? e)); process.exit(1); });
    return -1;
  }
  if (cmd === "audit") {
    if (args[0] !== "carve") { console.error("audit: say audit carve or audit trust"); return 2; }
    const r = auditCarve(root, { save: !args.includes("--dry-run"), alert: !args.includes("--dry-run") });
    console.log(args.includes("--json") ? JSON.stringify(r, null, 2) : r.text);
    return r.alerts ? 1 : 0;
  }
  if (cmd === "probe") {
    if (args[0] === "init") { console.log(probeInit(root, { rotate: args.includes("--rotate") }).text); return 0; }
    if (args[0] === "check" && args[1]) {
      const text = args[1] === "-" ? readFileSync(0, "utf8") : readFileSync(args[1], "utf8");
      const hits = findCanaries(root, text, arg(args, "--as"));
      for (const h of hits) console.log(`canary ${h.canary} (${h.id})`);
      if (!hits.length) console.log("no canary found");
      return hits.length ? 1 : 0;
    }
    console.error("probe: say probe init [--rotate] or probe check <file|-> [--as <agent>]");
    return 2;
  }

  if (cmd === "reads") {
    const pos = args.filter((x, i) => !x.startsWith("--") && !["--brain", "--days"].includes(args[i - 1]));
    if (!pos[0]) { console.error("reads <agent> [--days N] [--json]"); return 2; }
    if (!loadRules(root).policy.agents[pos[0]]) { console.error(`no agent ${pos[0]} in policy.yaml`); return 2; }
    const days = Math.max(1, Math.min(90, Number(arg(args, "--days") ?? 7) || 7));
    console.log(args.includes("--json") ? JSON.stringify(readsByDay(root, pos[0], { days })) : readsReport(root, pos[0], { days }));
    return 0;
  }
  if (cmd === "explain") {
    const pos = args.filter((x, i) => !x.startsWith("--") && args[i - 1] !== "--brain" && args[i - 1] !== "--limit");
    if (!pos[0]) { console.error("explain <agent> [topic]"); return 2; }
    const r = explainAgent(root, pos[0], pos.slice(1).join(" ") || undefined, { limit: Number(arg(args, "--limit") ?? 8) });
    console.log(r.lines.join("\n"));
    return r.ok ? 0 : 1;
  }
  if (cmd === "refs") {
    const f = arg(args, "--load");
    if (!f) { console.error("refs --load <file.json>"); return 2; }
    const data = JSON.parse(readFileSync(f, "utf8")) as Record<string, boolean>;
    recordCheckedRefs(root, data);
    console.log(`recorded ${Object.keys(data).length} checked refs`);
    return 0;
  }
  if (cmd === "owner" || cmd === "louis") {
    const ids = args_(args, "--msg").filter(Boolean);
    if (!ids.length) { console.error(`${cmd} --msg <id>`); return 2; }
    console.log(`registered ${registerLouisMessages(root, ids, "added by Louis")} new id(s)`);
    return 0;
  }
  if (cmd === "judge") {
    { const why = pausedReason(root, "upkeep.duplicates"); if (why) { console.error(`judge ${why}`); return 1; } }
    const model = modelFor(root, "upkeep.duplicates");
    judgeDuplicates(root, model).then((r) => {
      console.log(`${model.config.provider}/${model.config.model}: ${r.sent} pairs sent (${r.skipped} notes above ${model.config.max_sensitivity} not sent), ${r.items.length} to review${r.file ? ` -> ${r.file}` : ""}`);
      for (const i of r.items) console.log(i);
      process.exit(0);
    }, (e) => { console.error(String(e.message ?? e)); process.exit(1); });
    return -1;
  }
  if (cmd === "standing") {
    // Who matters to you (docs/standing.md): rules/standing.yaml, which only you change.
    const sub = args[0] ?? "list";
    try {
      if (sub === "list") {
        const s = loadStanding(root);
        const ids = Object.keys(s.people);
        if (!ids.length) console.log("nobody has standing yet: pocketbrain standing set <person> <inner|close|known>");
        if (!s.me?.length) console.log("no me: addresses in rules/standing.yaml, so suggestions can't tell your own mail apart from Gmail's SENT label alone");
        for (const id of droppedStanding(root)) console.log(`?      ${id}  (tier not understood: inner, close or known; not applied)`);
        const gone = new Set(orphanStanding(root));
        for (const id of ids.sort()) { const e = s.people[id]; console.log(`${e.tier.padEnd(6)} ${id}${e.authority ? `  authority: ${e.authority}` : ""}${e.addresses?.length ? `  pinned: ${e.addresses.join(", ")}` : ""}${gone.has(id) ? "  (note gone or replaced: not applied; set it again or set none)" : ""}`); }
        return 0;
      }
      if (sub === "set" && args[1] && args[2]) {
        for (const f of ["--authority", "--pin"]) if (args.includes(f) && !arg(args, f)) { console.error(`${f} needs a value`); return 2; }
        const auth = arg(args, "--authority") as "owner" | "them" | "none" | undefined;
        const pin = arg(args, "--pin")?.split(",").map((x) => x.trim()).filter(Boolean);
        const e = setStanding(root, args[1], args[2] as never, { authority: auth, pin });
        console.log(e ? `${args[1]}: ${e.tier}${e.authority ? `, authority ${e.authority}` : ""}${e.addresses?.length ? `; pinned ${e.addresses.join(", ")}` : (e.tier !== "known" ? "; no confirmed address to pin yet, so who_is counts them as known at most" : "")}` : `${args[1]}: no standing`);
        const more = e && e.tier !== "known" ? unpinnedAddresses(root, args[1]) : [];
        if (more.length) console.log(`  not pinned (source-verified, not confirmed by you): ${more.join(", ")}. If they are really theirs: --pin ${more.join(",")}`);
        return 0;
      }
      if (sub === "suggest") {
        const xs = suggestStanding(root);
        if (!xs.length) console.log("no suggestions: nobody new you write to often");
        for (const x of xs) console.log(`${x.tier.padEnd(6)} ${x.person} (${x.title}): ${x.why}. pocketbrain standing approve ${x.person}`);
        return 0;
      }
      if (sub === "approve" && args[1]) {
        const e = approveSuggestion(root, args[1]);
        console.log(`${args[1]}: ${e?.tier}`);
        return 0;
      }
    } catch (e) { console.error((e as Error).message); return 1; }
    console.error("standing list | standing set <person> <inner|close|known|none> [--authority owner|them|none] [--pin a,b] | standing suggest | standing approve <person>");
    return 2;
  }
  if (cmd === "sources") {
    // sources list | sources pull [<name>]   (rules/sources.yaml; `start` pulls every poll_minutes)
    const file = loadSources(root);
    loadKeys(); // live sources: Google client and tokens from the keys folder
    if (args[0] === "list" || !args[0]) {
      for (const [n, s] of Object.entries(file.sources ?? {})) console.log(`${n}: ${s.kind}${s.where?.length ? ` ${s.where.join(", ")}` : ""}${s.fixture ? ` (fixture ${s.fixture})` : ""}`);
      if (!Object.keys(file.sources ?? {}).length) console.log("no sources (rules/sources.yaml)");
      console.log(`consent: ${file.consent ?? "not given (live sources stay off)"}`);
      return 0;
    }
    if (args[0] === "connect") {
      const cfg = args[1] ? file.sources?.[args[1]] : undefined;
      if (!cfg || (cfg.kind !== "gmail" && cfg.kind !== "gcal" && cfg.kind !== "gdoc" && !(cfg.kind === "contacts" && !cfg.path))) { console.error("sources connect <name>: a gmail, gcal, gdoc or Google contacts source in rules/sources.yaml"); return 2; }
      connectGoogle(cfg, { open: (u) => { try { Bun.spawn(["open", u]); } catch { /* not a Mac: the URL is printed */ } } }).then(({ url, done }) => {
        console.log(`Sign in with the source's Google account (read-only access). If no browser opened:\n${url}`);
        return done;
      }).then((key) => { console.log(`saved ${key} in the keys folder (value not shown). Restart the hub to use it.`); process.exit(0); }, (e) => { console.error(String(e.message ?? e)); process.exit(1); });
      return -1;
    }
    if (args[0] === "backfill") {
      // A fact with no live source gets the mail that still states it as its source (src/backfill.ts).
      const name = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
      if (!name) { console.error("sources backfill <gmail source> [--max N] [--dry-run]"); return 2; }
      const mi = args.indexOf("--max");
      sourceBackfill(root, name, { dryRun: args.includes("--dry-run"), ...(mi >= 0 ? { max: Number(args[mi + 1]) } : {}) }).then((r) => {
        if (r.refused) { console.log(`${name}: ${r.refused}`); process.exit(1); }
        console.log(`${name}${args.includes("--dry-run") ? " (dry run, nothing written)" : ""}: ${r.tried} fact(s) searched, ${r.attached.length} now sourced`);
        for (const k of r.attached) console.log(`  ${k}`);
        process.exit(0);
      }, (e) => { console.error(String(e.message ?? e)); process.exit(1); });
      return -1;
    }
    if (args[0] === "pull" && args.includes("--dry-run")) {
      const names = args[1] && !args[1].startsWith("--") ? [args[1]] : Object.keys(file.sources ?? {});
      (async () => { const rs: PullResult[] = []; for (const n of names) rs.push(await pullSource(root, n, { dryRun: true })); return rs; })().then((rs) => {
        for (const r of rs) {
          if (r.refused) { console.log(`${r.source}: ${r.refused}`); continue; }
          const pv = r.preview ?? [];
          const by = new Map<string, { items: number; facts: number; known: number; held: number }>();
          for (const p of pv) {
            const k = `${p.account ?? "-"} / ${p.area ?? "-"}${p.floor ? ` (${p.floor})` : ""}`;
            const b = by.get(k) ?? { items: 0, facts: 0, known: 0, held: 0 };
            b.items++; b.facts += p.facts.filter((f) => !["ungrounded", "ambiguous"].includes(f.status)).length; b.known += p.facts.filter((f) => f.status === "known").length; if (p.skipped) b.held++;
            by.set(k, b);
          }
          console.log(`${r.source} (dry run, nothing written): ${r.fetched} fetched, ${pv.length} read, ${r.skipped} skipped${r.more ? ", more waiting" : ""}`);
          for (const [k, b] of by) console.log(`  ${k}: ${b.items} items, ${b.facts} facts (${b.known} already known), ${b.held} held`);
          if (args.includes("--show")) for (const p of pv) for (const f of p.facts) console.log(`  ${p.ref}  ${f.status}: ${f.entity} ${f.attribute} = ${String(f.value).slice(0, 80)}`);
        }
        process.exit(rs.some((r) => r.refused) ? 1 : 0);
      }, (e) => { console.error(String(e.message ?? e)); process.exit(1); });
      return -1;
    }
    if (args[0] === "pull") {
      const p = args[1] ? pullSource(root, args[1]).then((r) => [r]) : pullAll(root);
      p.then((rs) => { for (const r of rs) console.log(`${r.source}: ${r.refused ?? `${r.fetched} fetched, ${r.stored.length} read, ${r.confirmed ?? 0} confirmed, ${r.proposals ?? 0} proposed, ${r.due.length} note(s) due${r.capped ? ", daily cap reached (the rest waits for tomorrow)" : ""}`}`); process.exit(rs.some((r) => r.refused) ? 1 : 0); }, (e) => { console.error(String(e.message ?? e)); process.exit(1); });
      return -1;
    }
    console.error("sources list | sources pull [<name>] [--dry-run [--show]] | sources connect <name> | sources backfill <name> [--max N] [--dry-run]");
    return 2;
  }
  if (cmd === "capture" && ["drop", "mail", "watch", "pending", "held", "release", "discard"].includes(args[0])) {
    const sub = args[0];
    const show = (label: string, items: IntakeItem[]) => { for (const i of items) console.log(`  ${label} ${i.outcome.padEnd(9)} ${i.name}  ${i.detail}`); };
    const done = (p: Promise<unknown>) => { p.then(() => process.exit(0), (e) => { console.error(String((e as Error).message ?? e)); process.exit(1); }); return -1; };
    if (sub === "held") {
      const h = heldCaptures(root);
      for (const x of h) console.log(`${x.file}: ${x.held.join("; ")}${x.from ? ` (from ${x.from})` : ""}`);
      if (!h.length) console.log("no held captures");
      return 0;
    }
    if (sub === "release" || sub === "discard") {
      if (!args[1]) { console.error(`capture ${sub} <file>`); return 2; }
      const r = decideCapture(root, args[1], sub);
      console.log(`${r.outcome}: ${r.message}`);
      return r.outcome === "refused" ? 1 : 0;
    }
    if (sub === "pending") return done(extractPending(root).then((rs) => {
      for (const x of rs) console.log(`  ${x.file}: ${x.error ? `still pending (${x.error})` : `${x.items!.filter((i) => i.proposal).length} proposal(s)`}`);
      if (!rs.length) console.log("nothing waiting");
    }));
    if (sub === "drop") {
      const dir = arg(args, "--dir") ?? captureConfig(rules).drop_folder;
      if (!dir) { console.error("capture drop --dir <folder> (or set capture.drop_folder in policy.yaml)"); return 2; }
      return done(dropOnce(root, dir, { settleSeconds: Number(arg(args, "--settle") ?? 10) }).then((items) => { show("drop", items); if (!items.length) console.log("drop folder empty"); }));
    }
    if (sub === "mail") {
      const cfg = captureConfig(rules);
      const src = mailSourceFor(cfg.mail);
      if (!src || "error" in src) { console.error(src ? src.error : "no capture.mail in policy.yaml"); return 2; }
      return done(mailOnce(root, src, cfg.mail!).then((items) => { show("mail", items); if (!items.length) console.log("no new mail"); }));
    }
    // watch: the routine for a machine that doesn't serve (a replica, or a hub run without serve).
    const every = captureConfig(rules).poll_minutes * 60000;
    const once = () => intakeTick(root, { drop: arg(args, "--dir") }).then((r) => {
      show("mail", r.mail); show("drop", r.drop);
      for (const x of r.extracted) console.log(`  extract ${x.file}: ${x.error ? `still pending (${x.error})` : `${x.proposals} proposal(s)`}`);
      for (const p of r.problems) console.error(`  ! ${p}`);
    }, (e) => console.error(`capture watch: ${(e as Error).message}`));
    void once();
    setInterval(() => void once(), every);
    return -1;
  }
  if (cmd === "capture") {
    const text = arg(args, "--text"), voice = arg(args, "--voice"), email = arg(args, "--email");
    // --voice takes a transcript, or an audio file when capture.transcribe is set (src/transcribe.ts).
    const audio = voice && AUDIO.has(extname(voice).toLowerCase()) ? transcriberFor(root) : undefined;
    if (typeof audio === "string") { console.error(audio); return 1; }
    const input: CaptureInput | undefined = text ? { kind: "text", text } : voice ? { kind: "voice", text: audio ? "" : readFileSync(voice, "utf8") } : email ? parseEmail(readFileSync(email, "utf8")) : undefined;
    if (!input) { console.error('capture --text "…" | --voice <transcript.txt or audio> | --email <file>'); return 2; }
    { const why = pausedReason(root, CAPTURE_STEP); if (why) { console.error(`capture ${why}`); return 1; } }
    const model = modelFor(root, CAPTURE_STEP, arg(args, "--as") ?? "capture");
    (audio ? audio(voice!).then((t) => ({ ...input, text: t })) : Promise.resolve(input)).then((i) => capture(root, i, model, { agent: arg(args, "--as") })).then((r) => {
      if (r.refused) { console.error(`refused: ${r.refused}`); process.exit(1); }
      if (r.duplicate) { console.log(`already captured: ${r.file}`); process.exit(0); }
      if (r.queued) { console.log(`queued as ${r.queued}; the hub stores it and extracts facts after the next sync`); process.exit(0); }
      if (r.held) { console.log(`${r.file} held for you: ${r.held.join("; ")}. Nothing was sent to a model. pocketbrain capture release|discard ${r.file}`); process.exit(0); }
      console.log(`${r.file}${r.removed.length ? ` (removed: ${r.removed.join(", ")})` : ""}`);
      for (const i of r.items) console.log(`  ${i.status.padEnd(11)} ${i.candidate.entity} · ${i.candidate.attribute} = ${String(i.candidate.value).slice(0, 60)}${i.proposal ? `  -> ${i.proposal}` : ""}  (${i.why})`);
      process.exit(0);
    }, (e) => { console.error(String(e.message ?? e)); process.exit(1); });
    return -1;
  }
  if (cmd === "usage") {
    const s = summary(root, { month: arg(args, "--month") });
    if (args.includes("--json")) { console.log(JSON.stringify({ ...s, cap: capState(root) }, null, 2)); return 0; }
    console.log(renderUsage(s, capState(root)));
    return 0;
  }
  if (cmd === "models") {
    const t = routing(root);
    if (args.includes("--json")) { console.log(JSON.stringify(t, null, 2)); return 0; }
    const w = Math.max(...t.map((r) => r.step.length));
    for (const r of t) console.log(`${r.step.padEnd(w)}  ${(r.role ?? "-").padEnd(8)}  ${r.provider}/${r.model}  (${r.from})`);
    return 0;
  }
  if (cmd === "undo") {
    const run = arg(args, "--run");
    if (!run) { console.error("undo --run <run-id>"); return 2; }
    console.log(undoRun(root, run));
    return 0;
  }

  if (cmd === "handoff") {
    const [sub, id] = args.filter((x, i) => !x.startsWith("--") && args[i - 1] !== "--brain");
    if (sub === "list") { console.log(listHandoffs(root)); return 0; }
    if ((sub === "release" || sub === "drop") && id) { console.log(decideHandoff(root, id, sub)); return 0; }
    console.error(usageOf("handoff"));
    return 2;
  }

  if (cmd === "relay") {
    const cfg = loadRelayConfig(root);
    if (args.includes("--block-plan")) { console.log(blockListPlan(cfg)); return 0; }
    if (args.includes("--check")) {
      const from = arg(args, "--from"), to = arg(args, "--to");
      if (!from || !to) { console.error("relay --check --from <agent> --to <agent> [--via <label>] < message.txt"); return 2; }
      const v = relayCheck(root, { from, to, text: readFileSync(0, "utf8"), via: arg(args, "--via") ?? undefined, subject: arg(args, "--subject") ?? undefined });
      // The reasons name the hidden value and its note, and the alert flag says a guess hit, so both
      // stay with the owner; the bridge (and so the sending agent) only learns delivered or held.
      console.log(JSON.stringify({ id: v.id, deliver: v.deliver, reason: v.deliver ? "delivered" : "held for the owner" }));
      return v.deliver ? 0 : 1;
    }
    const key = process.env.AGENTMAIL_RELAY_KEY;
    if (args.includes("--agentmail") && !key) { console.error("set AGENTMAIL_RELAY_KEY (a key scoped to the relay inbox only)"); return 2; }
    const t = args.includes("--agentmail") ? agentMailTransport(cfg, key!) : fileTransport(root);
    const rel = arg(args, "--release") ?? arg(args, "--drop");
    if (rel) { console.log(decideHeld(root, t, rel, args.includes("--release") ? "release" : "drop")); return 0; }
    relayTick(root, t, args.includes("--no-model") ? { model: null } : {}).then((vs) => {
      for (const v of vs)
        console.log(`${v.id}: ${v.sender ?? "?"} -> ${v.recipient ?? "?"} ${v.deliver ? "DELIVERED" : "HELD"}${v.alert ? " (alert)" : ""}${v.reasons.length ? "\n  " + v.reasons.join("\n  ") : ""}`);
      process.exit(0);
    }, (e) => { console.error((e as Error).message); process.exit(1); });
    return -1;
  }

  if (cmd === "textline") {
    const sub = args[0];
    if (sub === "init") {
      const f = join(root, "rules", "escalation.yaml");
      if (existsSync(f)) { console.log("rules/escalation.yaml already exists"); return 0; }
      writeFileSync(f, ESCALATION_TEMPLATE);
      git(root, ["add", "rules/escalation.yaml"]);
      git(root, ["commit", "-q", "-m", "owner: text channel escalation rules", "--", "rules/escalation.yaml"], OWNER);
      console.log("wrote rules/escalation.yaml; edit transport, quiet hours and phone numbers");
      return 0;
    }
    if (sub === "use") {
      const f = join(root, "rules", "escalation.yaml");
      if (!existsSync(f)) { console.error("no rules/escalation.yaml yet: run `pocketbrain textline init` first"); return 1; }
      const use = args[1], flag = arg(args, "--to");
      if (!use || use.startsWith("--")) { console.error(`textline use <${TRANSPORTS.join("|")}> [--to <handle>|-]`); return 2; }
      const to = flag === "-" ? readFileSync(0, "utf8").trim() || undefined : flag;
      let next: string;
      try { next = useTransport(readFileSync(f, "utf8"), use, to); } catch (e) { console.error((e as Error).message); return 1; }
      if (next === readFileSync(f, "utf8")) { console.log(`transport is already ${use}`); return 0; }
      writeFileSync(f, next);
      // commitPaths puts the file back if the commit can't happen (a replica's hub gate, a lock).
      let why: string | undefined;
      try { why = commitPaths(root, ["rules/escalation.yaml"], `owner: text channel transport ${use}`, OWNER); } catch (e) { why = (e as Error).message; }
      if (why) { console.error(`not changed: ${why}`); return 1; }
      console.log(`transport: ${use}${to ? " (to the handle you gave)" : ""}. The next tick texts through it; \`pocketbrain textline status\` shows it.`);
      return 0;
    }
    if (sub === "reply") { fakeReply(root, args.slice(1).filter((a, i, all) => a !== "--brain" && all[i - 1] !== "--brain").join(" ")); console.log("queued; the next tick applies it"); return 0; }
    if (sub === "watch") { watch(root); return -1; }
    if (sub === "watchdog") {
      const url = arg(args, "--url");
      if (!url) { console.error("textline watchdog --url <https://brain.example/health> [--state <dir>]"); return 2; }
      const p = loadEscalation(root);
      const t = makeTransport(root, p.transport.fallback ?? p.transport.use, p.transport);
      watchdog(arg(args, "--state") ?? join(root, "textline"), url, t).then((r) => { console.log(r.ok ? "hub answers" : `hub down${r.sent ? "; texted you" : ""}`); process.exit(0); });
      return -1;
    }
    if (sub === "status") {
      const p = loadEscalation(root), st = loadTextState(root);
      for (const it of openItems(root)) {
        const s = st.items[it.key];
        console.log(`${it.kind.padEnd(11)} ${it.private ? "private " : ""}${it.money ? "money " : ""}${it.title}${s?.last_texted ? ` [texted ${s.last_texted.slice(0, 16)}]` : ""}${s?.snoozed_until ? ` [later until ${s.snoozed_until.slice(0, 16)}]` : ""}`);
      }
      tick(root, { dryRun: true }).then((r) => { console.log(`\ntransport: ${p.transport.use}${p.transport.fallback ? ` (fallback ${p.transport.fallback})` : ""}; next tick: ${r.sent ? `would text:\n${r.sent.text}` : r.reason}`); process.exit(0); });
      return -1;
    }
    if (sub === "once") {
      tick(root, { dryRun: args.includes("--dry-run") }).then((r) => {
        for (const a of r.applied) console.log(`reply applied:\n${a}`);
        console.log(r.sent ? `texted via ${r.sent.via}:\n${r.sent.text}` : `no text: ${r.reason}`);
        process.exit(0);
      }, (e) => { console.error(String(e?.message ?? e)); process.exit(1); });
      return -1;
    }
    console.error("textline once | watch | status | init | use <transport> | reply <text> | watchdog --url <u>");
    return 2;
  }

  if (cmd === "logs") {
    const sub = args[0];
    if (arg(args, "--release") || arg(args, "--drop")) {
      console.log(arg(args, "--release") ? decideLog(root, arg(args, "--release")!, "release") : decideLog(root, arg(args, "--drop")!, "drop"));
      return 0;
    }
    if (sub === "import") {
      const agent = arg(args, "--as"), file = arg(args, "--file");
      if (!agent || !file) { console.error("logs import: --as <agent> --file <export>"); return 2; }
      const logs = parseExport(file, (arg(args, "--format") ?? "auto") as LogFormat, { date: arg(args, "--date") });
      const tally: Record<string, number> = {};
      for (const l of logs) {
        const r = ingestLog(root, agent, l as Record<string, unknown>, { via: "import", by: OWNER });
        tally[r.outcome] = (tally[r.outcome] ?? 0) + 1;
        if (r.outcome !== "committed" && r.outcome !== "noop") console.log(`${r.outcome}: ${l.log_id ?? l.title ?? "?"}: ${r.held?.join("; ") ?? r.message}`);
      }
      console.log(`${logs.length} logs from ${file}: ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(", ") || "nothing found"}`);
      return 0;
    }
    if (sub === "search") {
      const q = args[1];
      if (!q) { console.error('logs search "<words>"'); return 2; }
      const hits = searchLogs(root, q, { limit: Number(arg(args, "--limit") ?? 20) }).filter((h) => !arg(args, "--agent") || h.agent === arg(args, "--agent"));
      for (const h of hits) console.log(`${h.id}  ${h.date}  ${h.agent}${h.held ? " [held]" : ""}${h.archived ? " [archived]" : ""}  ${h.title ?? ""}\n    ${h.match}`);
      if (!hits.length) console.log("no matching logs");
      return 0;
    }
    if (sub === "read") {
      const l = readLog(root, args[1] ?? "");
      if (!l) { console.error(`no log ${args[1]}`); return 1; }
      console.log(YAML.stringify(l.meta, { lineWidth: 0 }) + "\n" + l.text);
      return 0;
    }
    if (sub === "held") {
      const held = listLogs(root, undefined, { held: true }).filter((l) => l.held);
      for (const l of held) console.log(`${l.rel.replace(/^inbox\/logs\//, "")}: ${(l.fm.held as string[]).join("; ")}`);
      if (!held.length) console.log("no held logs");
      return 0;
    }
    console.error("logs import | search | read | held | --release <file> | --drop <file>");
    return 2;
  }

  if (cmd === "write") {
    const agent = arg(args, "--as");
    const json = arg(args, "--json") ?? (arg(args, "--file") ? readFileSync(arg(args, "--file")!, "utf8") : undefined);
    if (!agent || !json) { console.error("write: --as <agent> and --json or --file"); return 2; }
    const req = { ...(JSON.parse(json) as WriteRequest), agent };
    const r = write(root, req);
    console.log(JSON.stringify(r, null, 2));
    return r.outcome === "refused" ? 1 : 0;
  }

  console.error(ownerError("cli.unknown", { cmd }));
  return 2;
}

function backupCli(cmd: string, args: string[], root: string): number {
  const fail = (e: unknown) => { if (e instanceof bk.BackupError || e instanceof hub.HubError) { console.error(`${cmd}: ${e.message}`); process.exit(1); } throw e; };
  if (cmd === "backup") {
    if (args[0] === "offsite") {
      const home = process.env.HOME ?? homedir(), uid = process.getuid?.() ?? 501;
      const run = (c: string[]) => { const r = Bun.spawnSync(c); return { code: r.exitCode ?? 1, out: r.stderr.toString() + r.stdout.toString() }; };
      if (args[1] === "copy") {
        const to = arg(args, "--to");
        if (!to) { console.error("backup offsite copy --to <folder>"); return 2; }
        offsiteCopy(root, to).then((r) => { console.log(r.error ? `offsite: ${r.error}` : `offsite: ${r.copied.length} copied`); process.exit(r.error ? 1 : 0); });
        return -1;
      }
      if (process.platform !== "darwin") { console.error("backup offsite is for a Mac (launchd); elsewhere copy the backup folder with your own scheduler"); return 1; }
      try {
        if (args[1] === "on" && args[2] && !args[2].startsWith("--")) { console.log(offsiteOn(root, args[2], { home, uid, run, bun: process.execPath, app: resolve(import.meta.dir, "..") })); return 0; }
        if (args[1] === "off") { console.log(offsiteOff(root, { home, uid, run })); return 0; }
      } catch (e) { console.error(`backup offsite: ${(e as Error).message}`); return 1; }
      console.error("backup offsite on <folder> | off"); return 2;
    }
    if (args.includes("--init")) {
      const pub = arg(args, "--pub");
      if (!pub || !/^age1[0-9a-z]{58}$/.test(pub)) { console.error("backup --init --pub <age1...>: the PUBLIC key (age-keygen -y). The private key goes in your password manager"); return 2; }
      mkdirSync(join(root, "rules"), { recursive: true });
      if (!existsSync(join(root, "rules", "backup.yaml"))) writeFileSync(join(root, "rules", "backup.yaml"), bk.CONFIG_TEMPLATE);
      writeFileSync(join(root, "rules", "backup.pub"), `# age public key(s) backups are encrypted to. The private key is in your password manager.\n${pub}\n`);
      git(root, ["add", "rules/backup.yaml", "rules/backup.pub"]);
      git(root, ["commit", "-q", "-m", "louis: backups set up", "--", "rules/backup.yaml", "rules/backup.pub"], "louis");
      console.log("wrote rules/backup.yaml and rules/backup.pub; set dest in rules/backup.yaml, then: pocketbrain drill --identity <key>");
      return 0;
    }
    try {
      if (args.includes("--if-due")) {
        const d = bk.due(root);
        if (!d.due) { console.log(`not due: ${d.why}`); return 0; }
      }
      const r = bk.backup(root, { dest: arg(args, "--dest") });
      console.log(`backup: ${r.file} (${r.bytes} bytes, sha256 ${r.sha256.slice(0, 12)}) at ${r.head.slice(0, 8)}, ${r.extras} untracked state files`);
      for (const s of r.skipped) console.log(`  left out: ${s.path} (${s.reason})`);
      if (r.uncommitted.length) console.log(`  not in this backup (uncommitted): ${r.uncommitted.join(", ")}`);
      if (r.deleted.length) console.log(`  rotated out: ${r.deleted.join(", ")}`);
      return 0;
    } catch (e) { fail(e); return 1; }
  }
  if (cmd === "restore") {
    const file = args[0], to = arg(args, "--to"), identity = arg(args, "--identity");
    if (!file || file.startsWith("--") || !to || !identity) { console.error("restore <file.tar.age> --to <empty dir> --identity <key file | ->"); return 2; }
    bk.restore(file, { to, identity, key: arg(args, "--key"), name: arg(args, "--name"), signer: arg(args, "--signer") }).then((r) => {
      recordRepair(r.to, "restore");
      console.log(`restored ${r.head.slice(0, 8)} into ${r.to}: ${r.refs} ref(s), ${r.extras} state file(s)${r.replica ? `, machine ${r.replica}` : ""}; views rebuilt for ${r.built.join(", ") || "nobody"}`);
      console.log(renderDoctor(r.findings));
      for (const n of r.next) console.log(`next: ${n}`);
      process.exit(r.findings.some((f) => f.level === "FAIL") ? 1 : 0);
    }, fail);
    return -1;
  }
  // --demo: the sample brain and a throwaway key; the owner's brain is never opened or recorded in.
  if (args.includes("--demo")) {
    bk.demoDrill().then((d) => {
      console.log(d.ok ? bk.demoLine(d) : bk.renderDrill(d));
      process.exit(d.ok ? 0 : 1);
    }, fail);
    return -1;
  }
  bk.drill(root, { identity: arg(args, "--identity"), key: arg(args, "--key") }).then((d) => {
    console.log(bk.renderDrill(d));
    recordDrill(root, d.ok);
    process.exit(d.ok ? 0 : 1);
  }, fail);
  return -1;
}

// pocketbrain search setup: the one time the semantic-search model is downloaded (src/semantic.ts), in a
// child process (src/semantic-setup.ts) so the model never loads in this one.
function searchCli(args: string[]): number {
  if (args[0] !== "setup") { console.error(usageOf("search")); return 2; }
  console.log(`Semantic search runs on this machine: only the model is downloaded, once; no note and no query leaves it.\nModel: ${MODEL_ID} (q8, MIT licence) from ${MODEL_PAGE} (large files from ${MODEL_FILE_HOST}, or another *.cdn.hf.co by region)\nInto:  ${modelDir()} (PB_MODEL_DIR to put it elsewhere)`);
  setupInChild((file) => console.log(`  got ${file}`)).then((r) => {
    console.log(`${r.already ? "Already here" : "Done"}: ${Math.round(r.bytes / 1e6)} MB in ${modelDir()}. Semantic search is on (a running hub uses it from its next search); PB_SEMANTIC=0 turns it off, deleting that folder removes it.`);
    process.exit(0);
  }, (e) => { console.error(`search setup: ${(e as Error).message}`); process.exit(1); });
  return -1;
}

if (import.meta.main) {
  try {
    const code = main(process.argv.slice(2));
    if (code >= 0) process.exit(code);
  } catch (e) {
    // A hub refusal is an answer, not a crash.
    if (e instanceof hub.HubError || e instanceof CoreError) { console.error(e.message); process.exit(1); }
    if (process.env.PB_DEBUG) throw e;
    console.error(ownerError("cli.crash", { cmd: process.argv[2] ?? "", message: (e as Error)?.message ?? String(e) }));
    process.exit(1);
  }
}

// `pocketbrain menubar`: what the Mac menu-bar app runs (src/menubar.ts, docs/menubar.md).
// Leaving: the plan first, then --yes. The brain is the one the installed hub serves unless named.
function uninstallCli(args: string[]): number {
  const home = process.env.HOME ?? homedir();
  const brain = arg(args, "--brain") ?? process.env.PB_BRAIN ?? installedBrain(home) ?? rememberedBrain();
  const run: Run = (cmd) => { try { const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode ?? 1, out: `${r.stdout}${r.stderr}` }; } catch (e) { return { code: 127, out: (e as Error).message }; } };
  let steps;
  try { steps = uninstallPlan({ home, config: configDir(), brain, uid: process.getuid?.() ?? 501, removeBrain: args.includes("--remove-brain") }); }
  catch (e) { console.error((e as Error).message); return 1; }
  if (!args.includes("--yes")) { console.log(`${planText(steps)}\n\nNothing removed yet. If this is right, run the same command with --yes.`); return 0; }
  for (const l of runUninstall(steps, { run })) console.log(l);
  return 0;
}

function menubarCli(args: string[], fallback: string): number {
  const home = process.env.HOME ?? homedir();
  const root = arg(args, "--brain") ?? process.env.PB_BRAIN ?? installedBrain(home) ?? fallback;
  const uid = process.getuid?.() ?? 501;
  const run: Run = (cmd) => { const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode ?? 1, out: `${r.stdout}${r.stderr}` }; };
  const sub = args[0] && !args[0].startsWith("--") ? args[0] : "status";
  try {
    if (sub === "install") {
      if (process.platform !== "darwin") { console.error("menubar install is for a Mac (launchd); elsewhere use systemd with pocketbrain start"); return 1; }
      for (const l of installHub(root, { home, uid, run, bun: process.execPath, app: resolve(import.meta.dir, ".."), tunnel: arg(args, "--tunnel"), tunnelConfig: arg(args, "--tunnel-config") })) console.log(l);
      return 0;
    }
    if (sub === "restart") { console.log(restartHub({ home, uid, run, before: () => recordFix(root, "restarted the hub from the menu", "auto:menubar") })); return 0; }
    if (sub === "open-dashboard") { console.log(openDashboard({ home, run, root })); return 0; }
    if (sub === "setup") {
      // The first-run window: init + install in one step, the result as JSON for the window.
      const name = arg(args, "--name");
      if (!name) { console.error('menubar setup --name "Your name" [--agent claude] [--dir ~/my-brain] [--from-text notes.txt]'); return 2; }
      const dir = resolve(arg(args, "--dir") ?? join(home, "my-brain"));
      const install = process.platform === "darwin" && !args.includes("--no-install") ? { home, uid, run, bun: process.execPath, app: resolve(import.meta.dir, "..") } : undefined;
      const r = setupBrain(dir, { name, agent: arg(args, "--agent"), text: args_(args, "--from-text"), install });
      try { mkdirSync(configDir(), { recursive: true }); writeFileSync(join(configDir(), "brain"), r.brain + "\n"); } catch { /* optional convenience */ }
      console.log(JSON.stringify(r));
      return 0;
    }
  } catch (e) { console.error(e instanceof InitError ? `init: ${e.message}` : (e as Error).message); return e instanceof InitError ? 2 : 1; }
  if (sub !== "status") { console.error("menubar [--json] | open-dashboard | setup --name <you> | install [--tunnel <name> [--tunnel-config <file>]] | restart"); return 2; }
  menuState(root, { home, port: Number(arg(args, "--port") ?? 8787) }).then((s) => {
    console.log(args.includes("--json") ? JSON.stringify(s) : [menuTitle(s), s.hubUp ? `hub up at ${s.hubUrl}` : s.installed ? "hub installed but not answering" : "hub not installed (pocketbrain menubar install)", s.barLine, ...s.agents.map((a) => `${a.name}: ${a.status}`)].join("\n"));
    process.exit(0);
  }, (e) => { console.error((e as Error).message); process.exit(1); });
  return -1;
}

// What `consent` prints: the sentence's slice in plain words, three of each, and the line that applies it.
function renderConsent(p: consent.Proposal): string {
  const L = [`${p.agent} would see ${p.notes} of your ${p.total} notes: ${p.slices.join(", ")}${p.exclude_types.length ? `, without ${p.exclude_types.join(", ")}` : ""}.`];
  if (p.why) L.push(`Why: ${p.why} (proposed by ${p.by})`);
  if (p.note) L.push(`Note: ${p.note}`);
  if (p.before) L.push(`Today it sees ${p.before.notes} notes: ${p.before.slices.join(", ") || "nothing"}${p.before.exclude_types.length ? `, without ${p.before.exclude_types.join(", ")}` : ""}.`);
  L.push("", "It would see, for example:", ...(p.sees.length ? p.sees.map((x) => `  + ${x.title}  (${x.id})`) : ["  (nothing)"]));
  L.push("", "It would not see, for example:", ...(p.hidden.length ? p.hidden.map((x) => `  - ${x.title}  (${x.id}): ${x.why}`) : ["  (nothing is left out)"]));
  L.push("", "Nothing changed yet. To apply it:", p.widens ? `  open the dashboard, ${p.agent}'s page, "What is it for?": it shows ${p.agent} more than today, which needs your login` : `  ${p.command}`);
  return L.join("\n");
}

function renderUsage(s: ReturnType<typeof summary>, cap: ReturnType<typeof capState>): string {
  const m = (n: number) => money(n, cap.currency);
  const tok = (t: { tokens_in: number; tokens_out: number; estimated: boolean }) => `${t.tokens_in + t.tokens_out}${t.estimated ? "~" : ""}`;
  const pad = (v: unknown, n: number) => String(v).padStart(n);
  const L = [`Model spend for ${s.month}: ${m(s.total.cost)}${cap.cap !== undefined && s.month === cap.month ? ` of ${m(cap.cap)} (${Math.floor((cap.ratio ?? 0) * 100)}%, ${cap.state})` : cap.cap === undefined ? " (no cap set)" : ""}`, ""];
  L.push(`${"day".padEnd(10)} ${pad("calls", 6)} ${pad("errors", 6)} ${pad("tokens", 10)} ${pad("time", 9)} ${pad("cost", 9)}`);
  for (const d of s.days) L.push(`${d.day} ${pad(d.calls, 6)} ${pad(d.errors, 6)} ${pad(tok(d), 10)} ${pad(fmtMinutes(d.seconds), 9)} ${pad(m(d.cost), 9)}`);
  if (!s.days.length) L.push("(no model calls this month)");
  if (s.steps.length) {
    L.push("", "By step:");
    for (const st of s.steps) {
      const c = cap.steps.find((x) => x.step === st.step);
      L.push(`  ${st.step.padEnd(20)} ${pad(st.calls, 4)} calls ${pad(tok(st), 10)} tokens ${pad(fmtMinutes(st.seconds), 8)}  ${m(st.cost)}${c ? ` of ${m(c.cap)}${c.over ? " (paused)" : ""}` : ""}  ${st.models}`);
    }
  }
  L.push("", "Reads and writes are never metered or capped.");
  if (s.total.estimated) L.push("~ tokens estimated from text length (the provider reported none).");
  if (s.total.unpriced) L.push("Some calls used a model with no listed price (src/pricing.ts) and count as 0; set usage.prices in policy.yaml.");
  return L.join("\n");
}
