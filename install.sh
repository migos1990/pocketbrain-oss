#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# pocketBrain installer: curl -fsSL <this file's address> | sh
# Says what it will do, installs Bun if it's missing, then the pocketbrain command from the newest
# release tag (v*) of the public source, cloned into ~/.pocketbrain/app; with no release it installs nothing
# unless POCKETBRAIN_REF names a branch. With a release key pinned below, a tag it didn't sign is refused.
# Libraries come from the release's own lockfile (--frozen-lockfile). Nothing else on the machine changes, and
# nothing about you is sent anywhere. Run it again to update. To remove it: pocketbrain uninstall,
# then rm ~/.bun/bin/pocketbrain and the ~/.pocketbrain/app folder (docs/quickstart.md, Leaving)
#
# POCKETBRAIN_REPO overrides where the source is cloned from, POCKETBRAIN_HOME where it goes,
# and POCKETBRAIN_REF which tag or branch is installed (default: the newest v* tag).
# POCKETBRAIN_PACKAGE installs from a package instead (a version, a tarball, or the npm
# registry's pocketbrain once it is published) with bun add -g. POCKETBRAIN_BUN_INSTALLER
# overrides where the Bun installer comes from (tests). POCKETBRAIN_RELEASE_KEY is the ssh public key
# ("ssh-ed25519 AAAA...") a release tag must be signed with; empty means no key, as today.
set -eu

# The release key this installer trusts. Empty until releases are signed (docs/release.md, "Signed releases").
PINNED_RELEASE_KEY=""
RELEASE_KEY="${POCKETBRAIN_RELEASE_KEY-$PINNED_RELEASE_KEY}"

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
if [ -n "$PKG" ]; then WHERE="the $PKG package, with bun add -g"; else WHERE="its code in $SRC (from $REPO)"; fi
say "This installs pocketBrain for you alone, on this computer:"
say "  - Bun, the runtime it uses, in $BUN_BIN, if it isn't there yet (Bun's own installer also adds"
say "    that folder to your shell's startup file)"
say "  - $WHERE"
say "  - the pocketbrain command, in $BUN_BIN"
say "Nothing else on this computer changes, nothing about you is sent anywhere, and nothing is started."
say ""
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
  # No release tag: nothing is installed unless the owner names a branch, since whoever can push the
  # default branch would otherwise choose the code.
  [ -n "$REF" ] || fail "$REPO has no release yet, so nothing is installed. Fix: run git ls-remote --tags $REPO, to see when there is one, or pass POCKETBRAIN_REF=main to install the unreleased code."
  if git -C "$SRC" rev-parse -q --verify "refs/tags/$REF" >/dev/null; then
    # A tag, never a branch of the same name. With a release key pinned, only a tag it signed.
    if [ -n "$RELEASE_KEY" ]; then
      command -v ssh-keygen >/dev/null 2>&1 || fail "ssh-keygen is missing, so the release's signature can't be checked. Fix: run sudo apt install openssh-client, and run this installer again."
      signers="$(mktemp)"
      printf 'pocketbrain-release namespaces="git" %s\n' "$RELEASE_KEY" > "$signers"
      if git -C "$SRC" -c gpg.format=ssh -c gpg.ssh.program=ssh-keygen -c gpg.ssh.allowedSignersFile="$signers" verify-tag "$REF" >/dev/null 2>&1; then rm -f "$signers"; else rm -f "$signers"; fail "$REF isn't signed by pocketBrain's release key, so it isn't installed. Fix: run git -C $SRC tag -l, to see the releases, and pass a signed one as POCKETBRAIN_REF."; fi
      say "$REF is signed by pocketBrain's release key."
    else
      say "No release key is pinned in this installer, so it can't check $REF's signature; it installs $REF as $REPO serves it."
    fi
    AT="refs/tags/$REF^{commit}"
  elif git -C "$SRC" rev-parse -q --verify "refs/remotes/origin/$REF" >/dev/null; then
    AT="origin/$REF"
    say "$REF isn't a release, so nothing checks it: this installs the newest code on $REF as $REPO serves it."
  elif git -C "$SRC" rev-parse -q --verify "$REF^{commit}" >/dev/null; then
    AT="$REF"
    say "$REF isn't a release, so nothing checks it: this installs $REF as $REPO serves it."
  else
    AT=""
  fi
  { [ -n "$AT" ] && git -C "$SRC" checkout -q -f "$AT" 2>/dev/null; } || fail "$REPO has no $REF. Fix: run git -C $SRC tag -l, to see the releases, and pass one as POCKETBRAIN_REF."
  (cd "$SRC" && bun install --production --frozen-lockfile >/dev/null 2>&1) || (cd "$SRC" && bun install --production --frozen-lockfile) || fail "Couldn't install pocketBrain's libraries (no internet?). Fix: run cd $SRC && bun install --production --frozen-lockfile, to see why."
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
