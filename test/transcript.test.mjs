import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { engine, transcriptSteps } from "../dist/opencode.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "transcript", "opencode.jsonl");
const scratch = mkdtempSync(join(tmpdir(), "engine-opencode-transcript-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function writeLog(events) {
  const path = join(scratch, `exec-${++counter}.log`);
  writeFileSync(path, events.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n");
  return path;
}

const tool = (name, state, extra = {}) => ({ type: "tool_use", part: { type: "tool", tool: name, ...extra, state } });

const EXPECTED = [
  { type: "thinking", text: "Plan: list the files, then read one of them." },
  { type: "text", text: "Let me look around." },
  { type: "tool", kind: "command", name: "bash", summary: "ls -la", output: "a.txt\nb.txt", status: "done", duration_ms: 250 },
  { type: "tool", kind: "read", name: "read", summary: "/tmp/demo/a.txt", output: "hello", status: "done", duration_ms: 40 },
  { type: "tool", kind: "edit", name: "edit", summary: "/tmp/demo/a.txt", diff: "-x\n+y", output: "oldString not found", status: "error", duration_ms: 10 },
  {
    type: "tool",
    kind: "edit",
    name: "edit",
    summary: "/tmp/demo/b.txt",
    diff: "-alpha\n-beta\n+alpha\n+BETA\n+gamma",
    output: "Edit applied successfully.",
    status: "done",
    duration_ms: 50,
  },
  {
    type: "tool",
    kind: "edit",
    name: "write",
    summary: "/tmp/demo/new.txt",
    diff: "+first\n+second",
    output: "Wrote file successfully.",
    status: "done",
    duration_ms: 30,
  },
  { type: "tool", kind: "search", name: "grep", summary: "TODO", status: "done", duration_ms: 5 },
  { type: "tool", kind: "search", name: "list", summary: "/tmp/demo", output: "a.txt\nb.txt", status: "done" },
  { type: "tool", kind: "web", name: "webfetch", summary: "https://example.com/docs", output: "Example Domain", status: "done", duration_ms: 600 },
  { type: "tool", kind: "web", name: "websearch", summary: "neutral topic", output: "three results", status: "done", duration_ms: 300 },
  { type: "tool", kind: "other", name: "task", summary: "Survey modules", output: "Survey finished", status: "done", duration_ms: 2000 },
  { type: "tool", kind: "message", name: "openbee_send_message", summary: "Progress: two files checked.", output: "sent", status: "done" },
  { type: "tool", kind: "edit", name: "write", summary: "/tmp/demo/c.txt", diff: "+draft", status: "running" },
  {
    type: "tool",
    kind: "edit",
    name: "patch",
    diff: " const a = 1;\n-const b = 2;\n+const b = 3;\n const c = 4;",
    output: "Patch applied",
    status: "done",
    duration_ms: 100,
  },
  { type: "tool", kind: "edit", name: "patch", status: "running" },
  { type: "text", text: "First part of the summary.\n\nSecond part of the summary." },
  { type: "error", text: "Authentication Fails" },
  { type: "error", text: "provider.no-route" },
  { type: "error", text: "plain failure" },
];

test("transcriptSteps maps every kind of event in the fixture", () => {
  assert.deepEqual(transcriptSteps(fixture), EXPECTED);
});

test("the engine answers a transcript request from the log path", async () => {
  const steps = await engine.transcript({ params: { log_path: fixture } });
  assert.deepEqual(steps, EXPECTED);
});

test("transcriptSteps returns nothing for a missing log", () => {
  assert.deepEqual(transcriptSteps(join(scratch, "missing.log")), []);
});

test("an error event without details gets a generic message", () => {
  assert.deepEqual(transcriptSteps(writeLog([{ type: "error" }])), [{ type: "error", text: "opencode reported an error" }]);
});

test("a tool part without a name is skipped", () => {
  const path = writeLog([{ type: "tool_use", part: { type: "tool", state: { status: "completed", output: "x" } } }]);
  assert.deepEqual(transcriptSteps(path), []);
});

test("an unknown tool takes the first string of its input as the summary", () => {
  const path = writeLog([tool("lookup", { status: "completed", input: { limit: 3, query: "bees", extra: "more" }, output: "ok" })]);
  assert.deepEqual(transcriptSteps(path), [{ type: "tool", kind: "other", name: "lookup", summary: "bees", output: "ok", status: "done" }]);
});

test("tool names matching object prototype members are classified as other", () => {
  const names = ["constructor", "toString", "hasOwnProperty", "__proto__"];
  const path = writeLog(names.map((name) => tool(name, { status: "completed", input: { value: "x" }, output: "ok" })));
  assert.deepEqual(
    transcriptSteps(path),
    names.map((name) => ({ type: "tool", kind: "other", name, summary: "x", output: "ok", status: "done" })),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(transcriptSteps(path))), transcriptSteps(path));
});

test("send_message of any server prefix is a message with its content as the summary", () => {
  const path = writeLog([tool("bee_send_message", { status: "completed", input: { content: "hi there" }, output: "sent" })]);
  assert.deepEqual(transcriptSteps(path), [{ type: "tool", kind: "message", name: "bee_send_message", summary: "hi there", output: "sent", status: "done" }]);
});

test("tools without call ids stay separate", () => {
  const path = writeLog([
    tool("bash", { status: "completed", input: { command: "one" }, output: "1" }),
    tool("bash", { status: "completed", input: { command: "two" }, output: "2" }),
  ]);
  assert.deepEqual(
    transcriptSteps(path).map((step) => [step.summary, step.status, step.output]),
    [
      ["one", "done", "1"],
      ["two", "done", "2"],
    ],
  );
});

test("an error status without a message ends in error with no output", () => {
  const path = writeLog([tool("bash", { status: "error", input: { command: "false" } })]);
  assert.deepEqual(transcriptSteps(path), [{ type: "tool", kind: "command", name: "bash", summary: "false", status: "error" }]);
});

function diffOf(name, input) {
  const path = writeLog([tool(name, { status: "completed", input, output: "ok" })]);
  return transcriptSteps(path)[0].diff;
}

test("an edit diff lists removed lines before added lines", () => {
  assert.equal(diffOf("edit", { filePath: "/a", oldString: "one\ntwo", newString: "uno\ndos\ntres" }), "-one\n-two\n+uno\n+dos\n+tres");
  assert.equal(diffOf("edit", { filePath: "/a", oldString: "x", newString: "y", replaceAll: true }), "-x\n+y");
});

test("an edit diff skips an empty side and missing fields", () => {
  assert.equal(diffOf("edit", { filePath: "/a", oldString: "", newString: "added" }), "+added");
  assert.equal(diffOf("edit", { filePath: "/a", oldString: "gone", newString: "" }), "-gone");
  assert.equal(diffOf("edit", { filePath: "/a", oldString: "", newString: "" }), undefined);
  assert.equal(diffOf("edit", { filePath: "/a" }), undefined);
  assert.equal(diffOf("edit", { filePath: "/a", oldString: 1, newString: null }), undefined);
  assert.equal(diffOf("edit", "not an object"), undefined);
});

test("diff text drops one trailing newline and keeps inner blank lines", () => {
  assert.equal(diffOf("edit", { filePath: "/a", oldString: "a\n\nb\n", newString: "c\r\nd\r\n" }), "-a\n-\n-b\n+c\n+d");
  assert.equal(diffOf("write", { filePath: "/a", content: "x\n\n" }), "+x\n+");
});

test("a write diff adds every content line", () => {
  assert.equal(diffOf("write", { filePath: "/a", content: "one\ntwo" }), "+one\n+two");
  assert.equal(diffOf("write", { filePath: "/a", content: "" }), undefined);
  assert.equal(diffOf("write", { filePath: "/a", content: 5 }), undefined);
  assert.equal(diffOf("write", { filePath: "/a" }), undefined);
});

test("a patch diff keeps the hunk lines of every file and drops the headers", () => {
  const patchText = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1111111..2222222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,3 +1,3 @@ function head()",
    " keep",
    "-old",
    "+new",
    " tail",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -10,0 +11,2 @@",
    "+first",
    "+second",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  assert.equal(diffOf("patch", { patchText }), " keep\n-old\n+new\n tail\n+first\n+second");
});

test("a patch diff follows the hunk counts so content that looks like a header survives", () => {
  const patchText = ["--- a/q.sql", "+++ b/q.sql", "@@ -1,2 +1,2 @@", "--- note", " keep", "+++ added", ""].join("\n");
  assert.equal(diffOf("patch", { patchText }), "--- note\n keep\n+++ added");
});

test("a patch hunk without counts spans one line and an empty line is blank context", () => {
  assert.equal(diffOf("patch", { patchText: "@@ -3 +3 @@\n-a\n+b\n" }), "-a\n+b");
  assert.equal(diffOf("patch", { patchText: "@@ -1,3 +1,3 @@\n a\n\n b\n" }), " a\n \n b");
});

test("a patch cut short does not add a blank line for its final newline", () => {
  assert.equal(diffOf("patch", { patchText: "@@ -1,3 +1,3 @@\n a\n-b\n+c\n" }), " a\n-b\n+c");
});

test("a patch that is not a unified diff gets no diff", () => {
  assert.equal(diffOf("patch", { patchText: "*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n*** End Patch\n" }), undefined);
  assert.equal(diffOf("patch", { patchText: "just some text" }), undefined);
  assert.equal(diffOf("patch", { patchText: "" }), undefined);
  assert.equal(diffOf("patch", { patchText: 5 }), undefined);
  assert.equal(diffOf("patch", {}), undefined);
});

test("a patch diff is read from patch or diff when patchText is missing", () => {
  assert.equal(diffOf("patch", { patch: "@@ -1 +1 @@\n-a\n+b\n" }), "-a\n+b");
  assert.equal(diffOf("patch", { diff: "@@ -1 +1 @@\n-a\n+b\n" }), "-a\n+b");
});

test("only edit tools get a diff", () => {
  const input = { command: "x", filePath: "/a", oldString: "a", newString: "b", content: "c", patchText: "@@ -1 +1 @@\n-a\n+b\n" };
  assert.equal(diffOf("bash", input), undefined);
  assert.equal(diffOf("read", input), undefined);
  assert.equal(diffOf("mcp_edit", input), undefined);
});

test("a long diff is clipped like tool output", () => {
  const content = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
  const diff = diffOf("write", { filePath: "/a", content });
  assert.equal(diff.length, 4000);
  assert.ok(diff.includes("\n…\n"));
  assert.ok(diff.endsWith("+line 999"));
});
