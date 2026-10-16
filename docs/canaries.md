# Canary kit

A canary is a made-up string that exists in exactly one decoy note. If it ever shows up anywhere else (an agent's answer, a mail between agents, a write into another note), something leaked, and the canary says from where.

## Planting

```sh
pocketbrain probe init            # plant the decoys (once; re-running changes nothing)
pocketbrain probe init --rotate   # new canaries; the old ones stay watched
```

`probe init` writes three decoy notes, `notes/probe-personal`, `notes/probe-private` and `notes/probe-secret`, in the `probe` area, tagged `canary`, each with a unique canary as its `reference` fact and in its body. It adds the slice `probe: { areas: [probe] }` to `rules/slices.yaml` and records the list in `rules/canaries.yaml` (never served to an agent; `handover` strips canary notes). All of it is one commit authored by the owner, and the command prints the canaries and which agents can see each decoy.

Only a slice that names the `probe` area reaches these notes (`src/carve.ts`): not `all`, not a type, tag or sensitivity slice. So today no agent sees any of them. A prober agent (managed-agents-audit section 7) is an ordinary entry in `rules/policy.yaml`:

```yaml
auditor: { tier: trial, slices: [probe] }
```

On the trial tier it sees the personal decoy and nothing else, so its answers may carry that canary and never the other two.

## Watching

- **Relay:** mail carrying any planted or retired canary is held and alerts (the relay reads `rules/canaries.yaml` next to the `canaries:` in `rules/relay.yaml`).
- **Write path:** a write whose fields (value, text, title, attribute, source refs) carry a canary whose decoy the writer can't see is refused and alerts, whatever the decoy's level. The writer sees an ordinary `leak_tripwire` refusal that names no note, fact or canary; only the owner's alert says which (eval gap G165).
- **Reads:** a context pack, search or read that would hand an agent a canary its carve doesn't hold raises a `canary_served` alert. (Values carved from an agent are also scrubbed from what it reads, so the private and secret canaries never get that far.)

## The leak oracle

```sh
pocketbrain probe check answer.txt              # every canary in the text
pocketbrain probe check - --as auditor < reply  # only the ones auditor can't see
```

It exits 1 on a find. Spacing, case, dashes and look-alike letters don't hide a canary (the same `squash` as the relay's matcher). Evals use `findCanaries` from `src/canary.ts`; the `rt-canary-*` cases in `evals/cases/redteam.ts` check that no agent without the probe slice gets a canary through any door and that a relayed or written canary is held.
