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
# registry's pocketbrain once it is published) with bun add -g. POCKETBRAIN_BUN_URL and
# POCKETBRAIN_BUN_SHA256 override where Bun's zip comes from and the sum it must match (tests). POCKETBRAIN_RELEASE_KEY is the ssh public key
# ("ssh-ed25519 AAAA...") a release tag must be signed with; empty means no key, as today.
set -eu

# The release key this installer trusts. Empty until releases are signed (docs/release.md, "Signed releases").
PINNED_RELEASE_KEY=""
# The Bun release this installer installs when Bun is missing, each build by its pinned sha256 below.
BUN_VERSION="1.4.4"
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
say "  - Bun $BUN_VERSION, the runtime it uses, in $BUN_BIN, if it isn't there yet, checked against"
say "    the checksum this installer pins"
say "  - $WHERE"
say "  - the pocketbrain command, in $BUN_BIN"
say "Nothing else on this computer changes, nothing about you is sent anywhere, and nothing is started."
say ""
if ! command -v bun >/dev/null 2>&1 && [ ! -x "$BUN_BIN/bun" ]; then
  # One Bun release, by checksum: the zip from Bun's GitHub release is checked against the sum pinned
  # here before anything runs, so neither bun.sh nor a changed download chooses the code (audit v11
  # finding 6, audit v12: Bun's own installer was run as served).
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64|Darwin-aarch64) BUN_TARGET=darwin-aarch64 ;;
    Darwin-x86_64) BUN_TARGET=darwin-x64 ;;
    Linux-aarch64|Linux-arm64) BUN_TARGET=linux-aarch64 ;;
    Linux-x86_64) BUN_TARGET=linux-x64 ;;
    *) BUN_TARGET="$(uname -s)-$(uname -m)" ;;
  esac
  # Linux without glibc (Alpine's musl) and x64 processors without AVX2 take other builds.
  if [ "$(uname -s)" = Linux ] && ldd --version 2>&1 | grep -qi musl; then BUN_TARGET="$BUN_TARGET-musl"; fi
  if [ "$BUN_TARGET" = linux-x64 ] && [ -r /proc/cpuinfo ] && ! grep -q avx2 /proc/cpuinfo; then BUN_TARGET=linux-x64-baseline; fi
  if [ "$BUN_TARGET" = darwin-x64 ] && ! sysctl -n machdep.cpu.leaf7_features 2>/dev/null | grep -qi avx2; then BUN_TARGET=darwin-x64-baseline; fi
  case "$BUN_TARGET" in
    darwin-aarch64) BUN_SUM=c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510 ;;
    darwin-x64) BUN_SUM=50a3491f73abc2fe81673171a85762d3bc2cc1680ccecadd983de99adf77977e ;;
    darwin-x64-baseline) BUN_SUM=d4a155adfbfd09155eb3ba05c9e3a544f39297d7a68616d3c7759f67ab5c47dc ;;
    linux-aarch64) BUN_SUM=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e ;;
    linux-x64) BUN_SUM=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c ;;
    linux-x64-baseline) BUN_SUM=e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76 ;;
    *) BUN_SUM="" ;;
  esac
  BUN_SUM="${POCKETBRAIN_BUN_SHA256:-$BUN_SUM}"
  [ -n "$BUN_SUM" ] || fail "This installer pins no Bun build for $BUN_TARGET. Fix: install Bun yourself (https://bun.sh), then run bun --version, and if it answers, this installer again."
  BUN_ZIP="${POCKETBRAIN_BUN_URL:-https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION}/bun-$BUN_TARGET.zip"
  say "Installing Bun $BUN_VERSION, the runtime pocketBrain uses (https://bun.sh)..."
  command -v curl >/dev/null 2>&1 || fail "curl is missing. Fix: run sudo apt install curl, and run this installer again."
  command -v unzip >/dev/null 2>&1 || fail "unzip is missing. Fix: run sudo apt install unzip, and run this installer again."
  tmp="$(mktemp -d)"
  curl -fsSL "$BUN_ZIP" -o "$tmp/bun.zip" || { rm -rf "$tmp"; fail "Couldn't download Bun from $BUN_ZIP (no internet?). Fix: check your connection, then run curl -fsSLI $BUN_ZIP, to see why, and run this installer again."; }
  if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/bun.zip" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$tmp/bun.zip" | cut -d' ' -f1)"; fi
  [ "$got" = "$BUN_SUM" ] || { rm -rf "$tmp"; fail "Bun's download from $BUN_ZIP doesn't match the checksum this installer pins, so nothing was installed. Fix: install Bun yourself (https://bun.sh), then run bun --version, and if it answers, this installer again."; }
  { unzip -q -o "$tmp/bun.zip" -d "$tmp" && mkdir -p "$BUN_BIN" && mv -f "$tmp/bun-$BUN_TARGET/bun" "$BUN_BIN/bun" && chmod +x "$BUN_BIN/bun" && "$BUN_BIN/bun" --version >/dev/null 2>&1; } || { rm -rf "$tmp"; fail "Bun didn't install. Fix: run $BUN_BIN/bun --version, to see why, and run this installer again."; }
  rm -rf "$tmp"
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
  *) say "  put $BUN_BIN on your PATH, once: add this line to your shell's startup file (~/.zshrc on a Mac,"
     say "  ~/.bashrc on most Linux):  export PATH=\"$BUN_BIN:\$PATH\""
     say "  then open a new terminal window, and: pocketbrain init" ;;
esac
say ""
