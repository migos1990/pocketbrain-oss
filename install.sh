#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# pocketBrain installer: curl -fsSL <this file's address> | sh
# Installs Bun if it's missing, then the pocketbrain command from the newest release tag (v*)
# of the public source, cloned into ~/.pocketbrain/app. Nothing else on the machine changes, and
# nothing about you is sent anywhere. Run it again to update. To remove it: pocketbrain uninstall,
# then rm ~/.bun/bin/pocketbrain and the ~/.pocketbrain/app folder (docs/quickstart.md, Leaving)
#
# POCKETBRAIN_REPO overrides where the source is cloned from, POCKETBRAIN_HOME where it goes,
# and POCKETBRAIN_REF which tag or branch is installed (default: the newest v* tag).
# POCKETBRAIN_PACKAGE installs from a package instead (a version, a tarball, or the npm
# registry's pocketbrain once it is published) with bun add -g. POCKETBRAIN_BUN_INSTALLER
# overrides where the Bun installer comes from (tests).
set -eu

REPO="${POCKETBRAIN_REPO:-https://pocketbrain.dev/git}"
SRC="${POCKETBRAIN_HOME:-$HOME/.pocketbrain/app}"
PKG="${POCKETBRAIN_PACKAGE:-}"
ORIG_PATH="$PATH"
say() { printf '%s\n' "$*"; }
fail() { printf 'pocketBrain install: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) fail "pocketBrain installs on macOS and Linux only. Fix: run wsl --install, and run this installer again inside WSL." ;;
esac

if ! command -v git >/dev/null 2>&1; then
  if [ "$(uname -s)" = Darwin ]; then
    fail "git is missing. Fix: run xcode-select --install, and run this installer again."
  fi
  fail "git is missing. Fix: run sudo apt install git, or your package manager's equivalent, and run this installer again."
fi

BUN_BIN="${BUN_INSTALL:-$HOME/.bun}/bin"
if ! command -v bun >/dev/null 2>&1 && [ ! -x "$BUN_BIN/bun" ]; then
  say "Installing Bun, the runtime pocketBrain uses (https://bun.sh)..."
  command -v curl >/dev/null 2>&1 || fail "curl is missing. Fix: run sudo apt install curl, and run this installer again."
  tmp="$(mktemp)"
  curl -fsSL "${POCKETBRAIN_BUN_INSTALLER:-https://bun.sh/install}" -o "$tmp" || { rm -f "$tmp"; fail "Couldn't download Bun (no internet?). Fix: check your connection, then run curl -fsSL https://bun.sh/install | bash, and run this installer again."; }
  bash "$tmp" >/dev/null || { rm -f "$tmp"; fail "Bun didn't install. Fix: run curl -fsSL https://bun.sh/install | bash, to see why, and run this installer again."; }
  rm -f "$tmp"
fi
PATH="$BUN_BIN:$PATH"; export PATH
command -v bun >/dev/null 2>&1 || fail "Bun installed but isn't on the PATH. Fix: open a new terminal window, then run bun --version, and if it answers, this installer again."

say "Installing pocketbrain..."
if [ -n "$PKG" ]; then
  bun add -g "$PKG" >/dev/null 2>&1 || bun add -g "$PKG" || fail "Couldn't install $PKG (no internet, or no such package). Fix: run bun add -g $PKG, to see why."
  pocketbrain help >/dev/null 2>&1 || fail "pocketbrain installed but doesn't run. Fix: run bun add -g $PKG, to reinstall it."
else
  if [ -d "$SRC/.git" ]; then
    # Only edits to tracked files count: bun install's lockfile rewrite is the installer's own.
    [ -z "$(git -C "$SRC" status --porcelain --untracked-files=no -- . ':!bun.lock' ':!bun.lockb')" ] || fail "$SRC has changes of yours, so it isn't updated. Fix: run git -C $SRC stash, and run this installer again."
  fi
  { if [ -d "$SRC/.git" ]; then git -C "$SRC" fetch -q --tags origin; else mkdir -p "$(dirname "$SRC")" && git clone -q "$REPO" "$SRC"; fi; } || fail "Couldn't fetch pocketBrain from $REPO (no internet?). Fix: check your connection, then run git ls-remote $REPO, to see why, and run this installer again."
  REF="${POCKETBRAIN_REF:-$(git -C "$SRC" tag -l 'v[0-9]*' --sort=-v:refname | head -n 1)}"
  [ -n "$REF" ] || fail "$REPO has no release yet (no v* tag). Fix: run export POCKETBRAIN_REF=main, and run the install line again, for the newest unreleased code."
  git -C "$SRC" checkout -q -f "origin/$REF" 2>/dev/null || git -C "$SRC" checkout -q -f "$REF" 2>/dev/null || fail "$REPO has no $REF. Fix: run git -C $SRC tag -l, to see the releases, and pass one as POCKETBRAIN_REF."
  (cd "$SRC" && bun install --production >/dev/null 2>&1) || (cd "$SRC" && bun install --production) || fail "Couldn't install pocketBrain's libraries (no internet?). Fix: run cd $SRC && bun install --production, to see why."
  mkdir -p "$BUN_BIN"
  ln -sf "$SRC/src/cli.ts" "$BUN_BIN/pocketbrain"
  pocketbrain help >/dev/null 2>&1 || fail "pocketbrain installed but doesn't run. Fix: run bun $SRC/src/cli.ts help, to see why."
  say "Installed $REF."
fi

say ""
say "pocketBrain is installed. Next, create your brain:"
say ""
case ":$ORIG_PATH:" in
  *":$BUN_BIN:"*) say "  pocketbrain init" ;;
  *) say "  open a new terminal window (so it finds the command), then: pocketbrain init" ;;
esac
say ""
