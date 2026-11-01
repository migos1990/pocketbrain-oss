# Connect Codex CLI

**You need:** the Codex CLI (`codex`), and your brain running (`pocketbrain start`).

_Config format checked against Codex's MCP documentation on 2026-11-01. The pocketBrain side is tested; the Codex side hasn't been run end to end here yet._

## The command

```sh
pocketbrain add codex --slices area:work,contacts-basic --door mcp --yes
```

It prints a key starting `pb_codex_` and an instruction block.

## Put it into Codex

Codex reads the key from an environment variable, so the key isn't written in its config. Keep it in a file of its own, readable only by you, and load that file from your shell's startup file (`~/.zshrc` on a Mac, `~/.bashrc` on Linux and WSL). Startup files often end up in a dotfiles repo; the key file never should.

```sh
(umask 077 && printf 'export POCKETBRAIN_KEY="%s"\n' "pb_codex_…" > ~/.pocketbrain-codex-key)
echo '[ -f ~/.pocketbrain-codex-key ] && . ~/.pocketbrain-codex-key' >> ~/.zshrc
```

Use `~/.bashrc` in the second line on Linux and WSL.

Open a new terminal window. Then add to `~/.codex/config.toml`:

```toml
[mcp_servers.pocketbrain]
url = "http://127.0.0.1:8787/mcp"
bearer_token_env_var = "POCKETBRAIN_KEY"
```

Paste the instruction block into `~/.codex/AGENTS.md`, which Codex reads in every folder.

## Check it worked

In Codex, `/mcp` lists `pocketbrain` and its tools. Ask: *"Use pocketbrain: what are my projects?"*

## Undo

Remove the `[mcp_servers.pocketbrain]` lines, the line in your startup file, `~/.pocketbrain-codex-key` and the block in `AGENTS.md`, then `pocketbrain token --revoke codex`.
