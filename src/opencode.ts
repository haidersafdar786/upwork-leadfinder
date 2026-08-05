import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { cancellationReason, checkpoint, currentCancellationSignal, rethrowCancellation } from "./cancellation.ts";

const execFileAsync = promisify(execFile);
export const DEFAULT_OPENCODE_MODEL = "opencode-go/deepseek-v4-flash";
const DEFAULT_ATTEMPT_TIMEOUT_MS = 60_000;
const DEFAULT_BUDGET_MS = 120_000;
const MAX_CONCURRENCY = Math.max(1, Number.parseInt(process.env.OPENCODE_CONCURRENCY || "8", 10) || 8);
let activeCalls = 0;
const waitingCalls: (() => void)[] = [];

export interface OpenCodeFile {
  bytes: Buffer;
  extension: string;
}

interface OpenCodeEvent {
  type?: string;
  error?: unknown;
  part?: { text?: unknown; tool?: unknown; callID?: unknown; state?: unknown };
}

export interface OpenCodeTool {
  tool: string;
  callID: string | null;
  state: {
    status: string | null;
    input: Record<string, unknown>;
    output: string;
  };
}

export interface OpenCodeRun {
  text: string;
  tools: OpenCodeTool[];
}

export class OpenCodeProviderStoppedError extends Error {
  readonly code = "OPENCODE_PROVIDER_STOPPED";

  constructor(model: string, attempts: number) {
    super(
      `Model ${model} returned nothing on ${attempts} consecutive attempts, so the run stopped instead of waiting out the remaining calls. Check the provider, lower OPENCODE_CONCURRENCY, or set OPENCODE_MODEL to a model that responds.`,
    );
    this.name = "OpenCodeProviderStoppedError";
  }
}

export function isOpenCodeProviderStopped(error: unknown): error is OpenCodeProviderStoppedError {
  return error instanceof OpenCodeProviderStoppedError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpenCodeEvent(value: unknown): value is OpenCodeEvent {
  return isRecord(value);
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function parseTool(part: unknown): OpenCodeTool | null {
  const object = recordValue(part);
  const state = recordValue(object?.state);
  const tool = textValue(object?.tool);
  if (!tool || !state) return null;
  return {
    tool,
    callID: textValue(object?.callID),
    state: {
      status: textValue(state.status),
      input: recordValue(state.input) || {},
      output: textValue(state.output) || "",
    },
  };
}

function permissions(web: boolean) {
  return {
    read: "deny",
    edit: "deny",
    glob: "deny",
    grep: "deny",
    list: "deny",
    bash: "deny",
    task: "deny",
    external_directory: "deny",
    todowrite: "deny",
    webfetch: web ? "allow" : "deny",
    websearch: web ? "allow" : "deny",
    lsp: "deny",
    skill: "deny",
    question: "deny",
    doom_loop: "deny",
  };
}

function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++;
      result += "\n";
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 1;
      result += " ";
      continue;
    }
    result += character;
  }
  return result.replace(/,(\s*[}\]])/g, "$1");
}

export function globalConfigPaths(): string[] {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const paths = [
    join(base, "opencode", "config.json"),
    join(base, "opencode", "opencode.json"),
    join(base, "opencode", "opencode.jsonc"),
    join(homedir(), ".opencode", "opencode.json"),
    join(homedir(), ".opencode", "opencode.jsonc"),
  ];
  const explicit = process.env.OPENCODE_CONFIG;
  return [...new Set(explicit ? [...paths, explicit] : paths)];
}

// Disable globally configured MCP servers for isolated OpenCode runs.
export function disabledMcpServers(configText: string): Record<string, unknown> {
  const disabled: Record<string, unknown> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(configText));
  } catch {
    return disabled;
  }
  const servers = isRecord(parsed) && isRecord(parsed.mcp) ? parsed.mcp : null;
  for (const [name, definition] of Object.entries(servers || {})) {
    disabled[name] = { ...(isRecord(definition) ? definition : {}), enabled: false };
  }
  return disabled;
}

let cachedDisabledServers: Record<string, unknown> | null = null;

function disabledGlobalMcpServers(): Record<string, unknown> {
  if (cachedDisabledServers) return cachedDisabledServers;
  const disabled: Record<string, unknown> = {};
  for (const path of globalConfigPaths()) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    Object.assign(disabled, disabledMcpServers(text));
  }
  cachedDisabledServers = disabled;
  return disabled;
}

function childEnvironment(workDir: string, web: boolean): NodeJS.ProcessEnv {
  const names = ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM"];
  const environment: NodeJS.ProcessEnv = { PWD: workDir };
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  if (web) environment.OPENCODE_ENABLE_EXA = "1";
  return environment;
}

