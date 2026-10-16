// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importNotion, cleanText } from "../src/import/notion";
import { extractRefs } from "../src/sources";
import { loadBrain, type FactRecord } from "../src/brain";

// Synthetic rows in the shape the Notion MCP returns (rows mode). No real data.
function rawBrain(): string {
  const root = mkdtempSync(join(tmpdir(), "pb-import-"));
  const put = (db: string, rows: object[], bodies: Record<string, string> = {}) => {
    mkdirSync(join(root, "import/raw", db, "bodies"), { recursive: true });
    writeFileSync(join(root, "import/raw", db, "rows.json"), JSON.stringify(rows));
    for (const [id, b] of Object.entries(bodies)) writeFileSync(join(root, "import/raw", db, "bodies", id + ".md"), b);
  };
  put("projects", [{
    Name: "Northfield Course X", Entity: "Northfield", Status: "Active", "Next step": "Teach session 6 on Oct 11",
    "Source type": "an email", Source: "Gmail ref m1.ZjAwMDAwMDAwMDAwMDAwNQ (2026-09-28)",
    Verification: "Verified by source", Confidence: "Stated", Sensitive: "__NO__", "Author agent": "Vamprose",
    Fingerprint: "Vamprose \\| created \\| 2026-10-04<br>Instinct \\| modified \\| 2026-10-06", "Fact key": "project:northfield-course-x",
    "date:Date:start": "2026-10-04", url: "https://app.notion.com/p/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
  }], { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1: "Mondays.\nVamprose \\| modified \\| 2026-10-06\n" });
  put("people", [{
    Name: "Ana Lopez", Role: "Coordinator", Org: "Acme (Acme Labs)", "Related project": "Northfield Course X",
    "Source type": "a text received from Louis", Source: "Instinct memory note entities/people/ana",
    Verification: "Confirmed by Louis", Confidence: "Stated", Sensitive: "__NO__", "Author agent": "Instinct",
    Fingerprint: "Instinct \\| created \\| 2026-10-04", "date:Date:start": "2026-10-04", "date:Last contact:start": "2026-09-30",
    url: "https://app.notion.com/p/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2",
  }], { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2: "Vamprose sources:\n- Role Coordinator at Acme: an email, Gmail f000000000000001 (2026-09-18).\n" });
  put("money", [{
    Name: "2026-09-29 Savings", Type: "Account", Amount: "1000", Currency: "CAD", "Source type": "a text received from Louis",
    Source: "Louis's messages 2026-09-29", Verification: "Unverified", Confidence: "Stated", Sensitive: "__YES__", "Author agent": "Instinct",
    Fingerprint: "Instinct \\| created \\| 2026-10-04", "date:Date:start": "2026-09-29", url: "https://app.notion.com/p/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3",
  }], { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3: "Account number 12345678 at the branch.\n" });
  mkdirSync(join(root, "rules"), { recursive: true });
  writeFileSync(join(root, "rules/import.yaml"), "areas: { Northfield: work }\narea_hints: { work: ['\\bNorthfield\\b'] }\n");
  return root;
}

function snapshot(root: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(join(root, d), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, f.name);
      if (f.isDirectory()) walk(p); else out.push(p + "\n" + readFileSync(join(root, p), "utf8"));
    }
  };
  for (const d of ["projects", "people", "orgs", "money"]) walk(d);
  return out.join("\n");
}

test("import maps rows to the memory-shape format", () => {
  const root = rawBrain();
  const r = importNotion(root);
  expect(r.rows).toBe(3);
  const notes = loadBrain(root);
  const proj = notes.find((n) => n.fm.id === "projects/northfield-course-x")!;
  expect(proj.fm.area).toBe("work");
  expect(proj.fm.created).toBe("2026-10-04");
  expect(proj.fm.updated).toBe("2026-10-06");
  expect(proj.fm.by).toBe("town"); // Vamprose alias
  expect((proj.fm.facts!.next_step as FactRecord).sources).toEqual(["gmail:f000000000000005"]); // m1. decoded
  expect(proj.body).not.toContain("modified"); // fingerprint lines stripped

  const ana = notes.find((n) => n.fm.id === "people/ana-lopez")!;
  expect(ana.fm.area).toBe("work"); // from its related project
  expect((ana.fm.facts!.org as FactRecord).value).toBe("[[orgs/acme]]");
  expect((ana.fm.facts!.role as FactRecord).sources).toEqual(["gmail:f000000000000001"]); // pass 2 upgrade
  expect(notes.find((n) => n.fm.id === "orgs/acme")?.fm.aliases).toEqual(["Acme Labs"]);

  const money = notes.find((n) => n.fm.id === "money/savings")!;
  expect(money.fm.sensitivity).toBe("private");
  expect(money.body).toContain("[removed: secret-shaped]");

  const report = readFileSync(r.report, "utf8");
  expect(report).toContain("Source type laundering");
  expect(report).toContain("3 of 3 rows (all)");
});

test("import is deterministic", () => {
  const root = rawBrain();
  importNotion(root);
  const a = snapshot(root);
  importNotion(root);
  expect(snapshot(root)).toBe(a);
});

test("Notion auto-links and lost newlines at line start are repaired", () => {
  const t = cleanText("Vamprose \\| modified \\| 2026-10-06\nn## Added by Vamprose (2026-10-08)n- Calendar ref [evt1.bG](http://evt1.bG)91aXMub");
  expect(t).toContain("\n## Added by Vamprose");
  expect(t).toContain("\n- Calendar ref evt1.bG91aXMub");
  expect(extractRefs(t)).toContain("gcal:evt1.bG91aXMub");
  expect(extractRefs(t).some((r) => r.startsWith("url:"))).toBe(false);
});
