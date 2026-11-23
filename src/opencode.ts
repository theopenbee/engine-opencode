import { execFile } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { cliVersion, findCli, log, spawnCli } from "@theopenbee/engine-sdk";
import type { Engine, EngineRequest, RunParams, RunResult, TokenUsage } from "@theopenbee/engine-sdk";

const MIN_MAJOR_VERSION = 2;
const SESSION_PREFIX = "ses_";
const SESSION_ID = /^[A-Za-z0-9_-]+$/;
const EXPORT_CONCURRENCY = 4;
const EXPORT_TIMEOUT_MS = 20_000;
const EXPORT_MAX_BUFFER = 512 * 1024 * 1024;
const USAGE_BUDGET_MS = 50_000;
const BASE_ENV = { OPENCODE_DISABLE_AUTOUPDATE: "1" };

type JsonObject = Record<string, unknown>;
type McpParams = NonNullable<RunParams["mcp"]>;

export interface LogScan {
  text: string;
  error: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line !== "") return line;
  }
  return "";
}

export function findOpencode(config: Record<string, unknown>, home: string = homedir()): string {
  try {
    return findCli(config, "opencode");
  } catch (err) {
    const configured = typeof config.path === "string" ? config.path.trim() : "";
    if (configured) throw err;
    const fallback = join(home, ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
    if (isFile(fallback)) return fallback;
    throw err;
  }
}

export function majorVersion(version: string): number | undefined {
  const match = /(\d+)\.\d+/.exec(version);
  return match ? Number(match[1]) : undefined;
}

export function opencodeSessionId(sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error(`invalid session id ${JSON.stringify(sessionId)}`);
  return SESSION_PREFIX + sessionId;
}

export function buildArgs(sessionId: string, extraArgs: string[]): string[] {
  const args = ["run", "--standalone", "--auto", "--format", "json"];
  if (sessionId !== "") args.push("--session", opencodeSessionId(sessionId));
  return [...args, ...extraArgs];
}

function parseConfigContent(existing: string | undefined): JsonObject {
  if (existing === undefined || existing.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    log.warn("OPENCODE_CONFIG_CONTENT is not valid JSON, it is replaced for this run");
    return {};
  }
  if (!isObject(parsed)) {
    log.warn("OPENCODE_CONFIG_CONTENT is not a JSON object, it is replaced for this run");
    return {};
  }
  return parsed;
}

export function configContent(mcp: McpParams | undefined, existing: string | undefined): string | undefined {
  if (!mcp?.url) return undefined;
  const config = parseConfigContent(existing);
  const section = isObject(config.mcp) ? config.mcp : {};
  const servers = isObject(section.servers) ? section.servers : {};
  const server = {
    type: "remote",
    url: mcp.url,
    headers: { Authorization: `Bearer {env:${mcp.api_key_env}}` },
  };
  return JSON.stringify({ ...config, mcp: { ...section, servers: { ...servers, [mcp.name]: server } } });
}

function eventErrorText(error: unknown): string {
  if (typeof error === "string" && error !== "") return error;
  if (isObject(error)) {
    const message = stringOrEmpty(error.message);
    if (message !== "") return message;
    const type = stringOrEmpty(error.type);
    if (type !== "") return type;
  }
  return "opencode reported an error";
}

export async function scanLog(logPath: string): Promise<LogScan> {
  const scan: LogScan = { text: "", error: "" };
  const stream = createReadStream(logPath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("{")) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObject(event)) continue;
      if (event.type === "text" && isObject(event.part)) {
        const text = stringOrEmpty(event.part.text);
        if (text !== "") {
          scan.text = text;
          scan.error = "";
        }
      } else if (event.type === "error") {
        scan.error = eventErrorText(event.error);
      }
    }
  } catch {
    return scan;
  } finally {
    lines.close();
    stream.destroy();
  }
  return scan;
}

export function failureText(code: number | null, signal: NodeJS.Signals | null, stderrTail: string): string {
  const base = code === null ? `opencode was terminated by signal ${signal ?? "unknown"}` : `opencode exited with code ${code}`;
  const detail = lastNonEmptyLine(stderrTail);
  return detail === "" ? base : `${base}: ${detail}`;
}

function modelName(model: unknown): string {
  if (!isObject(model)) return "";
  const id = stringOrEmpty(model.id);
  const provider = stringOrEmpty(model.providerID);
  return provider !== "" && id !== "" ? `${provider}/${id}` : id;
}