function parseEvents(stdout: string): OpenCodeRun {
  const events: OpenCodeEvent[] = [];
  const tools: OpenCodeTool[] = [];
  for (const line of stdout.split("\n")) {
    const start = line.indexOf("{");
    if (start < 0) continue;
    try {
      const event: unknown = JSON.parse(line.slice(start));
      if (isOpenCodeEvent(event)) {
        events.push(event);
        if (event.type === "tool_use") {
          const tool = parseTool(event.part);
          if (tool) tools.push(tool);
        }
      }
    } catch {
      // Terminal wrappers can prefix an incomplete fragment; later event lines remain useful.
    }
  }
  const error = events.find((event) => event.type === "error");
  if (error) throw new Error(`OpenCode session error: ${JSON.stringify(error.error).slice(0, 500)}`);
  const text = events
    .filter((event) => event.type === "text" && typeof event.part?.text === "string")
    .map((event) => event.part?.text)
    .filter((text): text is string => typeof text === "string")
    .join("")
    .trim();
  if (!text) throw new Error("OpenCode returned no text");
  return { text, tools };
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, web: boolean, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    checkpoint(signal);
    const child = spawn(command, args, {
      cwd,
      env: childEnvironment(cwd, web),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const stop = () => {
      const pid = child.pid;
      if (pid && process.platform !== "win32") {
        try {
          process.kill(-pid, "SIGTERM");
          setTimeout(() => {
            try { process.kill(-pid, "SIGKILL"); } catch {}
          }, 500).unref();
          return;
        } catch {}
      }
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 500).unref();
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => {
      stop();
      reject(signal ? cancellationReason(signal) : new Error("Run cancelled"));
    });
    const timer = setTimeout(() => {
      finish(() => {
        stop();
        reject(Object.assign(new Error(`OpenCode timed out after ${timeoutMs}ms`), { partialOutput: stdout }));
      });
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code, signal) => {
      finish(() => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`opencode exited with ${signal || code}: ${(stderr || stdout).trim().slice(0, 500)}`));
      });
    });
  });
}

async function withPermit<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  checkpoint(signal);
  if (activeCalls >= MAX_CONCURRENCY) {
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal?.removeEventListener("abort", cancel);
        resolve();
      };
      const cancel = () => {
        const index = waitingCalls.indexOf(ready);
        if (index >= 0) waitingCalls.splice(index, 1);
        reject(signal ? cancellationReason(signal) : new Error("Run cancelled"));
      };
      waitingCalls.push(ready);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }
  checkpoint(signal);
  activeCalls++;
  try {
    return await work();
  } finally {
    activeCalls--;
    waitingCalls.shift()?.();
  }
}

async function runOpenCodeOnce({
  prompt,
  model,
  files,
  timeoutMs,
  web,
  signal,
}: {
  prompt: string;
  model: string;
  files: OpenCodeFile[];
  timeoutMs: number;
  web: boolean;
  signal?: AbortSignal;
}): Promise<OpenCodeRun> {
  checkpoint(signal);
  const workDir = await mkdtemp(join(tmpdir(), "upwho-opencode-"));
  try {
    const config: Record<string, unknown> = {
      $schema: "https://opencode.ai/config.json",
      share: "disabled",
      permission: permissions(web),
    };
    const disabledServers = disabledGlobalMcpServers();
    if (Object.keys(disabledServers).length) config.mcp = disabledServers;
    if (web) {
      config.agent = {
        "upwho-web-research": {
          mode: "primary",
          description: "Bounded public-web research for one isolated client",
          steps: 16,
        },
      };
    }
    await writeFile(
      join(workDir, "opencode.json"),
      JSON.stringify(config, null, 2)
    );
    const fileArgs: string[] = [];
    for (const [index, file] of files.entries()) {
      const name = `input-${index}.${file.extension || "bin"}`;
      await writeFile(join(workDir, name), file.bytes);
      fileArgs.push("--file", name);
    }
    await execFileAsync("git", ["-C", workDir, "init", "--quiet"]);
    await execFileAsync("git", ["-C", workDir, "-c", "user.name=OpenCode", "-c", "user.email=opencode@invalid", "add", "."]);
    await execFileAsync("git", [
      "-C", workDir, "-c", "user.name=OpenCode", "-c", "user.email=opencode@invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "isolated request",
    ]);
    const opencodeArgs = [
      "--pure", "run", "--dir", workDir, "--model", model, "--format", "json",
      "--title", web ? "upwho-web-research" : "upwho-identity",
      ...(web ? ["--agent", "upwho-web-research"] : []),
      ...fileArgs,
      prompt,
    ];
    const command = process.platform === "darwin" ? "script" : "opencode";
    const args = process.platform === "darwin" ? ["-q", "/dev/null", "opencode", ...opencodeArgs] : opencodeArgs;
    const run = parseEvents(await runProcess(command, args, workDir, timeoutMs, web, signal));
    const allowed = new Set(web ? ["websearch", "webfetch"] : []);
    for (const tool of run.tools) {
      if (!allowed.has(tool.tool)) throw new Error(`OpenCode used forbidden tool: ${tool.tool}`);
    }
    return run;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

interface OpenCodeOptions {
  prompt: string;
  model?: string;
  files?: OpenCodeFile[];
  timeoutMs?: number;
  attemptTimeoutMs?: number;
  retries?: number;
}

// A mute timeout is distinct from a slow response because no event was streamed.
export function isMuteTimeout(error: unknown): boolean {
  if (!(error instanceof Error) || !/OpenCode timed out after/.test(error.message)) return false;
  const output = isRecord(error) ? error.partialOutput : undefined;
  return typeof output === "string" && !/"type"\s*:/.test(output);
}

// Provider failures arrive in bursts, so scale the stopping threshold with in-flight calls.
export function defaultMuteTimeoutLimit(concurrency: number): number {
  return Math.max(3, Math.ceil(Math.max(1, concurrency) / 2));
}

const MUTE_TIMEOUT_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.OPENCODE_MUTE_TIMEOUT_LIMIT || "", 10) || defaultMuteTimeoutLimit(MAX_CONCURRENCY),
);
let muteTimeouts = 0;

