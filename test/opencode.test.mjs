import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildArgs,
  configContent,
  failureText,
  findOpencode,
  majorVersion,
  opencodeSessionId,
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

test("configContent replaces an existing inline config that is not a JSON object", () => {
  for (const existing of ["not json", "[1]", "  "]) {
    assert.deepEqual(Object.keys(JSON.parse(configContent(MCP, existing))), ["mcp"]);
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
});

test("sessionUsage sums assistant messages per model", () => {
  const exported = {
    info: { id: "ses_x", tokens: { input: 999 } },
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
  } finally {
    process.env.PATH = saved;
  }
});
