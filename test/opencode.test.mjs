import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildArgs,
  collectUsage,
  configContent,
  failureText,
  findOpencode,
  majorVersion,
  modelArgs,
  opencodeSessionId,
  parseModels,
  childSessionIds,
  scanLog,
  sessionUsage,
} from "../dist/opencode.js";

const scratch = mkdtempSync(join(tmpdir(), "engine-opencode-unit-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function freshDir(prefix) {
  const dir = join(scratch, `${prefix}-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeLog(events) {
  const path = join(freshDir("log"), "exec.log");
  writeFileSync(path, events.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n");
  return path;
}

const FIXED = ["run", "--standalone", "--auto", "--format", "json"];
const MCP = { name: "openbee", url: "http://127.0.0.1:12350/mcp", api_key_env: "OPENBEE_API_KEY" };
const text = (value) => ({ type: "text", part: { type: "text", text: value } });

test("opencodeSessionId prefixes the openbee session id", () => {
  assert.equal(opencodeSessionId("4d0ce91b-0856-44e2-b0d7-7765d824bba3"), "ses_4d0ce91b-0856-44e2-b0d7-7765d824bba3");
});

test("opencodeSessionId rejects ids with other characters", () => {
  for (const id of ["", "../x", "a b", "a/b", "a\nb"]) {
    assert.throws(() => opencodeSessionId(id), /invalid session id/);
  }
});

test("buildArgs without a session id lets opencode pick one", () => {
  assert.deepEqual(buildArgs("", []), FIXED);
});

test("buildArgs passes the session and then the extra args", () => {
  assert.deepEqual(buildArgs("abc-1", ["-m", "deepseek/deepseek-flash"]), [
    ...FIXED,
    "--session",
    "ses_abc-1",
    "-m",
    "deepseek/deepseek-flash",
  ]);
});

test("modelArgs passes a model as --model", () => {
  assert.deepEqual(modelArgs("deepseek/deepseek-flash", []), ["--model", "deepseek/deepseek-flash"]);
  assert.deepEqual(modelArgs("deepseek/deepseek-flash", ["--agent", "build"]), ["--model", "deepseek/deepseek-flash"]);
});

test("modelArgs is empty without a model", () => {
  assert.deepEqual(modelArgs(undefined, []), []);
  assert.deepEqual(modelArgs("", []), []);
});

test("modelArgs leaves the model to extra args that already set one", () => {
  assert.deepEqual(modelArgs("deepseek/deepseek-flash", ["--model", "opencode/big-pickle"]), []);
  assert.deepEqual(modelArgs("deepseek/deepseek-flash", ["--model=opencode/big-pickle"]), []);
  assert.deepEqual(modelArgs("deepseek/deepseek-flash", ["-m", "opencode/big-pickle"]), []);
});

test("parseModels reads one model per line and skips blank lines", () => {
  assert.deepEqual(parseModels("deepseek/deepseek-flash\r\n\n  opencode/big-pickle  \n\n"), [
    { id: "deepseek/deepseek-flash" },
    { id: "opencode/big-pickle" },
  ]);
});

test("parseModels returns an empty list for empty output", () => {
  assert.deepEqual(parseModels(""), []);
  assert.deepEqual(parseModels("\n  \n"), []);
});

test("configContent is empty without an MCP address", () => {
  assert.equal(configContent(undefined, undefined), undefined);
  assert.equal(configContent({ ...MCP, url: "" }, undefined), undefined);
});

test("configContent adds a remote MCP server that reads the key from the environment", () => {
  assert.deepEqual(JSON.parse(configContent(MCP, undefined)), {
    mcp: {
      servers: {
        openbee: {
          type: "remote",
          url: MCP.url,
          headers: { Authorization: "Bearer {env:OPENBEE_API_KEY}" },
        },
      },
    },
  });
});

test("configContent keeps the existing inline config", () => {
  const existing = JSON.stringify({ model: "a/b", mcp: { timeout: 5, servers: { other: { type: "local" } } } });
  assert.deepEqual(JSON.parse(configContent({ ...MCP, name: "bee", api_key_env: "BEE_TOKEN" }, existing)), {
    model: "a/b",
    mcp: {
      timeout: 5,
      servers: {
        other: { type: "local" },
        bee: { type: "remote", url: MCP.url, headers: { Authorization: "Bearer {env:BEE_TOKEN}" } },
      },
    },
  });
});

test("configContent treats a blank inline config as unset", () => {
  assert.deepEqual(Object.keys(JSON.parse(configContent(MCP, "  "))), ["mcp"]);
});

test("configContent refuses an inline config it cannot merge into", () => {
  for (const existing of ["not json", "[1]", '{"model": "a/b",}', '{\n  // note\n  "model": "a/b"\n}']) {
    assert.throws(() => configContent(MCP, existing), /OPENCODE_CONFIG_CONTENT must be a plain JSON object/);
  }
});

test("scanLog returns the last text part", async () => {
  const path = writeLog([
    { type: "step_start", part: { type: "step-start" } },
    text("working on it"),
    { type: "tool_use", part: { type: "tool", tool: "shell", state: { status: "completed" } } },
    "plain stderr line",
    "{not json",
    text(""),
    text("final answer"),
    { type: "step_finish", part: { type: "step-finish" } },
  ]);
  assert.deepEqual(await scanLog(path), { text: "final answer", error: "" });
});

test("scanLog reports an error event that no text follows", async () => {
  const path = writeLog([text("partial"), { type: "error", error: { type: "provider.auth", message: "Authentication Fails" } }]);
  assert.deepEqual(await scanLog(path), { text: "partial", error: "Authentication Fails" });
});

test("scanLog clears an error that later text recovers from", async () => {
  const path = writeLog([{ type: "error", error: { message: "rate limited" } }, text("done")]);
  assert.deepEqual(await scanLog(path), { text: "done", error: "" });
});

test("scanLog falls back to the error type or a generic message", async () => {
  assert.equal((await scanLog(writeLog([{ type: "error", error: { type: "provider.no-route" } }]))).error, "provider.no-route");
  assert.equal((await scanLog(writeLog([{ type: "error", error: "plain" }]))).error, "plain");
  assert.equal((await scanLog(writeLog([{ type: "error" }]))).error, "opencode reported an error");
});

test("scanLog returns nothing for a missing log", async () => {
  assert.deepEqual(await scanLog(join(scratch, "missing.log")), { text: "", error: "" });
});

test("failureText adds the last non-empty stderr line", () => {
  assert.equal(failureText(1, null, "help\n\nERROR\n  Unrecognized flag: --x\n\n"), "opencode exited with code 1: Unrecognized flag: --x");
  assert.equal(failureText(3, null, ""), "opencode exited with code 3");
  assert.equal(failureText(null, "SIGTERM", ""), "opencode was terminated by signal SIGTERM");
});

test("majorVersion reads the major version", () => {
  assert.equal(majorVersion("opencode v2.3.2"), 2);
  assert.equal(majorVersion("1.0.150"), 1);
  assert.equal(majorVersion("dev"), undefined);
  assert.equal(majorVersion("0.0.0-dev-202611220000"), undefined);
});

test("sessionUsage sums assistant messages per model", () => {
  const exported = {
    info: { id: "ses_x" },
    messages: [
      { type: "user", text: "hi" },
      {
        type: "assistant",
        model: { id: "deepseek-flash", providerID: "deepseek" },
        tokens: { input: 100, output: 2, reasoning: 26, cache: { read: 0, write: 5 } },
      },
      {
        type: "assistant",
        model: { id: "deepseek-flash", providerID: "deepseek" },
        tokens: { input: 199, output: 3, reasoning: 0, cache: { read: 13952, write: 0 } },
      },
      { type: "assistant", model: { id: "big-pickle", providerID: "opencode" }, tokens: { input: 7, output: 8 } },
      { type: "assistant", model: { id: "no-tokens", providerID: "x" } },
      { type: "idle", outcome: "succeeded" },
    ],
  };
  assert.deepEqual(sessionUsage(exported), [
    { model: "deepseek/deepseek-flash", input_tokens: 299, output_tokens: 31, cache_creation_tokens: 5, cache_read_tokens: 13952 },
    { model: "opencode/big-pickle", input_tokens: 7, output_tokens: 8, cache_creation_tokens: 0, cache_read_tokens: 0 },
  ]);
});

test("sessionUsage adds what the session total has beyond its messages to the session model", () => {
  const exported = {
    info: {
      id: "ses_x",
      model: { id: "deepseek-flash", providerID: "deepseek", variant: "default" },
      tokens: { input: 4977, output: 117, reasoning: 26, cache: { read: 13952, write: 0 } },
    },
    messages: [
      {
        type: "assistant",
        model: { id: "deepseek-flash", providerID: "deepseek" },
        tokens: { input: 4310, output: 86, reasoning: 26, cache: { read: 1664, write: 0 } },
      },
      { type: "assistant", model: { id: "big-pickle", providerID: "opencode" }, tokens: { input: 455, output: 24, cache: { read: 12032 } } },
    ],
  };
  assert.deepEqual(sessionUsage(exported), [
    { model: "deepseek/deepseek-flash", input_tokens: 4522, output_tokens: 119, cache_creation_tokens: 0, cache_read_tokens: 1920 },
    { model: "opencode/big-pickle", input_tokens: 455, output_tokens: 24, cache_creation_tokens: 0, cache_read_tokens: 12032 },
  ]);
});

test("sessionUsage adds nothing when the session total is not above its messages", () => {
  const exported = {
    info: { id: "ses_x", model: { id: "other", providerID: "x" }, tokens: { input: 10, output: 1, cache: { read: 0, write: 0 } } },
    messages: [{ type: "assistant", model: { id: "m", providerID: "p" }, tokens: { input: 12, output: 1 } }],
  };
  assert.deepEqual(sessionUsage(exported), [
    { model: "p/m", input_tokens: 12, output_tokens: 1, cache_creation_tokens: 0, cache_read_tokens: 0 },
  ]);
});

test("childSessionIds lists the sessions that tool calls started", () => {
  const tool = (sessionID) => ({ type: "tool", name: "subagent", state: { status: "completed", metadata: { sessionID } } });
  const exported = {
    info: { id: "ses_parent" },
    messages: [
      { type: "user", text: "hi" },
      { type: "assistant", content: [{ type: "text", text: "x" }, tool("ses_a"), tool("ses_b"), tool("ses_a")] },
      { type: "assistant", content: [tool("ses_parent"), tool("not-a-session"), tool("ses_../x"), { type: "tool", state: {} }] },
    ],
  };
  assert.deepEqual(childSessionIds(exported), ["ses_a", "ses_b"]);
  assert.deepEqual(childSessionIds(null), []);
});

test("sessionUsage ignores exports without messages", () => {
  assert.deepEqual(sessionUsage(null), []);
  assert.deepEqual(sessionUsage({ info: {} }), []);
});

test("findOpencode falls back to ~/.opencode/bin when opencode is not on PATH", () => {
  const home = freshDir("home");
  const bin = join(home, ".opencode", "bin");
  mkdirSync(bin, { recursive: true });
  const exe = join(bin, process.platform === "win32" ? "opencode.exe" : "opencode");
  writeFileSync(exe, "");
  chmodSync(exe, 0o755);
  const saved = process.env.PATH;
  process.env.PATH = freshDir("empty-path");
  try {
    assert.equal(findOpencode({}, home), exe);
    assert.throws(() => findOpencode({}, freshDir("other-home")), /opencode not found on PATH/);
    assert.throws(() => findOpencode({ path: join(home, "nope") }, home), /not found/);
    if (process.platform !== "win32") {
      chmodSync(exe, 0o644);
      assert.throws(() => findOpencode({}, home), /opencode not found on PATH/);
    }
  } finally {
    process.env.PATH = saved;
  }
});

function fakeExporter(body) {
  const path = join(freshDir("fake"), "opencode");
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

test("collectUsage reads nothing once the time budget is spent", async () => {
  const command = fakeExporter('process.stdout.write(JSON.stringify({ messages: [] }));');
  assert.deepEqual(await collectUsage(command, ["a", "b"], { budgetMs: 0 }), {});
});

test("collectUsage stops an export that outlives the time budget", { skip: process.platform === "win32" }, async () => {
  const command = fakeExporter("setTimeout(() => {}, 10000);");
  const started = Date.now();
  assert.deepEqual(await collectUsage(command, ["a"], { budgetMs: 500 }), {});
  assert.ok(Date.now() - started < 5000);
});

test("collectUsage adds the usage of subagent sessions to their root session", async () => {
  const tool = (sessionID) => ({ type: "tool", name: "subagent", state: { metadata: { sessionID } } });
  const usage = (input) => ({ type: "assistant", model: { id: "m", providerID: "p" }, tokens: { input, output: 0 } });
  const sessions = {
    ses_root: { info: { id: "ses_root" }, messages: [{ ...usage(100), content: [tool("ses_child"), tool("ses_stranger")] }] },
    ses_child: { info: { id: "ses_child", parentID: "ses_root" }, messages: [{ ...usage(10), content: [tool("ses_grandchild"), tool("ses_root")] }] },
    ses_grandchild: { info: { id: "ses_grandchild", parentID: "ses_child" }, messages: [usage(1)] },
    ses_stranger: { info: { id: "ses_stranger", parentID: "ses_elsewhere" }, messages: [usage(1000)] },
    ses_alone: { info: { id: "ses_alone" }, messages: [usage(5), { content: [tool("ses_missing")] }] },
  };
  const command = fakeExporter(
    `const sessions = ${JSON.stringify(sessions)};\n` +
      "const id = process.argv[process.argv.length - 1];\n" +
      'if (!sessions[id]) { process.stderr.write("Session not found: " + id + "\\n"); process.exit(1); }\n' +
      "process.stdout.write(JSON.stringify(sessions[id]));",
  );
  const counts = (input) => [{ model: "p/m", input_tokens: input, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 }];
  assert.deepEqual(await collectUsage(command, ["root", "alone", "gone"]), { root: counts(111), alone: counts(5) });
});

test("collectUsage exports sessions in parallel", { skip: process.platform === "win32" }, async () => {
  const command = fakeExporter('setTimeout(() => process.stdout.write(JSON.stringify({ messages: [] })), 400);');
  const ids = Array.from({ length: 8 }, (_, i) => `s${i}`);
  const started = Date.now();
  const usage = await collectUsage(command, ids);
  assert.deepEqual(Object.keys(usage), ids);
  assert.ok(Date.now() - started < 8 * 400, `took ${Date.now() - started}ms`);
});
