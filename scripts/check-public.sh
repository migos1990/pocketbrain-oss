#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# docs/ holds scrubbed copies of the design docs. The originals are written about a real life,
# so they are never copied here as they are. This check fails if any term from a private
# denylist (one term per line, kept outside this repo) appears in a tracked file.
# Usage: sh scripts/check-public.sh <denylist.txt>
set -e
LIST=${1:?give the path of the private denylist}
cd "$(dirname "$0")/.."
if git ls-files -z | xargs -0 grep -niIFf "$LIST"; then
  echo "personal terms found above: scrub them before publishing" >&2
  exit 1
fi
echo "clean: no denylisted term in tracked files"
