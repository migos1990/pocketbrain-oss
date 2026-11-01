#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# docs/ holds scrubbed copies of the design docs. The originals are written about a real life,
# so they are never copied here as they are. This check fails if any term from a private
# denylist (one term per line, kept outside this repo) appears in a tracked file.
# Usage: sh scripts/check-public.sh <denylist.txt>
set -e
LIST=${1:?give the path of the private denylist}
[ -r "$LIST" ] || { echo "can't read the denylist $LIST" >&2; exit 2; }
# One term per line, read without Windows line endings and blank lines (audit v10, G613: a CRLF
# list matched nothing, an empty one matched nothing, and both said clean).
TERMS=$(mktemp)
trap 'rm -f "$TERMS"' EXIT
# A term keeps its spaces: " abc " stands for the word alone, and trimming it would match inside words.
tr -d '\r' < "$LIST" | grep -v '^[[:space:]]*$' > "$TERMS" || true
[ -s "$TERMS" ] || { echo "the denylist $LIST holds no term: nothing would be checked" >&2; exit 2; }
cd "$(dirname "$0")/.."
if git ls-files -z | xargs -0 grep -niIFf "$TERMS"; then
  echo "personal terms found above: scrub them before publishing" >&2
  exit 1
fi
echo "clean: no denylisted term in tracked files"
