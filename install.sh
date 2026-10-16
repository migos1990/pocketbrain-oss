#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# pocketBrain installer: curl -fsSL <this file's address> | sh
# Installs Bun if it's missing, then the pocketbrain command. Nothing else on the machine
# changes, and nothing about you is sent anywhere. To remove it: bun remove -g pocketbrain
#
# POCKETBRAIN_PACKAGE overrides what is installed (a version, a tarball or a git URL);
# the default is the latest release from the npm registry. POCKETBRAIN_BUN_INSTALLER overrides
# where the Bun installer comes from (tests).
set -eu

PKG="${POCKETBRAIN_PACKAGE:-pocketbrain}"
ORIG_PATH="$PATH"
say() { printf '%s\n' "$*"; }
fail() { printf 'pocketBrain install: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) fail "this works on macOS and Linux. On Windows, run it inside WSL." ;;
esac

if ! command -v git >/dev/null 2>&1; then
  if [ "$(uname -s)" = Darwin ]; then
    fail "git is missing. Run: xcode-select --install   then run this installer again."
  fi
  fail "git is missing. Install it with your package manager (for example: sudo apt install git), then run this installer again."
fi

BUN_BIN="${BUN_INSTALL:-$HOME/.bun}/bin"
if ! command -v bun >/dev/null 2>&1 && [ ! -x "$BUN_BIN/bun" ]; then
  say "Installing Bun, the runtime pocketBrain uses (https://bun.sh)..."
  command -v curl >/dev/null 2>&1 || fail "curl is missing; install it, then run this installer again."
  tmp="$(mktemp)"
  curl -fsSL "${POCKETBRAIN_BUN_INSTALLER:-https://bun.sh/install}" -o "$tmp" || { rm -f "$tmp"; fail "couldn't download Bun (no internet?). See https://bun.sh for other ways."; }
  bash "$tmp" >/dev/null || { rm -f "$tmp"; fail "Bun didn't install. See https://bun.sh for other ways."; }
  rm -f "$tmp"
fi
PATH="$BUN_BIN:$PATH"; export PATH
command -v bun >/dev/null 2>&1 || fail "Bun installed but isn't on the PATH. Open a new terminal and run this installer again."

say "Installing pocketbrain..."
bun add -g "$PKG" >/dev/null 2>&1 || bun add -g "$PKG" || fail "couldn't install $PKG"
pocketbrain help >/dev/null 2>&1 || fail "pocketbrain installed but doesn't run; try: bun add -g $PKG"

say ""
say "pocketBrain is installed. Next, create your brain:"
say ""
case ":$ORIG_PATH:" in
  *":$BUN_BIN:"*) say "  pocketbrain init" ;;
  *) say "  open a new terminal window (so it finds the command), then: pocketbrain init" ;;
esac
say ""
