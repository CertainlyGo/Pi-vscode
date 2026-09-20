import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUnifiedDiff } from "../media/src/components/DiffView";

test("parses a unified diff with counts and line numbers", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,3 +1,4 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    " export {};",
  ].join("\n");

  const parsed = parseUnifiedDiff(diff);
  assert.equal(parsed.additions, 2);
  assert.equal(parsed.deletions, 1);
  const added = parsed.rows.filter((row) => row.kind === "add");
  assert.equal(added[0]?.text, "const b = 3;");
  assert.equal(added[0]?.newLine, 2);
  const removed = parsed.rows.find((row) => row.kind === "del");
  assert.equal(removed?.oldLine, 2);
});

test("ignores content before the first hunk", () => {
  const parsed = parseUnifiedDiff("garbage\nmore garbage\n@@ -1 +1 @@\n-a\n+b");
  assert.equal(parsed.additions, 1);
  assert.equal(parsed.deletions, 1);
  assert.equal(parsed.rows.some((row) => row.text.includes("garbage")), false);
});

test("parses pi's display-oriented diff", () => {
  const diff = ["+  12 added line", "-  10 removed line", "   11 context line", "      ..."].join("\n");
  const parsed = parseUnifiedDiff(diff);
  assert.equal(parsed.additions, 1);
  assert.equal(parsed.deletions, 1);
  const added = parsed.rows.find((row) => row.kind === "add");
  assert.equal(added?.text, "added line");
  assert.equal(added?.newLine, 12);
  const removed = parsed.rows.find((row) => row.kind === "del");
  assert.equal(removed?.oldLine, 10);
  const context = parsed.rows.find((row) => row.kind === "ctx" && row.text === "context line");
  assert.equal(context?.oldLine, 11);
});
