import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const entry = join(root, "dist", "index.js");
const scratch = mkdtempSync(join(tmpdir(), "engine-opencode-e2e-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function findBun() {
  const probe = spawnSync("bun", ["-e", "console.log(process.execPath)"]);
  if (probe.status === 0) return probe.stdout.toString().trim();
  const runtime = join(homedir(), ".openbee", "runtime");
  if (!existsSync(runtime)) return null;
  for (const name of readdirSync(runtime)) {
    const candidate = join(runtime, name, "bun");
    if (name.startsWith("bun-") && existsSync(candidate)) return candidate;
  }
  return null;
}

const bun = findBun();
const runtimes = [
  { name: "node", command: process.execPath, skip: false },
  { name: "bun", command: bun, skip: bun ? false : "bun is not installed" },
];

const SESSION = "4d0ce91b-0856-44e2-b0d7-7765d824bba3";

const FAKE_OPENCODE = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const emit = (event) => fs.writeSync(1, JSON.stringify(event) + "\\n");
const fail = (text) => fs.writeSync(2, text);
if (args[0] === "--version") {
  fs.writeSync(1, (process.env.FAKE_OPENCODE_VERSION || "opencode v2.3.2") + "\\n");
  process.exit(0);
}
const stdin = args[0] === "run" ? fs.readFileSync(0, "utf8") : "";
if (process.env.FAKE_OPENCODE_RECORD) {
  fs.appendFileSync(
    process.env.FAKE_OPENCODE_RECORD,
    JSON.stringify({
      argv: args,
      cwd: process.cwd(),
      stdin,
      pid: process.pid,
      env: {
        OPENBEE_API_KEY: process.env.OPENBEE_API_KEY ?? null,
        OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT ?? null,
        OPENCODE_DISABLE_AUTOUPDATE: process.env.OPENCODE_DISABLE_AUTOUPDATE ?? null,
        NO_PROXY: process.env.NO_PROXY ?? null,
      },
    }) + "\\n",
  );
}
if (args[0] === "session" && args[1] === "export") {
  const id = args[args.length - 1];
  if (process.env.FAKE_OPENCODE_EXPORT_MODE === "garbage") {
    fs.writeSync(1, "not json");
    process.exit(0);
  }
  if (process.env.FAKE_OPENCODE_EXPORT_MODE === "crash") {
    fail("export exploded\\n");
    process.exit(2);
  }
  const file = path.join(process.env.FAKE_OPENCODE_SESSIONS || "/nonexistent", id + ".json");
  if (!fs.existsSync(file)) {
    fail("Session not found: " + id + "\\n");
    process.exit(1);
  }
  fs.writeSync(1, fs.readFileSync(file, "utf8"));
  process.exit(0);
}
const sessionAt = args.indexOf("--session");
const session = sessionAt >= 0 ? args[sessionAt + 1] : "ses_generated";
const text = (value) => emit({ type: "text", sessionID: session, part: { type: "text", text: value } });
const step = (type) => emit({ type, sessionID: session, part: { type: type.replace("_", "-") } });
const mode = process.env.FAKE_OPENCODE_MODE || "ok";
if (mode === "ok") {
  fail("a warning on stderr\\n");
  step("step_start");
  text("working on it");
  emit({ type: "tool_use", sessionID: session, part: { type: "tool", tool: "shell", state: { status: "completed", output: "a" } } });
  step("step_finish");
  step("step_start");
  text("final answer");
  step("step_finish");
} else if (mode === "no-text") {
  step("step_start");
  step("step_finish");
} else if (mode === "error-exit") {
  step("step_start");
  text("partial answer");
  emit({ type: "error", sessionID: session, error: { type: "provider.auth", message: "Authentication Fails" } });
  process.exit(1);
} else if (mode === "error-zero") {
  emit({ type: "error", sessionID: session, error: { type: "provider.no-route", message: "Model unavailable: x/y" } });
} else if (mode === "stderr-exit") {
  fail("USAGE\\n  opencode run\\n\\nERROR\\n  Unrecognized flag: --bogus\\n\\n");
  process.exit(1);
} else if (mode === "silent-exit") {
  process.exit(3);
} else if (mode === "signal") {
  step("step_start");
  process.kill(process.pid, "SIGKILL");
} else if (mode === "sleep") {
  step("step_start");
  setInterval(() => {}, 1000);
}
`;

const fakeOpencode = join(scratch, "bin", "opencode");
before(() => {
  mkdirSync(dirname(fakeOpencode), { recursive: true });
  writeFileSync(fakeOpencode, FAKE_OPENCODE);
  chmodSync(fakeOpencode, 0o755);
});

let counter = 0;
function freshDir(prefix) {
  const dir = join(scratch, `${prefix}-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function baseRequest(method, params, overrides = {}) {
  return {
    protocol_version: 1,
    method,
    openbee_version: "9.9.9",
    engine_id: "opencode",
    language: "en",
    config: { path: fakeOpencode },
    data_dir: freshDir("data"),
    state_dir: freshDir("state"),
    params,
    ...overrides,
  };
}

function pluginEnv(env) {
  const merged = { ...process.env, OPENBEE_API_KEY: "tok-secret", ...env };
  delete merged.OPENCODE_CONFIG_CONTENT;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

function runPlugin(runtime, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.command, [entry], { cwd: scratch, env: pluginEnv(env), stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input) + "\n");
  });
}

