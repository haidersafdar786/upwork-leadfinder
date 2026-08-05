import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withCancellation } from "./cancellation.ts";
import { startDashboard } from "./dashboard.ts";
import { rerunClient, runOnce } from "./run.ts";
import type { FeedKey } from "./upwork-browser.ts";
import type { Client, ProgressEvent, RunResult } from "./types.ts";

const FEEDS = new Set<FeedKey>(["best-matches", "most-recent", "my-feed", "saved", "search"]);
const BOOLEAN_FLAGS = new Set(["force", "json", "no-model", "help"]);

interface ParsedArgs {
  command: "run" | "client" | "dashboard" | "help";
  values: Map<string, string>;
  booleans: Set<string>;
}

function help(): string {
  return `upwho — recover the public identity behind Upwork jobs

Commands:
  run       Process a feed (the default command)
  client    Rerun one client from a saved run
  dashboard Start the loopback dashboard

Run options:
  --feed <name>          best-matches, most-recent, my-feed, saved, search
  --query <text|url>     Required for --feed search
  --countries <list>     Override the country skip list; empty disables it
  --force                Process job IDs already present in another run
  --no-model             Use deterministic identity extraction only
  --json                 Print the result JSON to stdout
  --root <directory>     Run folder root (default: runs)
  --clients <number>     Clients analysed at once (maximum and default: 3)
  --research-tabs <n>    Browser tabs used for past-job research (default: 3)
  --details <number>     Job detail requests in flight at once (default: 4)

Dashboard options:
  --port <number>        Loopback port (default: 4040)

Client options:
  --run <directory>      Source run directory
  --buyer-id <id>        Buyer identity key from the source result

Examples:
  npm run cli -- run --feed best-matches
  npm run cli -- run --feed search --query "shopify app"
  npm run cli -- client --run runs/2026-08-02_070000_best-matches --buyer-id 123

Upwork access requires a logged-in Chromium-family browser with CDP available.
The process binds no network server; the dashboard has its own loopback command.
`;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.some((token) => token === "--help" || token === "help")) return { command: "help", values: new Map(), booleans: new Set(["help"]) };
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "run";
  if (command === "help" || command === "--help") return { command: "help", values: new Map(), booleans: new Set(["help"]) };
  if (command !== "run" && command !== "client" && command !== "dashboard") throw new Error(`Unknown command: ${command}`);
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const start = argv[0] === command ? 1 : 0;
  for (let index = start; index < argv.length; index++) {
    const token = argv[index];
    if (!token?.startsWith("--")) throw new Error(`Unexpected argument: ${token || "(empty)"}`);
    const body = token.slice(2);
    const equals = body.indexOf("=");
    const key = equals < 0 ? body : body.slice(0, equals);
    if (!key) throw new Error("Empty option name");
    if (BOOLEAN_FLAGS.has(key)) {
      if (equals >= 0 && body.slice(equals + 1) !== "true") throw new Error(`Boolean option --${key} does not take a value`);
      booleans.add(key);
      continue;
    }
    const value = equals >= 0 ? body.slice(equals + 1) : argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`Option --${key} needs a value`);
    values.set(key, value);
  }
  return { command, values, booleans };
}

function value(args: ParsedArgs, key: string): string | undefined {
  return args.values.get(key);
}

function countries(args: ParsedArgs): string[] | undefined {
  const raw = value(args, "countries");
  return raw === undefined ? undefined : raw.split(",").map((country) => country.trim()).filter(Boolean);
}

function feed(args: ParsedArgs): FeedKey {
  const selected = value(args, "feed") || "best-matches";
  if (!FEEDS.has(selected as FeedKey)) throw new Error(`Unknown feed: ${selected}`);
  return selected as FeedKey;
}

