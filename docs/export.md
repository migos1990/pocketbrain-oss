# Export and import: Memory Passport bundles

A way out of pocketBrain and back in, as one JSON file. Owner-only: no agent route reaches it.

```sh
pocketbrain export --out brain.json                 # the whole brain
pocketbrain export --agent helper --out helper.json # one agent's slice
pocketbrain import brain.json --into ~/new-brain    # a fresh brain from a brain bundle
```

## Brain bundle

`{ "memory_passport": "0.2", "bundle": "brain", "exported", "owner", "notes": [{ "fm", "body" }], "rules": { file: text } }`

- Every content note: its front matter (facts with their source refs, history, sensitivity, who can see it) and its body.
- The rules a carve reads, and only those: `rules/RULES.md`, `policy.yaml`, `slices.yaml`, `checks.yaml`, `standing.yaml`.
- Never: raw sources (notes hold refs only), `rules/tokens.yaml`, OAuth bindings, invites, `hub.yaml`, logs, the inbox, handoffs, or anything `secret`. Secret notes and facts are dropped, and a secret value found anywhere else in a note's text becomes `[secret]`.

`import` writes a brain bundle into a folder that doesn't exist or is empty, as one commit by the owner. Each agent then gets the same carve it had (`test/passport.test.ts` checks this for every agent in the sample brain). Agents need new tokens there: `pocketbrain token --agent <agent>`. Import refuses a slice bundle, a note id outside the content folders (`people/`, `projects/`, …), the same note twice, and any rules file export doesn't write, before it writes anything.

## Slice bundle

`{ "memory_passport": "0.2", "bundle": "slice", "exported", "agent", "notes": [{ "id", "title", "type", "area", "aliases", "facts", "body" }] }`

One agent's view, each note as `GET /v1/notes/{id}` answers that agent: hidden facts left out, hidden values and links withheld. It is for another memory tool that speaks Memory Passport ([spec/memory-passport.md](spec/memory-passport.md#bundles)); `import` doesn't take it.

Both files are the owner's memory in clear (written `0600`): keep them like a backup ([backup.md](backup.md) for encrypted ones). A whole-brain handover to another person is `pocketbrain handover`.