export function sessionUsage(exported: unknown): TokenUsage[] {
  if (!isObject(exported) || !Array.isArray(exported.messages)) return [];
  const byModel = new Map<string, TokenUsage>();
  for (const message of exported.messages) {
    if (!isObject(message) || message.type !== "assistant" || !isObject(message.tokens)) continue;
    const tokens = message.tokens;
    const cache = isObject(tokens.cache) ? tokens.cache : {};
    const model = modelName(message.model);
    let total = byModel.get(model);
    if (!total) {
      total = { model, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 };
      byModel.set(model, total);
    }
    total.input_tokens += numberOrZero(tokens.input);
    total.output_tokens += numberOrZero(tokens.output) + numberOrZero(tokens.reasoning);
    total.cache_creation_tokens += numberOrZero(cache.write);
    total.cache_read_tokens += numberOrZero(cache.read);
  }
  return [...byModel.values()];
}

function exportSession(command: string, sessionId: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve) => {
    execFile(
      command,
      ["session", "export", "--standalone", opencodeSessionId(sessionId)],
      {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: EXPORT_MAX_BUFFER,
        windowsHide: true,
        env: { ...process.env, ...BASE_ENV },
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = lastNonEmptyLine(String(stderr));
          if (!detail.startsWith("Session not found")) {
            log.warn(`export opencode session ${sessionId} failed: ${detail || errorMessage(err)}`);
          }
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(String(stdout)));
        } catch (parseErr) {
          log.warn(`export opencode session ${sessionId} returned invalid JSON: ${errorMessage(parseErr)}`);
          resolve(undefined);
        }
      },
    );
  });
}

export async function collectUsage(
  command: string,
  sessionIds: string[],
  options: { concurrency?: number; budgetMs?: number } = {},
): Promise<Record<string, TokenUsage[]>> {
  const ids = [...new Set(sessionIds)].filter((id) => typeof id === "string" && SESSION_ID.test(id));
  const deadline = Date.now() + (options.budgetMs ?? USAGE_BUDGET_MS);
  const found = new Map<string, TokenUsage[]>();
  let next = 0;
  let skipped = 0;
  const work = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        skipped++;
        continue;
      }
      const exported = await exportSession(command, id, Math.min(EXPORT_TIMEOUT_MS, remaining));
      if (exported !== undefined) found.set(id, sessionUsage(exported));
    }
  };
  const workers = Math.max(1, Math.min(options.concurrency ?? EXPORT_CONCURRENCY, ids.length));
  await Promise.all(Array.from({ length: workers }, work));
  if (skipped > 0) log.warn(`usage ran out of time, ${skipped} sessions were not read`);
  return Object.fromEntries(ids.filter((id) => found.has(id)).map((id) => [id, found.get(id) ?? []]));
}

export const engine: Engine = {
  async check(req) {
    const path = findOpencode(req.config);
    const version = await cliVersion(path);
    const major = majorVersion(version);
    if (major !== undefined && major < MIN_MAJOR_VERSION) {
      throw new Error(`opencode ${MIN_MAJOR_VERSION}.0 or newer is required, found ${version}`);
    }
    return { version, path };
  },

  async run(req: EngineRequest<RunParams>): Promise<RunResult> {
    const params = req.params;
    const command = findOpencode(req.config);
    const args = buildArgs(params.session_id ?? "", params.extra_args ?? []);
    const env: NodeJS.ProcessEnv = { ...BASE_ENV };
    const content = configContent(params.mcp, process.env.OPENCODE_CONFIG_CONTENT);
    if (content !== undefined) env.OPENCODE_CONFIG_CONTENT = content;

    let outcome;
    try {
      outcome = await spawnCli({
        command,
        args,
        cwd: params.work_dir,
        env,
        input: params.prompt,
        logPath: params.log_path,
      });
    } catch (err) {
      throw new Error(`start opencode: ${errorMessage(err)}`);
    }

    const scan = await scanLog(params.log_path);
    if (outcome.code !== 0) {
      return { text: scan.text, error: scan.error || failureText(outcome.code, outcome.signal, outcome.stderrTail) };
    }
    if (scan.error !== "") return { text: scan.text, error: scan.error };
    return { text: scan.text };
  },

  async usage(req) {
    return collectUsage(findOpencode(req.config), req.params.session_ids ?? []);
  },
};
