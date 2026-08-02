import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const DEFAULT_OPENCODE_MODEL = "opencode/deepseek-v4-flash-free";
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
  part?: { text?: unknown };
}

function isOpenCodeEvent(value: unknown): value is OpenCodeEvent {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function permissions() {
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
    webfetch: "deny",
    websearch: "deny",
    lsp: "deny",
    skill: "deny",
    question: "deny",
    doom_loop: "deny",
  };
}

function childEnvironment(workDir: string): NodeJS.ProcessEnv {
  const names = ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM"];
  const environment: NodeJS.ProcessEnv = { PWD: workDir };
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function parseEvents(stdout: string): { text: string } {
  const events: OpenCodeEvent[] = [];
  for (const line of stdout.split("\n")) {
    const start = line.indexOf("{");
    if (start < 0) continue;
    try {
      const event: unknown = JSON.parse(line.slice(start));
      if (isOpenCodeEvent(event)) events.push(event);
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
  return { text };
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: childEnvironment(cwd),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 500).unref();
        reject(new Error(`OpenCode timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);
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

async function withPermit<T>(work: () => Promise<T>): Promise<T> {
  if (activeCalls >= MAX_CONCURRENCY) await new Promise<void>((resolve) => waitingCalls.push(resolve));
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
}: {
  prompt: string;
  model: string;
  files: OpenCodeFile[];
  timeoutMs: number;
}): Promise<string> {
  const workDir = await mkdtemp(join(tmpdir(), "upwho-opencode-"));
  try {
    await writeFile(
      join(workDir, "opencode.json"),
      JSON.stringify({ $schema: "https://opencode.ai/config.json", share: "disabled", permission: permissions() }, null, 2)
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
      "--pure", "run", "--dir", workDir, "--model", model, "--format", "json", "--title", "upwho-identity", ...fileArgs, prompt,
    ];
    const command = process.platform === "darwin" ? "script" : "opencode";
    const args = process.platform === "darwin" ? ["-q", "/dev/null", "opencode", ...opencodeArgs] : opencodeArgs;
    return parseEvents(await runProcess(command, args, workDir, timeoutMs)).text;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function runOpenCode({
  prompt,
  model = process.env.OPENCODE_MODEL || DEFAULT_OPENCODE_MODEL,
  files = [],
  timeoutMs = Number.parseInt(process.env.OPENCODE_BUDGET_MS || String(DEFAULT_BUDGET_MS), 10),
  attemptTimeoutMs = Number.parseInt(process.env.OPENCODE_ATTEMPT_MS || String(DEFAULT_ATTEMPT_TIMEOUT_MS), 10),
  retries = 1,
}: {
  prompt: string;
  model?: string;
  files?: OpenCodeFile[];
  timeoutMs?: number;
  attemptTimeoutMs?: number;
  retries?: number;
}): Promise<string> {
  return withPermit(async () => {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries && Date.now() < deadline; attempt++) {
      const remaining = deadline - Date.now();
      const budget = Math.min(attemptTimeoutMs, remaining);
      if (budget < 3_000) break;
      try {
        return await runOpenCodeOnce({ prompt, model, files, timeoutMs: budget });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("OpenCode budget expired");
  });
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
