# Ask to see

An assistant needs something outside its slice. It asks; the owner's phone buzzes; the owner approves; the assistant reads that one note once. Its slice doesn't change, and the read log shows the read with the approval attached.

Code: `src/asks.ts`. Tests: `test/asks.test.ts` (a fake Auth0 stands in for the phone).

## Turning it on

Off unless `rules/policy.yaml` says so:

```yaml
ask_to_see:
  approver: guardian          # or dashboard (the default); the dashboard works either way
  never: [money]              # types, folders or areas never offered, whatever the owner taps
  expires_minutes: 5          # how long an ask waits (a phone push lasts at most 5 minutes)
  use_within_minutes: 15      # how long an approval stays usable
  max_per_day: 5              # per assistant
  push_title: false           # true puts the note's title in the push; default is a code only
# An agent's `label` in policy.yaml (e.g. `claude: { label: claude.ai, … }`) names it in the push.
  guardian:
    client_id: <Auth0 application with the CIBA grant>
    # domain and user_id default to rules/oauth.yaml (issuer, owner_subject)
```

The application's secret goes in `~/.config/pocketbrain/keys/AUTH0_CIBA_CLIENT_SECRET` (file mode 600), like the other hub keys. It never goes in the brain.

## What the assistant sees

MCP tools `ask_to_see` (what, why) and `ask_status` (request); JSON `POST /v1/ask` and `GET /v1/ask/{request}`. Listed only when turned on, never for the gardener. The orientation gets a short "Asking to see something" section.

1. `ask_to_see` always answers `waiting` with a request id, whether or not the brain holds anything like it (invariant 3). A miss reaches nobody and runs out like an ask the owner ignored.
2. `ask_status`: `waiting`, then `approved` with the note (once), then `used`. A decline, an expiry or a miss is `not approved`.
3. One ask waiting per assistant, and `max_per_day`, so an assistant can't flood the owner's phone.

## What the owner sees

- **Phone (Guardian):** "helper wants to read a private person note once. Code K7QM". Approving releases the best match; the dashboard shows the same code next to it. The push names the kind of note (its level and type) so a phone approval isn't blind; the title is only in it with `push_title: true`, since the push travels through Auth0 and Apple or Google.
- **Dashboard, Needs you:** "helper wants to read Mom once", its reason, the words it used, the time left, **Allow once** for the best match, **Allow X instead** for the next two matches, and **Decline**. If the push couldn't be sent, the reason is right there.
- **CLI:** `pocketbrain ask list | approve <id> [note] | decline <id> | test`.

## What holds

- Only the owner approves: a dashboard click (loopback, CSRF) or a CIBA approval whose id token names the owner's own Auth0 user. An approval by any other user is treated as a decline. No agent, relayed text or model can approve.
- One approval is one read of one note. The note is rendered as a view holding only that note: links to anything else show as `[[redacted]]`, secret facts and facts limited with `share_with` stay out. A note that became secret, moved to a `never` type or was deleted after the approval is not handed over.
- Secret notes, conflict packets, agents' own notes and anything in `never` are never offered.
- Every step is in `log/asks.jsonl` (asked, push, approved, declined, used, expired) and the read in `log/reads.jsonl` as `ask_read` with `grant`, `approved_via` and the Auth0 request id. Both are hash-chained.
- The one read comes from the hub's own brain, not the agent's cell (invariant 10): the owner's approval is the gate, and the render holds only the approved note.
- Revoking an agent in the dashboard declines its waiting asks and voids an approval it hasn't used.
- A one-time read is a disclosure. The assistant is told not to store it or pass it on, and the leak tripwire and relay checks still apply to its writes and mail, but nothing can make it forget.

## How the phone path works

Auth0 Client-Initiated Backchannel Authentication (CIBA), which Auth0 for AI Agents calls Async Authorization:

1. `POST https://<tenant>/bc-authorize` with the client id and secret, `login_hint` `{"format":"iss_sub","iss":"https://<tenant>/","sub":"<owner user id>"}`, `scope=openid`, `binding_message` (64 characters of letters, digits, spaces and `+-_.,:#`) and `requested_expiry` (at most 300 seconds, so it goes by push).
2. Auth0 pushes to the Guardian app on the owner's phone.
3. The hub polls `POST /oauth/token` with `grant_type=urn:openid:params:grant-type:ciba` every 5 seconds (the server's tick, the dashboard on load, and the assistant's `ask_status`): `authorization_pending` and `slow_down` mean wait, `access_denied` is a decline, `expired_token` is an expiry, and tokens mean approved.

If the hub restarts between logging an ask and logging its push (the request id), the owner's answer on the phone could never be read. Every ask records which run of the hub made it, and the first poll after a restart sends that ask's push again, once; the owner answers the new one.

The tokens themselves are never used or stored; only the fact of the approval and its request id are kept.

## Setting up Auth0

Needs a tenant where CIBA is available (check the plan) and the owner enrolled in Guardian push.

1. Security > Multi-factor Auth: turn on **Push Notification using Auth0 Guardian**.
2. Enroll the owner's phone in Guardian (sign in once with MFA required, or send an enrollment ticket from the user's page).
3. Applications > Create Application > Regular Web Application, named `pocketBrain ask to see`. In its settings, turn on the **Client-Initiated Backchannel Authentication (CIBA)** grant and choose Guardian push as its notification channel.
4. Copy its client id into `ask_to_see.guardian.client_id`, and its secret into the keys folder.
5. `pocketbrain ask test`: the phone shows "pocketBrain test. Code XXXX"; approve it and the command says the phone path works.