function count(args: ParsedArgs, key: string): number | undefined {
  const raw = value(args, key);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${key} must be a positive integer`);
  return parsed;
}

function port(args: ParsedArgs): number {
  const selected = Number(value(args, "port") || "4040");
  if (!Number.isInteger(selected) || selected < 1 || selected > 65_535) throw new Error("--port must be an integer from 1 to 65535");
  return selected;
}

function progressLine(event: ProgressEvent): string | null {
  if (event.kind === "feed-loaded") return `feed: ${event.feed.kind}, ${event.jobCount} jobs`;
  if (event.kind === "job-skipped") return `skip: ${event.jobId} (${event.reason})`;
  if (event.kind === "job-failed") return `failed: ${event.jobId}: ${event.message}`;
  if (event.kind === "client-progress") return `client ${event.buyerId}: ${event.phase} (${event.completedClients}/${event.totalClients})`;
  if (event.kind === "client-completed") return `done: ${event.client.buyerId}`;
  if (event.kind === "client-failed") return `failed: ${event.buyerId}: ${event.message}`;
  if (event.kind === "run-completed") return `run: ${event.result.runId} (${event.result.clients.length} clients)`;
  if (event.kind === "run-cancelled") return "run cancelled";
  return `run failed: ${event.message}`;
}

function progress(): (event: ProgressEvent) => void {
  return (event) => {
    const line = progressLine(event);
    if (line) process.stderr.write(line + "\n");
  };
}

function clientLine(client: Client): string {
  const identity = client.identity.kind === "unknown"
    ? "unknown"
    : [client.identity.name, client.identity.company || client.identity.product].filter(Boolean).join(" / ") || "identified";
  const links = [client.webPresence.verifiedSite, client.webPresence.personLinkedIn, client.webPresence.companyLinkedIn].filter(Boolean).join(", ") || "-";
  return `${client.buyerId}\t${identity}\t${client.identity.confidence}\t${client.jobs.length}\t${links}`;
}

function printResult(directory: string, result: RunResult): void {
  process.stdout.write(`run directory: ${directory}\n`);
  process.stdout.write(`buyerId\tidentity\tconfidence\tjobs\tweb\n`);
  for (const client of result.clients) process.stdout.write(clientLine(client) + "\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") {
    process.stdout.write(help());
    return;
  }
  if (args.command === "dashboard") {
    await startDashboard({ root: value(args, "root"), port: port(args) });
    return;
  }
  if (args.command === "run") {
    const selectedFeed = feed(args);
    const query = value(args, "query");
    if (selectedFeed === "search" && !query) throw new Error("--feed search requires --query");
    if (selectedFeed !== "search" && query) throw new Error("--query is only valid with --feed search");
    const execution = await runOnce(selectedFeed, query, {
      root: value(args, "root"),
      countries: countries(args),
      force: args.booleans.has("force"),
      useModel: !args.booleans.has("no-model"),
      clientConcurrency: count(args, "clients"),
      researchConcurrency: count(args, "research-tabs"),
      detailConcurrency: count(args, "details"),
    }, progress());
    if (args.booleans.has("json")) process.stdout.write(JSON.stringify(execution.result, null, 2) + "\n");
    else printResult(execution.runDirectory, execution.result);
    if (execution.failures.length) {
      for (const failure of execution.failures) process.stderr.write(`failed: ${failure.jobId}: ${failure.message}\n`);
      process.stderr.write(`${execution.failures.length} job/client operations failed.\n`);
    }
    return;
  }
  const source = value(args, "run");
  const buyer = value(args, "buyer-id");
  if (!source || !buyer) throw new Error("client requires --run and --buyer-id");
  const execution = await rerunClient(source, buyer, { useModel: !args.booleans.has("no-model") }, progress());
  if (args.booleans.has("json")) process.stdout.write(JSON.stringify(execution.result, null, 2) + "\n");
  else printResult(execution.runDirectory, execution.result);
  if (execution.failures.length) {
    for (const failure of execution.failures) process.stderr.write(`failed: ${failure.jobId}: ${failure.message}\n`);
    process.stderr.write(`${execution.failures.length} job/client operations failed.\n`);
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  const controller = new AbortController();
  let interrupted = false;
  const cancel = () => {
    interrupted = true;
    controller.abort(new Error("Run cancelled"));
  };
  const dashboardCommand = process.argv[2] === "dashboard";
  if (!dashboardCommand) {
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
  }
  const execution = dashboardCommand ? main() : withCancellation(controller.signal, main);
  execution
    .catch((error) => {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = interrupted ? 130 : 1;
    })
    .finally(() => {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    });
}
