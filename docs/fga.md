# OpenFGA: a second lock on each assistant's slices

Optional. With it on, an assistant keeps a slice from `rules/policy.yaml` only if OpenFGA (self-hosted, or a hosted service such as Auth0 FGA) also says it may read that slice. FGA can only take access away: a slice that isn't in policy.yaml is never added because FGA has it. The carve inside each slice (which facts, which sensitivity) stays on the hub.

FGA holds agent names and slice names only (`agent:town reader slice:area__hec`), never a note id, a title or a value. It knows who may see what, never what it says.

## What it does on the hub

- The hub asks FGA, every `refresh_s` (default 30), which slices each outside assistant can read (`list-objects`, relation `can_read`).
- Every read, search, write check and relay check uses policy.yaml's slices narrowed to that answer.
- Deleting a tuple in the FGA console cuts the slice on the next refresh. Adding it back restores it; no rebuild.
- If FGA can't be reached for longer than `max_age_s` (default 120), outside assistants get no slices until it answers (fail closed). Assistants inside the wall are not affected.

## Setup

1. In the Auth0 FGA dashboard (or your own OpenFGA server), create a store and an API client with read and write access to it. Note the store id, the client id, and the API URL, token issuer and audience it shows (for the US region: `https://api.us1.fga.dev`, `https://fga.us.auth0.com`, `https://api.us1.fga.dev/`).
2. Write `rules/fga.yaml` in the brain:

   ```yaml
   api_url: https://api.us1.fga.dev
   store_id: <store id>
   token_issuer: https://fga.us.auth0.com
   api_audience: https://api.us1.fga.dev/
   client_id: <client id>
   ```

3. Put the client secret in `~/.config/pocketbrain/keys/FGA_CLIENT_SECRET` (mode 600, from 1Password).
4. `pocketbrain fga model`: writes the model and saves its `model_id` in `rules/fga.yaml` (an owner commit).
5. `pocketbrain fga sync` shows the tuples that match policy.yaml; `pocketbrain fga sync --apply` writes them.
6. Restart the hub. Its log says `fga: on, N agent(s) confirmed`. `pocketbrain fga check <agent>` shows what FGA allows.

To turn it off, delete `rules/fga.yaml` and restart the hub.
