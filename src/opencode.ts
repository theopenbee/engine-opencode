import { execFile } from "node:child_process";
import { accessSync, constants, createReadStream, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { cliVersion, findCli, log, spawnCli } from "@theopenbee/engine-sdk";
import type { Engine, EngineRequest, ModelInfo, RunParams, RunResult, TokenUsage } from "@theopenbee/engine-sdk";

const MIN_MAJOR_VERSION = 2;
const SESSION_PREFIX = "ses_";
const SESSION_ID = /^[A-Za-z0-9_-]+$/;
const CHILD_SESSION_ID = /^ses_[A-Za-z0-9_-]+$/;
const MAX_SUBAGENT_DEPTH = 4;
const EXPORT_CONCURRENCY = 8;
const EXPORT_TIMEOUT_MS = 20_000;
const EXPORT_MAX_BUFFER = 512 * 1024 * 1024;
const USAGE_BUDGET_MS = 50_000;
const MODELS_TIMEOUT_MS = 20_000;
const MODELS_MAX_BUFFER = 64 * 1024 * 1024;
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

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
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
    if (isExecutable(fallback)) return fallback;
    throw err;
  }
}

export function majorVersion(version: string): number | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return undefined;
  if (match[0] === "0.0.0") return undefined;
  return Number(match[1]);
}

export function opencodeSessionId(sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error(`invalid session id ${JSON.stringify(sessionId)}`);
  return SESSION_PREFIX + sessionId;
}

export function modelArgs(model: string | undefined, extraArgs: string[]): string[] {
  if (typeof model !== "string" || model === "") return [];
  if (extraArgs.some((arg) => arg === "--model" || arg === "-m" || arg.startsWith("--model="))) {
    log.warn(`engine args already set a model, ignoring model ${JSON.stringify(model)}`);
    return [];
  }
  return ["--model", model];
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
    parsed = undefined;
  }
  if (!isObject(parsed)) {
    throw new Error("OPENCODE_CONFIG_CONTENT must be a plain JSON object, without comments or trailing commas, to add openbee's MCP server");
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

type TokenCounts = Omit<TokenUsage, "model">;

const COUNT_FIELDS = ["input_tokens", "output_tokens", "cache_creation_tokens", "cache_read_tokens"] as const;

function readTokens(tokens: unknown): TokenCounts | undefined {
  if (!isObject(tokens)) return undefined;
  const cache = isObject(tokens.cache) ? tokens.cache : {};
  return {
    input_tokens: numberOrZero(tokens.input),
    output_tokens: numberOrZero(tokens.output) + numberOrZero(tokens.reasoning),
    cache_creation_tokens: numberOrZero(cache.write),
    cache_read_tokens: numberOrZero(cache.read),
  };
}

function addUsage(byModel: Map<string, TokenUsage>, model: string, counts: TokenCounts): void {
  let total = byModel.get(model);
  if (!total) {
    total = { model, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 };
    byModel.set(model, total);
  }
  for (const field of COUNT_FIELDS) total[field] += counts[field];
}

export function sessionUsage(exported: unknown): TokenUsage[] {
  if (!isObject(exported) || !Array.isArray(exported.messages)) return [];
  const byModel = new Map<string, TokenUsage>();
  const counted: TokenCounts = { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 };
  for (const message of exported.messages) {
    if (!isObject(message) || message.type !== "assistant") continue;
    const tokens = readTokens(message.tokens);
    if (!tokens) continue;
    addUsage(byModel, modelName(message.model), tokens);
    for (const field of COUNT_FIELDS) counted[field] += tokens[field];
  }
  const info = isObject(exported.info) ? exported.info : {};
  const total = readTokens(info.tokens);
  if (total) {
    const rest = { ...total };
    for (const field of COUNT_FIELDS) rest[field] = Math.max(0, total[field] - counted[field]);
    if (COUNT_FIELDS.some((field) => rest[field] > 0)) addUsage(byModel, modelName(info.model), rest);
  }
  return [...byModel.values()];
}

export function childSessionIds(exported: unknown): string[] {
  if (!isObject(exported) || !Array.isArray(exported.messages)) return [];
  const own = isObject(exported.info) ? exported.info.id : undefined;
  const ids = new Set<string>();
  for (const message of exported.messages) {
    if (!isObject(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isObject(part) || part.type !== "tool" || !isObject(part.state) || !isObject(part.state.metadata)) continue;
      const id = part.state.metadata.sessionID;
      if (typeof id === "string" && id !== own && CHILD_SESSION_ID.test(id)) ids.add(id);
    }
  }
  return [...ids];
}

function exportSession(command: string, opencodeId: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve) => {
    execFile(
      command,
      ["session", "export", "--standalone", opencodeId],
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
            log.warn(`export opencode session ${opencodeId} failed: ${detail || errorMessage(err)}`);
          }
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(String(stdout)));
        } catch (parseErr) {
          log.warn(`export opencode session ${opencodeId} returned invalid JSON: ${errorMessage(parseErr)}`);
          resolve(undefined);
        }
      },
    );
  });
}

