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
  { type: "tool", kind: "edit", name: "edit", summary: "/tmp/demo/a.txt", output: "oldString not found", status: "error", duration_ms: 10 },
  { type: "tool", kind: "search", name: "grep", summary: "TODO", status: "done", duration_ms: 5 },
  { type: "tool", kind: "search", name: "list", summary: "/tmp/demo", output: "a.txt\nb.txt", status: "done" },
  { type: "tool", kind: "web", name: "webfetch", summary: "https://example.com/docs", output: "Example Domain", status: "done", duration_ms: 600 },
  { type: "tool", kind: "web", name: "websearch", summary: "neutral topic", output: "three results", status: "done", duration_ms: 300 },
  { type: "tool", kind: "other", name: "task", summary: "Survey modules", output: "Survey finished", status: "done", duration_ms: 2000 },
  { type: "tool", kind: "message", name: "openbee_send_message", summary: "Progress: two files checked.", output: "sent", status: "done" },
  { type: "tool", kind: "edit", name: "write", summary: "/tmp/demo/c.txt", status: "running" },
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
