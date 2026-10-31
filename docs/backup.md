# Backups and recovery: the runbook

This is the short version of [backup-recovery.md](history/backup-recovery.md) section 3 and 5, as built. It assumes your keys live in 1Password.

## What a backup is

`pocketbrain backup` writes one file, `brain-YYYY-MM-DD.tar.age`, into a folder your storage service syncs. Inside, encrypted with [age](https://age-encryption.org) to the public key in `rules/backup.pub`:

- a git bundle of every ref: all history, `rules/` (including `tokens.yaml`, which only holds hashes), `ops/`, `log/writes.jsonl`, inbox, everything committed;
- the state git doesn't carry: the read log, alerts, sleep state, text channel state, each with its sha256 in a manifest;
- nothing derived (`views/`, `.cells/`) and nothing secret. Credential files (`.env`, private keys) and any file holding a private key, an age key, an access token (a plaintext agent token or a JWT), an API key or a credential variable are left out and named in the output. If main itself holds one, no backup is made until you rotate it and scrub history (backup-recovery.md 4.5). The write path refuses the same shapes (`no_secret_shapes`, one list in `src/checks.ts`), so a note an agent writes can't stop your backups: it checks every string a write carries, attribute names, `share_with` and a new note's area included. The relay's `comms/` records and the `handoffs/` records are committed too: their sender-written fields (subject, text, message id and addresses; task and next step) are redacted before they are written, and if a private key is split across them (BEGIN in one, the body in another) the whole record's sender fields are blanked, so a secret-shaped string in relayed mail or a handoff can't stop them either (G201). The reasons in those records are redacted too, and `alert()` redacts every field of every line it writes to the committed `log/alerts.jsonl` (G280); it is the only writer of that file, the capture mailbox's alerts included (G312). Anything else committed to main by hand is checked as it is. A private key counts only with its key body after the BEGIN line, so a note that merely names the header is kept. Search words and asked-for ids in `log/reads.jsonl`, and agents' answers and notes in `log/memsync.jsonl`, are logged with secret-shaped strings redacted, so those logs always go in. A read log that already holds one from before this change stays out and is named in the output (it is still on disk).

The hub only ever holds the **public** key. Backups can be made unattended and can't be read on the machine that makes them.

Rotation: every file from the last 30 days, then the first file of each month forever (`keep_daily`, `keep_monthly` in `rules/backup.yaml`). The newest file is never deleted, and files the tool didn't name are never touched.

## One-time setup (about 10 minutes)

1. **Make the key straight into 1Password.** The private key is never written to a file:

   ```sh
   KEY=$(age-keygen 2>/dev/null | grep AGE-SECRET-KEY)
   op item create --category=password --vault=Private --title="pocketBrain backup key" "password=$KEY"
   pocketbrain backup --init --pub "$(echo "$KEY" | age-keygen -y)"
   unset KEY
   ```

   Without the `op` CLI: run `age-keygen`, paste the `AGE-SECRET-KEY-1…` line into a new 1Password item named "pocketBrain backup key", pass the `age1…` line to `--init --pub`, and close the terminal.

2. **Paper copy.** Write or print the `AGE-SECRET-KEY-1…` line and keep it with your 1Password Emergency Kit. It is the only way back if the 1Password account itself is lost.

3. **Point at the synced folder.** In `rules/backup.yaml`, set `dest:` to a `pocketbrain-backups/` folder your storage service's desktop app syncs. A stand-in machine whose path differs can set `PB_BACKUP_DEST` instead.

4. **Prove it with the real key.** On the hub machine, once the key is in 1Password (this is the drill the real-use bar counts):

   ```sh
   cd ~/pocketbrain && bun src/cli.ts drill --brain ~/pocketbrain-brain --identity <(op read "op://Private/pocketBrain backup key/password")
   ```

   The drill copies the brain, backs the copy up to a temporary folder, wipes the copy, restores it with the key from 1Password, and diffs refs, history, tree, untracked state and machine name. On the restored copy it then runs `git fsck --full`, compares note and fact counts with the original, and boots the hub on it (rules load, `/health` answers 200). It also runs doctor on the restored brain and checks the backup for secrets. A log (`log/*.jsonl`) the backup left out for holding a secret shape fails the drill (`LOST:`), since a restore would start that log empty. The diff covers the brain's content, not the hub's own logs under `log/`: a log the hub writes without committing (the pull's `log/sources/runs.jsonl`) differs after a restore by design. Open hub alerts don't fail the drill either; they are the live brain's state, listed apart under "open alerts on the brain". It never touches the brain or the real folder. Expect `drill PASSED` and "the 1Password key path is proven". Run it again after changing the key or the storage service.

   To see the mechanics without any brain or key, `pocketbrain drill --demo` runs the same drill on the sample brain (`examples/brain`) with a throwaway key and prints one line, for example `drill PASSED in 0.3s (demo brain, throwaway key): 6 notes, 6 facts, fsck clean, hub booted`. It never opens your brain, runs from any folder (no brain needs to be there or remembered) and is not counted by the bar. CI runs it on every push.

5. **Signing key.** If the hub signs commits (`rules/hub.yaml`), its SSH signing key belongs in 1Password too (1Password's SSH agent, `hub init --signer op-ssh-sign`, see [hub.md](hub.md)). A restore needs it to become the hub again.

## Schedule

`pocketbrain serve` on the hub looks every hour, and once a few minutes after it starts, and backs up when main has moved and `every_hours` (24) have passed. Each look leaves its time in `log/backup-look.json`, and `pocketbrain doctor` shows "last backup look N min ago". Each backup commits a one-line `log/last-backup` with the file name, commit and hash; the backups themselves never go near git. If the hub doesn't run `serve`, schedule `pocketbrain backup --if-due` hourly with launchd or cron. Replicas leave backups to the hub. The hub makes each backup in a child process (`pocketbrain backup --if-due`) and stops it after 20 minutes, so a backup folder on a cloud drive that stops answering can't freeze the hub; the probe's stale-backup check then reports it.

The backup file is encrypted and can be restored on any machine; your brain's git origin (a private repository) holds the history too. With `push_origin: true` in `rules/backup.yaml`, the hub also pushes main to origin every hour, unencrypted (plain git: everything in the brain, private notes included, so origin must stay a private repository you control) (and a few minutes after it starts when the last push is over an hour old, so a hub restarted more often than hourly still pushes), in a child process it stops after 5 minutes, never with `--force`: an origin that moved on fails the push and is left as it is. It never asks for a password (set up the Mac's git credentials first: `git push origin main` in the brain folder must work without a prompt). The result is in `log/origin-push.json`; two failures in a row are the probe's `origin` alert, and the next good push clears it. The error it keeps never holds the remote's address.

### A synced folder, kept off the hub (Mac)

Keep `dest` in `rules/backup.yaml` on a local folder (`~/pocketbrain-backups`, a real folder, not a link into Drive): on 2026-10-20 a read on a Drive-synced backup path froze the hub for two days. To still have every backup in the synced folder, turn on the offsite copy once:

```sh
pocketbrain backup offsite on ~/Library/CloudStorage/<your drive>/pocketbrain-backups
pocketbrain backup offsite off      # stop it; backups stay in the local folder
```

`on` installs its own launchd job, `com.pocketbrain.offsite`, beside the hub's (it never touches `com.pocketbrain.start`). Every hour it copies each finished backup the synced folder doesn't have yet (under a partial name, renamed once whole). The listing and every copy run in child processes under one 10-minute limit, so a synced folder that hangs stalls only that copy. Each run leaves its outcome in `log/offsite.json`; a failed run, or no copy for 48 hours, is the probe's `offsite` alert. Turning it on again with another folder replaces the job.

`pocketbrain doctor` warns when there is no `rules/backup.yaml`, when the last backup is more than 3 days old while main moved, or when the last file has gone from the folder, and it FAILs if `rules/backup.pub` holds a private key.

## Restore on a new machine

1. Install Bun, git, age and the pocketBrain tool. Let the storage service sync `pocketbrain-backups/`.
2. Restore the newest file into an empty folder, with the key piped from 1Password:

   ```sh
   op read "op://Private/pocketBrain backup key/password" | \
     pocketbrain restore ~/pocketbrain-backups/brain-2026-10-09.tar.age --to ~/pocketbrain-brain --identity - --key ~/.ssh/pocketbrain-home
   ```

   It decrypts, checks every hash in the manifest (a changed file, or a link anywhere in the backup or its history, stops the restore before anything is written), rebuilds the repo with every ref, puts the untracked state back, names the machine as it was, sets up signing with `--key`, verifies signed history, rebuilds every agent's view and runs doctor. Exit 0 means doctor found nothing to fix. If a step fails part-way (a mistyped `--key`, say), what it wrote is removed, so the same command can be run again into the same folder.
3. Re-issue agent tokens if the old machine's were lost (`pocketbrain token --agent <name>`; an agent wider than trial needs `--code` from its dashboard page, see [add-an-agent.md](add-an-agent.md)), start `pocketbrain serve`, and point the tunnel at the new machine.

With the paper copy instead of 1Password: type the key line into `--identity -` and press Ctrl-D.

## When something goes wrong

| Situation | Do this |
|---|---|
| 1Password account lost | Use the paper copy, then make a new key (setup step 1) and run a drill |
| Key exposed | New key pair (setup step 1), commit the new `rules/backup.pub`, make a backup and a drill, then delete every older backup file: they open with the exposed key |
| `can't decrypt` | Wrong 1Password item, or `rules/backup.pub` changed since that file was made; try the previous key |
| `doesn't match its hash` | The file was altered after it was made. Use an older one and find out who can write to the folder |
| `holds a private key` / `plaintext secrets` | Rotate the secret first, then remove it (backup-recovery.md 4.5) |
