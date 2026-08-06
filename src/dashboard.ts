import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { withCancellation } from "./cancellation.ts";
import { clientHistoryFromContracts, clientHistoryFromRecord } from "./client-history.ts";
import { parseConfig } from "./config.ts";
import { rerunClient, runOnce, type RunExecution } from "./run.ts";
import { readRunResult } from "./run-files.ts";
import { parseSearchFilters, type FeedKey } from "./upwork-browser.ts";
import type { Client, ClientHistory, ProgressCallback, ProgressEvent, RunResult } from "./types.ts";

export interface DashboardOptions {
  root?: string;
  port?: number;
  runOnce?: typeof runOnce;
  rerunClient?: typeof rerunClient;
}

type RunStatus = "running" | "cancelling" | "completed" | "failed" | "cancelled";

interface RunState {
  id: string;
  controller: AbortController;
  status: RunStatus;
  events: ProgressEvent[];
  subscribers: Set<ServerResponse>;
}

interface DashboardBody {
  feed?: unknown;
  query?: unknown;
  jobUrl?: unknown;
  searchFilters?: unknown;
  countries?: unknown;
  force?: unknown;
  runId?: unknown;
  buyerId?: unknown;
}

type StoredClient = Omit<Client, "history"> & { history?: ClientHistory };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  res.end(body);
}

async function requestBody(req: IncomingMessage): Promise<DashboardBody> {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 100_000) throw new Error("Request body is too large");
  }
  if (!body.trim()) return {};
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed)) throw new Error("Request body must be a JSON object");
  return parsed;
}

function feed(value: unknown): FeedKey {
  const selected = text(value) || "best-matches";
  if (!["best-matches", "most-recent", "my-feed", "saved", "search"].includes(selected)) throw new Error(`Unknown feed: ${selected}`);
  return selected as FeedKey;
}

function countryList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  throw new Error("countries must be an array or comma-separated string");
}

function safeRunDirectory(root: string, runId: string): string {
  if (basename(runId) !== runId || runId.includes("..")) throw new Error("Invalid run ID");
  const rootPath = resolve(root);
  const candidate = resolve(rootPath, runId);
  if (candidate !== rootPath && !candidate.startsWith(rootPath + sep)) throw new Error("Run is outside the configured root");
  return candidate;
}

async function listRuns(root: string): Promise<Array<{ id: string; feed: string; startedAt: string; clients: number }>> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const runs = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => right.name.localeCompare(left.name))) {
    const result = await readRunResult(resolve(root, entry.name));
    if (result) runs.push({ id: result.runId, feed: result.feed.kind, startedAt: result.startedAt, clients: result.clients.length });
  }
  return runs;
}