interface ExportJob {
  root: string;
  id: string;
  parent?: string;
}

export async function collectUsage(
  command: string,
  sessionIds: string[],
  options: { concurrency?: number; budgetMs?: number } = {},
): Promise<Record<string, TokenUsage[]>> {
  const ids = [...new Set(sessionIds)].filter((id) => typeof id === "string" && SESSION_ID.test(id));
  const deadline = Date.now() + (options.budgetMs ?? USAGE_BUDGET_MS);
  const concurrency = options.concurrency ?? EXPORT_CONCURRENCY;
  const found = new Map<string, Map<string, TokenUsage>>();
  const seen = new Set<string>();
  let skipped = 0;

  const exportAll = async (jobs: ExportJob[]): Promise<unknown[]> => {
    const results: unknown[] = new Array(jobs.length);
    let next = 0;
    const work = async () => {
      while (next < jobs.length) {
        const index = next++;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          skipped++;
          continue;
        }
        results[index] = await exportSession(command, jobs[index].id, Math.min(EXPORT_TIMEOUT_MS, remaining));
      }
    };
    const workers = Math.max(1, Math.min(concurrency, jobs.length));
    await Promise.all(Array.from({ length: workers }, work));
    return results;
  };

  let level: ExportJob[] = ids.map((id) => ({ root: id, id: opencodeSessionId(id) }));
  for (const job of level) seen.add(job.id);
  for (let depth = 0; depth <= MAX_SUBAGENT_DEPTH && level.length > 0; depth++) {
    const exported = await exportAll(level);
    const next: ExportJob[] = [];
    level.forEach((job, index) => {
      const data = exported[index];
      if (data === undefined) return;
      if (job.parent !== undefined && !(isObject(data) && isObject(data.info) && data.info.parentID === job.parent)) return;
      const byModel = found.get(job.root) ?? new Map<string, TokenUsage>();
      found.set(job.root, byModel);
      for (const usage of sessionUsage(data)) addUsage(byModel, usage.model, usage);
      for (const child of childSessionIds(data)) {
        if (seen.has(child)) continue;
        seen.add(child);
        next.push({ root: job.root, id: child, parent: job.id });
      }
    });
    level = next;
  }
  if (skipped > 0) log.warn(`usage ran out of time, ${skipped} sessions were not read`);
  return Object.fromEntries(ids.filter((id) => found.has(id)).map((id) => [id, [...(found.get(id)?.values() ?? [])]]));
}

export function parseModels(output: string): ModelInfo[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((id) => ({ id }));
}

function listModels(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      ["models", "--standalone"],
      {
        timeout: MODELS_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: MODELS_MAX_BUFFER,
        windowsHide: true,
        env: { ...process.env, ...BASE_ENV },
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve(String(stdout));
          return;
        }
        const { code, killed, signal } = err as { code?: unknown; killed?: boolean; signal?: NodeJS.Signals | null };
        if (typeof code === "number") reject(new Error(failureText(code, null, String(stderr))));
        else if (killed) reject(new Error(`opencode models timed out after ${MODELS_TIMEOUT_MS / 1000}s`));
        else if (code === null) reject(new Error(failureText(null, signal ?? null, String(stderr))));
        else reject(new Error(`opencode models failed: ${errorMessage(err)}`));
      },
    );
  });
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
    const extraArgs = params.extra_args ?? [];
    const args = buildArgs(params.session_id ?? "", [...modelArgs(params.model, extraArgs), ...extraArgs]);
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

  async models(req) {
    return parseModels(await listModels(findOpencode(req.config)));
  },
};
