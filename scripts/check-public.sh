#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# docs/ holds scrubbed copies of the design docs. The originals are written about a real life,
# so they are never copied here as they are. This check fails if any term from a private
# denylist (one term per line, kept outside this repo) appears in a tracked file, except a term
# excused by name in the files its line lists.
# Usage: sh scripts/check-public.sh <denylist.txt> [folder]
# With a folder (scripts/public-export.sh passes its export), every file under it is checked instead.
set -e
LIST=${1:?give the path of the private denylist}
DIR=${2:-}
[ -r "$LIST" ] || { echo "can't read the denylist $LIST" >&2; exit 2; }
# One term per line, read without Windows line endings and blank lines (audit v10, G613: a CRLF
# list matched nothing, an empty one matched nothing, and both said clean).
TERMS=$(mktemp)
trap 'rm -f "$TERMS"' EXIT
# A term keeps its spaces: " abc " stands for the word alone, and trimming it would match inside words.
tr -d '\r' < "$LIST" | grep -v '^[[:space:]]*$' > "$TERMS" || true
[ -s "$TERMS" ] || { echo "the denylist $LIST holds no term: nothing would be checked" >&2; exit 2; }
if [ -n "$DIR" ]; then cd "$DIR"; else cd "$(dirname "$0")/.."; fi
# The files to check, one per line, as paths from here.
files() { if [ -n "$DIR" ]; then find . -type f | sed 's|^\./||'; else git ls-files; fi; }
# A line "<term> @<path>,<path>" excuses the term in those tracked files only (G936): the owner's
# surname belongs in CLA.md and nowhere else. Paths are whole paths with no spaces, never a part of
# one. A line with " @" whose path list holds a space (or ends in one) is refused, so it can never be
# read as a plain term that matches nothing.
PLAIN=$(mktemp); EXCUSE=$(mktemp); OUTF=$(mktemp)
trap 'rm -f "$TERMS" "$PLAIN" "$EXCUSE" "$OUTF"' EXIT
if grep ' @' "$TERMS" | grep -v ' @[^ ]*[^ ]$' | grep -q .; then
  echo "the denylist $LIST has an excuse line (\"<term> @<path>,<path>\") whose paths hold a space: fix it" >&2; exit 2
fi
grep -v ' @[^ ]*$' "$TERMS" > "$PLAIN" || true
# Found means grep printed something: xargs answers 123 when one of its batches finds nothing.
if [ -s "$PLAIN" ]; then files | tr '\n' '\0' | xargs -0 grep -niIFf "$PLAIN" >> "$OUTF" || true; fi
grep ' @[^ ]*$' "$TERMS" | while IFS= read -r line; do
  term=${line% @*}
  printf '%s\n' "${line##* @}" | tr ',' '\n' | grep -v '^$' > "$EXCUSE"
  files | grep -vxFf "$EXCUSE" | tr '\n' '\0' | xargs -0 grep -niIF -- "$term" >> "$OUTF" || true
done
cat "$OUTF"
FOUND=0; [ -s "$OUTF" ] && FOUND=1
if [ "$FOUND" = 1 ]; then
  echo "personal terms found above: scrub them before publishing" >&2
  exit 1
fi
echo "clean: no denylisted term in ${DIR:-tracked files}"