async function storedClientHistory(runDirectory: string, client: StoredClient): Promise<ClientHistory> {
  if (client.history) return client.history;
  for (const job of client.jobs) {
    try {
      const raw: unknown = JSON.parse(await readFile(resolve(runDirectory, "data", `${job.feed.id}.json`), "utf8"));
      return clientHistoryFromRecord(raw);
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
  }
  return clientHistoryFromContracts(client.jobs.flatMap((job) => job.details.workHistory));
}

async function withClientHistory(runDirectory: string, result: RunResult): Promise<RunResult> {
  const clients = await Promise.all(result.clients.map(async (client) => ({
    ...client,
    history: await storedClientHistory(runDirectory, client),
  })));
  return { ...result, clients };
}

function sendEvent(response: ServerResponse, event: ProgressEvent): void {
  if (!response.writableEnded) response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function publish(state: RunState, event: ProgressEvent): void {
  state.events.push(event);
  if (state.events.length > 1_000) state.events.shift();
  for (const subscriber of state.subscribers) {
    try {
      sendEvent(subscriber, event);
    } catch {
      state.subscribers.delete(subscriber);
    }
  }
}

function startState(states: Map<string, RunState>): RunState {
  const state: RunState = {
    id: randomUUID(),
    controller: new AbortController(),
    status: "running",
    events: [],
    subscribers: new Set(),
  };
  states.set(state.id, state);
  return state;
}

async function execute(state: RunState, task: (progress: ProgressCallback) => Promise<RunExecution>): Promise<void> {
  try {
    await withCancellation(state.controller.signal, () => task((event) => publish(state, event)));
    state.status = "completed";
  } catch {
    if (state.controller.signal.aborted) state.status = "cancelled";
    else state.status = "failed";
  }
}

async function dashboardHtml(): Promise<string> {
  return readFile(new URL("../dashboard/index.html", import.meta.url), "utf8");
}

export function createDashboardServer(options: DashboardOptions = {}): Server {
  const root = options.root || "runs";
  const executeRunOnce = options.runOnce || runOnce;
  const executeRerunClient = options.rerunClient || rerunClient;
  const states = new Map<string, RunState>();
  let activeRunId: string | null = null;
  const serveRun = async (response: ServerResponse, id: string) => {
    const runDirectory = safeRunDirectory(root, id);
    const result = await readRunResult(runDirectory);
    if (!result) return json(response, 404, { error: "Run not found" });
    return json(response, 200, await withClientHistory(runDirectory, result));
  };
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/") {
        const body = await dashboardHtml();
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
        return response.end(body);
      }
      if (request.method === "GET" && url.pathname === "/api/runs") return json(response, 200, await listRuns(root));
      const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (request.method === "GET" && runMatch) return serveRun(response, decodeURIComponent(runMatch[1]));
      const eventMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
      if (request.method === "GET" && eventMatch) {
        const state = states.get(decodeURIComponent(eventMatch[1]));
        if (!state) return json(response, 404, { error: "Active run not found" });
        response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
        response.write(": connected\n\n");
        for (const event of state.events) sendEvent(response, event);
        state.subscribers.add(response);
        request.on("close", () => state.subscribers.delete(response));
        return;
      }
      const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch) {
        const state = states.get(decodeURIComponent(cancelMatch[1]));
        if (!state) return json(response, 404, { error: "Active run not found" });
        if (state.status === "cancelling" || state.status === "cancelled") return json(response, 200, { status: state.status });
        if (state.status !== "running") return json(response, 409, { error: "Run is no longer active" });
        state.status = "cancelling";
        state.controller.abort(new Error("Run cancelled"));
        return json(response, 202, { status: state.status });
      }
      if (request.method === "POST" && (url.pathname === "/api/run" || url.pathname === "/api/rerun-client")) {
        if (activeRunId) return json(response, 409, { error: "A run is already in progress" });
        const body = await requestBody(request);
        if (url.pathname === "/api/run") {
          const jobUrl = text(body.jobUrl);
          const selectedFeed = jobUrl ? "best-matches" : feed(body.feed);
          const query = text(body.query) || undefined;
          const searchFilters = parseSearchFilters(body.searchFilters);
          if (!jobUrl && selectedFeed === "search" && !query) throw new Error("Search feed requires a query");
          if (!jobUrl && selectedFeed !== "search" && query) throw new Error("query is only valid for search feeds");
          if (!jobUrl && selectedFeed !== "search" && Object.keys(searchFilters).length) throw new Error("searchFilters is only valid for search feeds");
          if (jobUrl && (query || Object.keys(searchFilters).length)) throw new Error("jobUrl cannot be combined with query or searchFilters");
          const state = startState(states);
          activeRunId = state.id;
          json(response, 202, { id: state.id });
          void execute(state, (progress) => executeRunOnce(selectedFeed, query, {
            root,
            countries: countryList(body.countries),
            force: body.force === true,
            jobUrl: jobUrl || undefined,
            searchFilters,
          }, progress)).finally(() => {
            if (activeRunId === state.id) activeRunId = null;
          });
          return;
        }
        const runId = text(body.runId);
        const buyerId = text(body.buyerId);
        if (!runId || !buyerId) throw new Error("rerun-client requires runId and buyerId");
        const sourceRunDirectory = safeRunDirectory(root, runId);
        const state = startState(states);
        activeRunId = state.id;
        json(response, 202, { id: state.id });
        void execute(state, (progress) => executeRerunClient(sourceRunDirectory, buyerId, {}, progress)).finally(() => {
          if (activeRunId === state.id) activeRunId = null;
        });
        return;
      }
      json(response, 404, { error: "Not found" });
    } catch (error) {
      if (!response.writableEnded) json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export async function startDashboard(options: DashboardOptions = {}): Promise<void> {
  parseConfig();
  const server = createDashboardServer(options);
  const port = options.port || 4040;
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveListen());
  });
  process.stdout.write(`Upwho dashboard: http://127.0.0.1:${(server.address() as { port: number }).port}\n`);
  await new Promise<void>(() => {});
}