export function resetOpenCodeProviderState(): void {
  muteTimeouts = 0;
}

// Any streamed response clears the mute streak.
function providerFailure(model: string): Error | null {
  if (muteTimeouts < MUTE_TIMEOUT_LIMIT) return null;
  return new OpenCodeProviderStoppedError(model, muteTimeouts);
}

function recordAttemptOutcome(error: unknown): void {
  if (isMuteTimeout(error)) muteTimeouts++;
  else muteTimeouts = 0;
}

export function muteStreakState(): { streak: number; stopping: boolean } {
  return { streak: muteTimeouts, stopping: Boolean(providerFailure("test-model")) };
}

export function recordAttemptForTest(error: unknown): void {
  recordAttemptOutcome(error);
}

export function clearMuteStreakForTest(): void {
  muteTimeouts = 0;
}

async function runOpenCodeBudget({
  prompt,
  model = process.env.OPENCODE_MODEL || DEFAULT_OPENCODE_MODEL,
  files = [],
  timeoutMs = Number.parseInt(process.env.OPENCODE_BUDGET_MS || String(DEFAULT_BUDGET_MS), 10),
  attemptTimeoutMs = Number.parseInt(process.env.OPENCODE_ATTEMPT_MS || String(DEFAULT_ATTEMPT_TIMEOUT_MS), 10),
  retries = 1,
  web,
}: OpenCodeOptions & { web: boolean }): Promise<OpenCodeRun> {
  const signal = currentCancellationSignal();
  const failedBefore = providerFailure(model);
  if (failedBefore) throw failedBefore;
  return withPermit(async () => {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries && Date.now() < deadline; attempt++) {
      const failed = providerFailure(model);
      if (failed) throw failed;
      const remaining = deadline - Date.now();
      const budget = Math.min(attemptTimeoutMs, remaining);
      if (budget < 3_000) break;
      try {
        const run = await runOpenCodeOnce({ prompt, model, files, timeoutMs: budget, web, signal });
        muteTimeouts = 0;
        return run;
      } catch (error) {
        rethrowCancellation(error, signal);
        recordAttemptOutcome(error);
        lastError = error;
        const failedNow = providerFailure(model);
        if (failedNow) throw failedNow;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("OpenCode budget expired");
  }, signal);
}

export async function runOpenCode(options: OpenCodeOptions): Promise<string> {
  return (await runOpenCodeBudget({ ...options, web: false })).text;
}

export async function runOpenCodeWeb(options: OpenCodeOptions): Promise<OpenCodeRun> {
  return runOpenCodeBudget({ ...options, web: true });
}

export async function transcribeImage(
  bytes: Buffer,
  mime: string,
  model = process.env.OPENCODE_OCR_MODEL || null
): Promise<string | null> {
  if (!model) return null;
  const extension = mime === "image/jpeg" ? "jpg" : mime.split("/")[1] || "bin";
  return await runOpenCode({
    prompt: "Transcribe all visible text in the attached document image verbatim. Return only the transcription.",
    model,
    files: [{ bytes, extension }],
  });
}
