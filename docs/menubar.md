# The Mac menu-bar app

pocketBrain in the menu bar, for owners who never want a terminal open. One glance says whether
the hub is up and which day of the real-use bar you are on (`● day 6/14`); one click opens the
dashboard, pauses an agent or cuts it off.

## What it shows and does

| In the menu | What happens |
|---|---|
| `●` / `○` and `day N/14` | The hub answers on 127.0.0.1:8787 (or not), and the day count from `pocketbrain bar` |
| The bar's line | Last break, restore drill, last backup, open problems |
| Open dashboard | `pocketbrain menubar open-dashboard` hands the newest login link from the hub's log to the browser. The link never passes through the app or its output. Shown only while the hub answers |
| Install hub | Writes `~/Library/LaunchAgents/com.pocketbrain.start.plist` and loads it. Refuses when one is already there |
| Restart hub | `launchctl kickstart -k` of the running hub. It never unloads the hub and never touches the tunnel |
| Assistants, each with Read-only and Pause | The same kill switches as the dashboard: a commit to `rules/policy.yaml` by the owner. The menu only tightens a switch. To resume, use the dashboard (the menu opens it), because loosening a switch needs your login |
| Cut off… | Asks first, then revokes the agent's tokens and sign-in connections, like the dashboard's Revoke |

It refreshes every minute.

## First run

On a Mac with no brain yet, the menu says so and offers **Set up pocketBrain…**. The window asks
for your name, your first assistant's name (default `claude`), a folder (default `~/my-brain`) and,
if you like, a notes file or folder to start from. **Set up** makes the brain, installs the hub
under launchd and starts it, then shows the address, the token (once) and the standing instruction
to paste into the assistant, each with a Copy button. It never writes into a folder that isn't empty.

The window runs one command, which works the same in a terminal:

```
pocketbrain menubar setup --name "Your name" --agent claude --dir ~/my-brain --from-text notes.txt
```

It prints the result as JSON, remembers the brain like `pocketbrain init` does, and with
`--no-install` leaves launchd alone.

## What it guards against

Anything running as you can run the CLI, so the CLI gives nothing away to it. `menubar --json`
says only whether the dashboard can be opened, never the login link. `agent` only tightens: from
active to read-only to paused, or revoke. A paused agent that can run a shell can't free itself.
Resume stays behind the dashboard's login. The app takes no paths from settings, the environment
or the network, has no URL scheme, and listens on no port.

## How it is built

The app is a thin SwiftUI `MenuBarExtra` (`macos/PocketBrainBar/`). It runs
`pocketbrain menubar --json` and draws what comes back; every action is a CLI call too:

```
pocketbrain menubar                 the same view in a terminal
pocketbrain menubar --json          what the app reads
pocketbrain menubar install         the hub under launchd (add --tunnel <name> for the tunnel too)
pocketbrain menubar restart         restart the installed hub
pocketbrain menubar open-dashboard  the dashboard, signed in
pocketbrain agent pause <agent>     also read-only (from active) and revoke; never loosens a switch
```

So all the logic sits in `src/menubar.ts`, tested on any machine by `test/menubar.test.ts`,
which also checks that every field the Swift model decodes is one the CLI sends. The brain is the
one the installed hub serves (the `--brain` in its launchd file), so the app needs no settings on
a Mac where the hub already runs.

Why Swift and not Tauri or Electron: the menu bar is a native control on macOS, SwiftUI's
`MenuBarExtra` gives it in about a hundred lines with no dependencies, and the result is a small
signed binary. A web shell would add a second runtime and a bundler for a menu of a dozen items.
The cost is a Mac-only app, which matches the hub (launchd) it controls.

## Build and run on a Mac

Needs macOS 13 or later and the Xcode command-line tools (`xcode-select --install`). From the
app folder:

```
macos/PocketBrainBar/build.sh            # builds macos/PocketBrainBar/build/PocketBrain.app
macos/PocketBrainBar/build.sh --install  # also copies it to ~/Applications
open ~/Applications/PocketBrain.app
```

The app runs bun from `/opt/homebrew/bin` or `/usr/local/bin`, and the pocketBrain folder it was
built from (build.sh writes that path into the app). There is no setting to point it elsewhere:
another program could write a setting and have the app run its code. Both must be owned by you
or root and writable by no one else, or the menu says so. Moved the folder? Build again.

To start it at login, add it in System Settings, General, Login Items.

The build signs ad hoc, which is enough for a copy you built yourself. A copy others download
needs a Developer ID signature and notarization; that comes with the public launch.

## Not yet

- Importing a mail or calendar export from the first-run window (`pocketbrain init --from-mbox` does it from a terminal).
- Installing the tunnel from the menu (`pocketbrain menubar install --tunnel <name>` does it from a terminal).
- An alert in the menu bar when a probe check fails; the bar's line shows it at the next refresh.
