// SPDX-License-Identifier: AGPL-3.0-only
// Finds the word lists in a source file: a line holding five or more quoted plain words, or a
// bracketed alternation of four or more plain words (a regex or a pattern string). Each is named
// by the last const, let or function declared at the start of a line above it, so a moved line
// keeps its name. Used by test/word-lists.test.ts.
const WORD = /^[\p{Ll}][\p{Ll}' -]{2,}$/u;

export function wordLists(src: string): Set<string> {
  const out = new Set<string>();
  let name = "(top)";
  for (const line of src.split("\n")) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    const d = line.match(/^(?:export )?(?:async )?(?:const|let|function)\s+([A-Za-z_$][\w$]*)/);
    if (d) name = d[1]!;
    const quoted = [...line.matchAll(/"([^"\\]*)"|'([^'\\]*)'/g)].map((m) => m[1] ?? m[2] ?? "").filter((w) => WORD.test(w));
    let found = quoted.length >= 5;
    for (const g of line.matchAll(/\((?:\?:)?([^()]*\|[^()]*)\)/g)) {
      const alts = g[1]!.split("|").map((a) => a.replace(/\\[bsdw]|[?+*\\.^$]|\[[^\]]*\]/g, "").trim()).filter((a) => WORD.test(a));
      if (alts.length >= 4) found = true;
    }
    if (found) out.add(name);
  }
  return out;
}
