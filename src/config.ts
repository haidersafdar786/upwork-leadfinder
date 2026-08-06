import { z } from "zod";

export const DEFAULT_OPENCODE_MODEL = "opencode/deepseek-v4-flash-free";
const configCache = new WeakMap<object, UpwhoConfig>();

function optionalText(): z.ZodType<string | undefined> {
  return z.preprocess((value) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") return value;
    const text = value.trim();
    return text || undefined;
  }, z.string().min(1).optional());
}

function integer(defaultValue: number, minimum: number): z.ZodType<number> {
  return z.preprocess((value) => value === undefined || value === "" ? undefined : value, z.coerce.number().int().min(minimum).default(defaultValue));
}

function optionalInteger(minimum: number): z.ZodType<number | undefined> {
  return z.preprocess((value) => value === undefined || value === "" ? undefined : value, z.coerce.number().int().min(minimum).optional());
}

const EnvironmentSchema = z.object({
  OPENCODE_MODEL: optionalText(),
  OPENCODE_OCR_MODEL: optionalText(),
  OPENCODE_CONCURRENCY: integer(8, 1),
  OPENCODE_MUTE_TIMEOUT_LIMIT: optionalInteger(1),
  OPENCODE_BUDGET_MS: integer(120_000, 3_000),
  OPENCODE_ATTEMPT_MS: integer(60_000, 3_000),
  UPWHO_PAST_JOB_CONCURRENCY: integer(4, 1),
  UPWHO_PAST_JOB_NAVIGATIONS: integer(-1, -1),
  UPWHO_CDP_URL: optionalText(),
  OPENCODE_CONFIG: optionalText(),
  XDG_CONFIG_HOME: optionalText(),
}).passthrough();

export interface UpwhoConfig {
  opencodeModel: string;
  opencodeOcrModel: string | null;
  opencodeConcurrency: number;
  opencodeMuteTimeoutLimit: number;
  opencodeBudgetMs: number;
  opencodeAttemptMs: number;
  pastJobConcurrency: number;
  pastJobNavigations: number;
  cdpUrl: string;
  opencodeConfig: string | null;
  xdgConfigHome: string | null;
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`).join("; ");
}

function validateCdpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`UPWHO_CDP_URL must be an HTTP(S) or WebSocket URL: ${value}`);
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw new Error(`UPWHO_CDP_URL must be an HTTP(S) or WebSocket URL: ${value}`);
  }
  return value;
}

export function parseConfig(environment: NodeJS.ProcessEnv = process.env): UpwhoConfig {
  const cacheKey = environment as object;
  const cached = configCache.get(cacheKey);
  if (cached) return cached;
  const parsed = EnvironmentSchema.safeParse(environment);
  if (!parsed.success) throw new Error(`Invalid Upwho configuration: ${formatIssues(parsed.error)}`);
  const values = parsed.data;
  const cdpUrl = values.UPWHO_CDP_URL ? validateCdpUrl(values.UPWHO_CDP_URL) : "http://127.0.0.1:9222";
  const config = {
    opencodeModel: values.OPENCODE_MODEL || DEFAULT_OPENCODE_MODEL,
    opencodeOcrModel: values.OPENCODE_OCR_MODEL || null,
    opencodeConcurrency: values.OPENCODE_CONCURRENCY,
    opencodeMuteTimeoutLimit: values.OPENCODE_MUTE_TIMEOUT_LIMIT || Math.max(3, Math.ceil(values.OPENCODE_CONCURRENCY / 2)),
    opencodeBudgetMs: values.OPENCODE_BUDGET_MS,
    opencodeAttemptMs: values.OPENCODE_ATTEMPT_MS,
    pastJobConcurrency: values.UPWHO_PAST_JOB_CONCURRENCY,
    pastJobNavigations: values.UPWHO_PAST_JOB_NAVIGATIONS,
    cdpUrl,
    opencodeConfig: values.OPENCODE_CONFIG || null,
    xdgConfigHome: values.XDG_CONFIG_HOME || null,
  };
  configCache.set(cacheKey, config);
  return config;
}

export function processEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...environment };
}
