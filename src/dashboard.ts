import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { clientHistoryFromContracts, clientHistoryFromRecord } from "./client-history.ts";
import { rerunClient, runOnce, type RunExecution } from "./run.ts";
import { readRunResult } from "./run-files.ts";
import type { FeedKey } from "./upwork-browser.ts";
import type { Client, ClientHistory, ProgressCallback, ProgressEvent, RunResult } from "./types.ts";

export interface DashboardOptions {
  root?: string;
  port?: number;
}

interface RunState {
  id: string;
  events: ProgressEvent[];
  subscribers: Set<ServerResponse>;
  result: RunResult | null;
  error: string | null;
}

interface DashboardBody {
  feed?: unknown;
  query?: unknown;
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
  const state: RunState = { id: randomUUID(), events: [], subscribers: new Set(), result: null, error: null };
  states.set(state.id, state);
  return state;
}

async function execute(state: RunState, task: (progress: ProgressCallback) => Promise<RunExecution>): Promise<void> {
  try {
    state.result = (await task((event) => publish(state, event))).result;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  }
}

async function dashboardHtml(): Promise<string> {
  return readFile(new URL("../dashboard/index.html", import.meta.url), "utf8");
}

export function createDashboardServer(options: DashboardOptions = {}): Server {
  const root = options.root || "runs";
  const states = new Map<string, RunState>();
  let active = false;
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
      if (request.method === "POST" && (url.pathname === "/api/run" || url.pathname === "/api/rerun-client")) {
        if (active) return json(response, 409, { error: "A run is already in progress" });
        const body = await requestBody(request);
        if (url.pathname === "/api/run") {
          const selectedFeed = feed(body.feed);
          const query = text(body.query) || undefined;
          if (selectedFeed === "search" && !query) throw new Error("Search feed requires a query");
          if (selectedFeed !== "search" && query) throw new Error("query is only valid for search feeds");
          const state = startState(states);
          active = true;
          json(response, 202, { id: state.id });
          void execute(state, (progress) => runOnce(selectedFeed, query, { root, countries: countryList(body.countries), force: body.force === true }, progress)).finally(() => { active = false; });
          return;
        }
        const runId = text(body.runId);
        const buyerId = text(body.buyerId);
        if (!runId || !buyerId) throw new Error("rerun-client requires runId and buyerId");
        const sourceRunDirectory = safeRunDirectory(root, runId);
        const state = startState(states);
        active = true;
        json(response, 202, { id: state.id });
        void execute(state, (progress) => rerunClient(sourceRunDirectory, buyerId, { root }, progress)).finally(() => { active = false; });
        return;
      }
      json(response, 404, { error: "Not found" });
    } catch (error) {
      if (!response.writableEnded) json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export async function startDashboard(options: DashboardOptions = {}): Promise<void> {
  const server = createDashboardServer(options);
  const port = options.port || 4040;
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveListen());
  });
  process.stdout.write(`Upwho dashboard: http://127.0.0.1:${(server.address() as { port: number }).port}\n`);
  await new Promise<void>(() => {});
}
