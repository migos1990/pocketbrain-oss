#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Writes the public repo's files into an empty folder: the tracked files at HEAD, minus the paths
# in scripts/public-exclude.txt, then runs the denylist check on what is left. The public repo
# starts from fresh history, so run `git init` in that folder yourself after reading it.
# Usage: sh scripts/public-export.sh <empty folder> <private denylist>
set -e
OUT=${1:?give an empty folder to write the export into}
LIST=${2:?give the path of the private denylist}
LIST=$(cd "$(dirname "$LIST")" && pwd)/$(basename "$LIST")
cd "$(dirname "$0")/.."
mkdir -p "$OUT"
if [ -n "$(ls -A "$OUT")" ]; then echo "$OUT is not empty" >&2; exit 1; fi
git archive HEAD | tar -x -C "$OUT"
grep -v '^#' scripts/public-exclude.txt | grep . | while read -r p; do rm -rf "$OUT/$p"; done
# The same check as scripts/check-public.sh, excused terms included (G937), over the export.
sh scripts/check-public.sh "$LIST" "$(cd "$OUT" && pwd)" > "$OUT.check" 2>&1 || { cat "$OUT.check"; rm -f "$OUT.check"; exit 1; }
rm -f "$OUT.check"
echo "exported to $OUT: $(cd "$OUT" && find . -type f | wc -l | tr -d ' ') files, no denylisted term"