function response(res) {
  assert.equal(res.code, 0, res.stderr);
  const lines = res.stdout.split("\n").filter((l) => l !== "");
  assert.equal(lines.length, 1, `expected exactly one stdout line, got: ${res.stdout}`);
  return JSON.parse(lines[0]);
}

function runParams(overrides = {}) {
  return {
    role: "worker",
    work_dir: freshDir("work"),
    prompt: "hello",
    session_id: SESSION,
    resume: false,
    extra_args: [],
    log_path: join(freshDir("logs"), "exec.log"),
    ...overrides,
  };
}

function recordedCalls(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}

function recordedCall(path) {
  const calls = recordedCalls(path);
  assert.equal(calls.length, 1, `expected exactly one opencode call, got ${calls.length}`);
  return calls[0];
}

const FIXED = ["run", "--standalone", "--auto", "--format", "json"];
const MCP = { name: "openbee", url: "http://127.0.0.1:12350/mcp", api_key_env: "OPENBEE_API_KEY" };

async function waitFor(predicate, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeExport(dir, sessionId, messages) {
  writeFileSync(join(dir, `ses_${sessionId}.json`), JSON.stringify({ info: { id: `ses_${sessionId}` }, messages }));
}

const assistant = (providerID, id, input, output, read = 0, write = 0, reasoning = 0) => ({
  type: "assistant",
  model: { id, providerID },
  tokens: { input, output, reasoning, cache: { read, write } },
});

for (const runtime of runtimes) {
  const t = (name, fn, options = {}) => test(`[${runtime.name}] ${name}`, { skip: runtime.skip || options.skip }, fn);

  t("check returns the version and path", async () => {
    const res = response(await runPlugin(runtime, baseRequest("check", {})));
    assert.deepEqual(res, { result: { version: "opencode v2.3.2", path: fakeOpencode } });
  });

  t("check rejects opencode 1.x", async () => {
    const res = response(await runPlugin(runtime, baseRequest("check", {}), { FAKE_OPENCODE_VERSION: "1.0.150" }));
    assert.deepEqual(res, { error: { message: "opencode 2.0 or newer is required, found 1.0.150" } });
  });

  t("check fails when the configured path does not exist", async () => {
    const missing = join(scratch, "no-such-opencode");
    const res = response(await runPlugin(runtime, baseRequest("check", {}, { config: { path: missing } })));
    assert.deepEqual(res, { error: { message: `${missing} not found` } });
  });

  t("check fails with opencode not found on PATH", async () => {
    const res = response(
      await runPlugin(runtime, baseRequest("check", {}, { config: {} }), { PATH: freshDir("empty-path"), HOME: freshDir("home") }),
    );
    assert.deepEqual(res, { error: { message: "opencode not found on PATH" } });
  });

  t("check uses opencode from PATH when no path is configured", async () => {
    const res = response(await runPlugin(runtime, baseRequest("check", {}, { config: { path: "" } }), { PATH: dirname(fakeOpencode) }));
    assert.deepEqual(res, { result: { version: "opencode v2.3.2", path: fakeOpencode } });
  });

  t("run passes the prompt on stdin, the session and the extra args, and returns the last text", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    const req = baseRequest("run", runParams({ prompt: "do the thing", extra_args: ["-m", "deepseek/deepseek-flash"] }));
    const res = response(await runPlugin(runtime, req, { FAKE_OPENCODE_RECORD: record }));
    assert.deepEqual(res, { result: { text: "final answer" } });

    const call = recordedCall(record);
    assert.deepEqual(call.argv, [...FIXED, "--session", `ses_${SESSION}`, "-m", "deepseek/deepseek-flash"]);
    assert.equal(call.stdin, "do the thing");
    assert.equal(call.cwd, realpathSync(req.params.work_dir));
    assert.equal(call.env.OPENCODE_DISABLE_AUTOUPDATE, "1");
    assert.equal(call.env.OPENCODE_CONFIG_CONTENT, null);
  });

  t("run uses the same opencode session to resume", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    const req = baseRequest("run", runParams({ resume: true, prompt: "follow up" }));
    response(await runPlugin(runtime, req, { FAKE_OPENCODE_RECORD: record }));
    const call = recordedCall(record);
    assert.deepEqual(call.argv, [...FIXED, "--session", `ses_${SESSION}`]);
    assert.equal(call.stdin, "follow up");
  });

  t("run without a session id lets opencode create one", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    const res = response(await runPlugin(runtime, baseRequest("run", runParams({ session_id: "" })), { FAKE_OPENCODE_RECORD: record }));
    assert.deepEqual(res, { result: { text: "final answer" } });
    assert.deepEqual(recordedCall(record).argv, FIXED);
  });

  t("run rejects an unsafe session id without starting opencode", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    const res = response(await runPlugin(runtime, baseRequest("run", runParams({ session_id: "../escape" })), { FAKE_OPENCODE_RECORD: record }));
    assert.deepEqual(res, { error: { message: 'invalid session id "../escape"' } });
    assert.deepEqual(recordedCalls(record), []);
  });

  t("run adds the MCP server through OPENCODE_CONFIG_CONTENT and keeps the key out of the arguments", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    const req = baseRequest("run", runParams({ mcp: MCP }));
    response(await runPlugin(runtime, req, { FAKE_OPENCODE_RECORD: record }));
    const call = recordedCall(record);
    assert.deepEqual(call.argv, [...FIXED, "--session", `ses_${SESSION}`]);
    assert.deepEqual(JSON.parse(call.env.OPENCODE_CONFIG_CONTENT), {
      mcp: { servers: { openbee: { type: "remote", url: MCP.url, headers: { Authorization: "Bearer {env:OPENBEE_API_KEY}" } } } },
    });
    assert.equal(call.env.OPENBEE_API_KEY, "tok-secret");
    assert.ok(!JSON.stringify(call.argv).includes("tok-secret"));
    assert.ok(!call.env.OPENCODE_CONFIG_CONTENT.includes("tok-secret"));
  });

  t("run merges the MCP server into an inline config from the environment", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    const req = baseRequest("run", runParams({ mcp: MCP }));
    const existing = JSON.stringify({ model: "deepseek/deepseek-flash" });
    response(await runPlugin(runtime, req, { FAKE_OPENCODE_RECORD: record, OPENCODE_CONFIG_CONTENT: existing }));
    const config = JSON.parse(recordedCall(record).env.OPENCODE_CONFIG_CONTENT);
    assert.equal(config.model, "deepseek/deepseek-flash");
    assert.equal(config.mcp.servers.openbee.url, MCP.url);
  });

  t("run leaves an inline config alone when there is no MCP address", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    const existing = JSON.stringify({ model: "a/b" });
    response(await runPlugin(runtime, baseRequest("run", runParams()), { FAKE_OPENCODE_RECORD: record, OPENCODE_CONFIG_CONTENT: existing }));
    assert.equal(recordedCall(record).env.OPENCODE_CONFIG_CONTENT, existing);
  });

  t("run passes the environment through", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    response(await runPlugin(runtime, baseRequest("run", runParams()), { FAKE_OPENCODE_RECORD: record, NO_PROXY: "127.0.0.1,example.com" }));
    const call = recordedCall(record);
    assert.equal(call.env.OPENBEE_API_KEY, "tok-secret");
    assert.equal(call.env.NO_PROXY, "127.0.0.1,example.com");
  });

  t("run delivers a multi-megabyte unicode prompt on stdin unchanged", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    const prompt = `line one\n"quoted" 'single' \`tick\` $HOME \\n back\\slash\n${"emoji \u{1F41D} 你好 <tag> & more\n".repeat(150000)}end`;
    assert.ok(Buffer.byteLength(prompt) > 3 * 1024 * 1024);
    const res = response(await runPlugin(runtime, baseRequest("run", runParams({ prompt })), { FAKE_OPENCODE_RECORD: record }));
    assert.deepEqual(res, { result: { text: "final answer" } });
    const call = recordedCall(record);
    assert.equal(call.stdin, prompt);
    assert.ok(!call.argv.includes(prompt));
  });

  t("run writes the opencode output and stderr to the log", async () => {
    const req = baseRequest("run", runParams());
    response(await runPlugin(runtime, req));
    const log = readFileSync(req.params.log_path, "utf8");
    assert.ok(log.includes('"text":"final answer"'));
    assert.ok(log.includes('"tool":"shell"'));
    assert.ok(log.includes("a warning on stderr"));
  });

  t("run returns empty text and no error when opencode says nothing", async () => {
    const res = response(await runPlugin(runtime, baseRequest("run", runParams()), { FAKE_OPENCODE_MODE: "no-text" }));
    assert.deepEqual(res, { result: { text: "" } });
  });

  t("run reports the opencode error event when it exits non-zero", async () => {
    const res = response(await runPlugin(runtime, baseRequest("run", runParams()), { FAKE_OPENCODE_MODE: "error-exit" }));
    assert.deepEqual(res, { result: { text: "partial answer", error: "Authentication Fails" } });
  });

  t("run reports an error event even when opencode exits zero", async () => {
    const res = response(await runPlugin(runtime, baseRequest("run", runParams()), { FAKE_OPENCODE_MODE: "error-zero" }));
    assert.deepEqual(res, { result: { text: "", error: "Model unavailable: x/y" } });
  });

  t("run reports the exit code with the last non-empty stderr line", async () => {
    const res = response(await runPlugin(runtime, baseRequest("run", runParams()), { FAKE_OPENCODE_MODE: "stderr-exit" }));
    assert.deepEqual(res, { result: { text: "", error: "opencode exited with code 1: Unrecognized flag: --bogus" } });
  });

  t("run reports only the exit code when opencode exits non-zero silently", async () => {
    const res = response(await runPlugin(runtime, baseRequest("run", runParams()), { FAKE_OPENCODE_MODE: "silent-exit" }));
    assert.deepEqual(res, { result: { text: "", error: "opencode exited with code 3" } });
  });

  t(
    "run reports the signal when opencode is killed",
    async () => {
      const res = response(await runPlugin(runtime, baseRequest("run", runParams()), { FAKE_OPENCODE_MODE: "signal" }));
      assert.deepEqual(res, { result: { text: "", error: "opencode was terminated by signal SIGKILL" } });
    },
    { skip: process.platform === "win32" },
  );

  t("run fails when opencode cannot be found", async () => {
    const req = baseRequest("run", runParams(), { config: {} });
    const res = response(await runPlugin(runtime, req, { PATH: freshDir("empty-path"), HOME: freshDir("home") }));
    assert.deepEqual(res, { error: { message: "opencode not found on PATH" } });
  });

  t("run fails when the working directory does not exist", async () => {
    const req = baseRequest("run", runParams({ work_dir: join(scratch, "no-such-dir") }));
    const res = response(await runPlugin(runtime, req));
    assert.ok(res.error.message.startsWith("start opencode: "), res.error.message);
  });

  t(
    "stopping the plugin's process group kills opencode",
    async () => {
      const record = join(freshDir("rec"), "calls.jsonl");
      const req = baseRequest("run", runParams());
      const child = spawn(runtime.command, [entry], {
        cwd: scratch,
        env: pluginEnv({ FAKE_OPENCODE_RECORD: record, FAKE_OPENCODE_MODE: "sleep" }),
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(req) + "\n");
      const closed = new Promise((resolve) => child.on("close", resolve));
      await waitFor(() => recordedCalls(record).length === 1, "opencode to start");
      const pid = recordedCall(record).pid;
      assert.ok(isAlive(pid));
      process.kill(-child.pid, "SIGKILL");
      await closed;
      await waitFor(() => !isAlive(pid), "opencode to exit");
    },
    { skip: process.platform === "win32" },
  );

  t("usage exports each session and sums tokens per model, omitting unknown sessions", async () => {
    const sessions = freshDir("sessions");
    const record = join(freshDir("rec"), "calls.jsonl");
    writeExport(sessions, "sess-a", [
      { type: "user", text: "hi" },
      assistant("deepseek", "deepseek-flash", 100, 2, 0, 0, 26),
      assistant("deepseek", "deepseek-flash", 199, 3, 13952),
      assistant("opencode", "big-pickle", 7, 8, 0, 4),
    ]);
    writeExport(sessions, "sess-b", [{ type: "user", text: "hi" }]);
    const req = baseRequest("usage", { session_ids: ["sess-a", "sess-b", "sess-missing", "sess-a", "../bad"] });
    const raw = await runPlugin(runtime, req, { FAKE_OPENCODE_SESSIONS: sessions, FAKE_OPENCODE_RECORD: record });
    assert.deepEqual(response(raw), {
      result: {
        usage: {
          "sess-a": [
            { model: "deepseek/deepseek-flash", input_tokens: 299, output_tokens: 31, cache_creation_tokens: 0, cache_read_tokens: 13952 },
            { model: "opencode/big-pickle", input_tokens: 7, output_tokens: 8, cache_creation_tokens: 4, cache_read_tokens: 0 },
          ],
          "sess-b": [],
        },
      },
    });
    assert.doesNotMatch(raw.stderr, /\[warn\]/);
    const exports = recordedCalls(record).map((call) => call.argv);
    assert.equal(exports.length, 3);
    assert.deepEqual(exports.map((argv) => argv.slice(0, 3)), Array(3).fill(["session", "export", "--standalone"]));
    assert.deepEqual(exports.map((argv) => argv[3]).sort(), ["ses_sess-a", "ses_sess-b", "ses_sess-missing"]);
  });

  t("usage warns and skips a session whose export fails", async () => {
    const raw = await runPlugin(runtime, baseRequest("usage", { session_ids: ["sess-a"] }), { FAKE_OPENCODE_EXPORT_MODE: "crash" });
    assert.deepEqual(response(raw), { result: { usage: {} } });
    assert.match(raw.stderr, /\[warn\] export opencode session sess-a failed: export exploded/);
  });

  t("usage warns and skips a session whose export is not JSON", async () => {
    const raw = await runPlugin(runtime, baseRequest("usage", { session_ids: ["sess-a"] }), { FAKE_OPENCODE_EXPORT_MODE: "garbage" });
    assert.deepEqual(response(raw), { result: { usage: {} } });
    assert.match(raw.stderr, /\[warn\] export opencode session sess-a returned invalid JSON/);
  });

  t("usage with no sessions does not start opencode", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    const res = response(await runPlugin(runtime, baseRequest("usage", { session_ids: [] }), { FAKE_OPENCODE_RECORD: record }));
    assert.deepEqual(res, { result: { usage: {} } });
    assert.deepEqual(recordedCalls(record), []);
  });
}
