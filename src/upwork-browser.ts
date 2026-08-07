import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { z } from "zod";
import { checkpoint, currentCancellationSignal } from "./cancellation.ts";
import { parseConfig, processEnvironment } from "./config.ts";
import {
  SEARCH_CLIENT_HIRE_RANGES,
  SEARCH_DURATIONS,
  SEARCH_EXPERIENCE_LEVELS,
  SEARCH_JOB_TYPES,
  SEARCH_PROPOSAL_RANGES,
  SEARCH_SORTS,
  SEARCH_WORKLOADS,
  type FeedJob,
  type FeedSelection,
  type HttpUrl,
  type IsoDate,
  type JobId,
  type SearchFilters,
} from "./types.ts";

const execFileAsync = promisify(execFile);
const UPWORK_ORIGINS = new Set(["upwork.com", "www.upwork.com"]);
const DETAIL_QUERY_ALIAS = "gql-query-get-auth-job-details-v2";
const DETAIL_QUERY = readFileSync(new URL("./graphql/detail-query.graphql", import.meta.url), "utf8");
export const UPWORK_TENANT_ID = "2000610765543417739";
const FEED_WAIT_MS = 45_000;
const BACKGROUND_TAB_READY_TIMEOUT_MS = 10_000;

export type FeedKey = "best-matches" | "most-recent" | "my-feed" | "saved" | "search";

interface FeedSpec {
  url: string | null;
  statePath: string;
}

const FEEDS: Record<FeedKey, FeedSpec> = {
  "best-matches": { url: "https://www.upwork.com/nx/find-work/best-matches", statePath: "feedBestMatch" },
  "most-recent": { url: "https://www.upwork.com/nx/find-work/most-recent", statePath: "feedMostRecent" },
  "my-feed": { url: "https://www.upwork.com/nx/find-work/my-feed", statePath: "feedMy" },
  saved: { url: "https://www.upwork.com/nx/find-work/saved-jobs", statePath: "savedJobs" },
  search: { url: null, statePath: "jobsSearch" },
};

const SEARCH_DEFAULTS = {
  location: "Americas,Antarctica,Europe,Oceania",
  payment_verified: "1",
  per_page: "50",
  sort: "relevance+desc",
};

interface BrowserDefinition {
  id: string;
  name: string;
  macApp: string;
  macBundleIds: string[];
  linuxBins: string[];
  linuxDesktops: string[];
  winProgIds: string[];
  winPaths: string[];
}

const CHROMIUM_BROWSERS: BrowserDefinition[] = [
  {
    id: "chrome",
    name: "Google Chrome",
    macApp: "Google Chrome",
    macBundleIds: ["com.google.chrome", "com.google.chrome.beta", "com.google.chrome.canary"],
    linuxBins: ["google-chrome", "google-chrome-stable", "chrome"],
    linuxDesktops: ["google-chrome.desktop", "google-chrome-stable.desktop"],
    winProgIds: ["ChromeHTML"],
    winPaths: ["Google/Chrome/Application/chrome.exe"],
  },
  {
    id: "brave",
    name: "Brave Browser",
    macApp: "Brave Browser",
    macBundleIds: ["com.brave.browser", "com.brave.browser.beta", "com.brave.browser.nightly"],
    linuxBins: ["brave-browser", "brave", "brave-browser-stable"],
    linuxDesktops: ["brave-browser.desktop", "brave_brave.desktop"],
    winProgIds: ["BraveHTML"],
    winPaths: ["BraveSoftware/Brave-Browser/Application/brave.exe"],
  },
  {
    id: "edge",
    name: "Microsoft Edge",
    macApp: "Microsoft Edge",
    macBundleIds: ["com.microsoft.edgemac"],
    linuxBins: ["microsoft-edge", "microsoft-edge-stable"],
    linuxDesktops: ["microsoft-edge.desktop"],
    winProgIds: ["MSEdgeHTM", "MSEdgeDHTML", "MSEdgeHTML"],
    winPaths: ["Microsoft/Edge/Application/msedge.exe"],
  },
  {
    id: "vivaldi",
    name: "Vivaldi",
    macApp: "Vivaldi",
    macBundleIds: ["com.vivaldi.vivaldi"],
    linuxBins: ["vivaldi", "vivaldi-stable"],
    linuxDesktops: ["vivaldi-stable.desktop", "vivaldi.desktop"],
    winProgIds: ["VivaldiHTM"],
    winPaths: ["Vivaldi/Application/vivaldi.exe"],
  },
  {
    id: "opera",
    name: "Opera",
    macApp: "Opera",
    macBundleIds: ["com.operasoftware.opera"],
    linuxBins: ["opera"],
    linuxDesktops: ["opera.desktop", "opera_opera.desktop"],
    winProgIds: ["OperaStable"],
    winPaths: ["Programs/Opera/opera.exe", "Programs/Opera/launcher.exe"],
  },
  {
    id: "arc",
    name: "Arc",
    macApp: "Arc",
    macBundleIds: ["company.thebrowser.browser"],
    linuxBins: [],
    linuxDesktops: [],
    winProgIds: ["ArcHTML"],
    winPaths: ["TheBrowserCompany/Arc/Arc.exe"],
  },
  {
    id: "chromium",
    name: "Chromium",
    macApp: "Chromium",
    macBundleIds: ["org.chromium.chromium"],
    linuxBins: ["chromium", "chromium-browser"],
    linuxDesktops: ["chromium.desktop", "chromium-browser.desktop"],
    winProgIds: ["ChromiumHTM"],
    winPaths: ["Chromium/Application/chrome.exe"],
  },
];

const NON_CHROMIUM_BROWSERS = [
  { id: "safari", name: "Safari", macBundleIds: ["com.apple.safari"], linuxDesktops: [], winProgIds: [] },
  { id: "firefox", name: "Firefox", macBundleIds: ["org.mozilla.firefox"], linuxDesktops: ["firefox.desktop", "org.mozilla.firefox.desktop"], winProgIds: ["FirefoxURL", "FirefoxHTML"] },
];

declare global {
  interface Window {
    __NUXT__?: {
      state?: Record<string, { jobs?: unknown[] }>;
      vuex?: {
        jobDetails?: {
          job?: {
            [key: string]: unknown;
            description?: unknown;
            attachments?: unknown[];
          };
        };
      };
    };
  }
}

export interface FeedSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  browserName: string;
  selection: FeedSelection;
  jobs: FeedJob[];
  rawJobs: Record<string, unknown>[];
  token: string;
}

let backgroundPageCreationTail = Promise.resolve();

async function queueBackgroundPageCreation<T>(create: () => Promise<T>): Promise<T> {
  const creation = backgroundPageCreationTail.then(() => {
    checkpoint();
    return create();
  });
  backgroundPageCreationTail = creation.then(() => undefined, () => undefined);
  return creation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function toJobId(value: string): JobId {
  if (value === "." || value === ".." || !/^[A-Za-z0-9_.~-]+$/.test(value)) throw new Error(`Feed job id is invalid: ${value}`);
  return value as JobId;
}

function toIsoDate(value: string | null): IsoDate | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return value as IsoDate;
}

function toUpworkUrl(value: string): HttpUrl {
  const url = new URL(value);
  if (url.protocol !== "https:" || !UPWORK_ORIGINS.has(url.hostname) || !url.pathname.startsWith("/jobs/")) {
    throw new Error(`Feed job URL is not an Upwork job URL: ${value}`);
  }
  return value as HttpUrl;
}

const StringList = <Value extends string>(schema: z.ZodType<Value>) => z.preprocess(
  (value) => Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : value,
  z.array(schema),
);

const SearchFiltersSchema = z.object({
  allWords: z.string().trim().min(1).optional(),
  anyWords: z.string().trim().min(1).optional(),
  exactPhrase: z.string().trim().min(1).optional(),
  excludeWords: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  skills: z.string().trim().min(1).optional(),
  jobTypes: StringList(z.enum(SEARCH_JOB_TYPES)).optional(),
  experienceLevels: StringList(z.enum(SEARCH_EXPERIENCE_LEVELS)).optional(),
  clientHires: StringList(z.enum(SEARCH_CLIENT_HIRE_RANGES)).optional(),
  workloads: StringList(z.enum(SEARCH_WORKLOADS)).optional(),
  durations: StringList(z.enum(SEARCH_DURATIONS)).optional(),
  proposals: StringList(z.enum(SEARCH_PROPOSAL_RANGES)).optional(),
  locations: StringList(z.string().trim().min(1)).optional(),
  page: z.coerce.number().int().min(1).max(1_000).optional(),
  perPage: z.coerce.number().int().min(1).max(50).optional(),
  daysPosted: z.coerce.number().int().min(1).max(30).optional(),
  paymentVerified: z.boolean().optional(),
  enterpriseOnly: z.boolean().optional(),
  sort: z.enum(SEARCH_SORTS).optional(),
}).strict();

export function parseSearchFilters(value: unknown): SearchFilters {
  if (value === undefined || value === null || value === "") return {};
  let input = value;
  if (typeof value === "string") {
    try {
      input = JSON.parse(value);
    } catch (error) {
      throw new Error("search filters must be valid JSON", { cause: error });
    }
  }
  return SearchFiltersSchema.parse(input);
}

function searchFilterParams(filters: SearchFilters): Record<string, string> {
  const params: Record<string, string> = {};
  const scalarFields: Array<[keyof SearchFilters, string]> = [
    ["allWords", "all_words"],
    ["anyWords", "any_words"],
    ["exactPhrase", "exact_phrase"],
    ["excludeWords", "exclude_words"],
    ["title", "title"],
    ["skills", "skills"],
    ["sort", "sort"],
  ];
  for (const [field, name] of scalarFields) {
    const value = filters[field];
    if (typeof value === "string" && value) params[name] = value;
  }
  const lists: Array<[keyof SearchFilters, string]> = [
    ["jobTypes", "job_type"],
    ["experienceLevels", "experience_level"],
    ["clientHires", "client_hires"],
    ["workloads", "workload"],
    ["durations", "duration"],
    ["proposals", "proposals"],
    ["locations", "location"],
  ];
  for (const [field, name] of lists) {
    const value = filters[field];
    if (Array.isArray(value)) params[name] = value.join(",");
  }
  if (filters.page !== undefined) params.page = String(filters.page);
  if (filters.perPage !== undefined) params.per_page = String(filters.perPage);
  if (filters.daysPosted !== undefined) params.days_posted = String(filters.daysPosted);
  if (filters.paymentVerified !== undefined) params.payment_verified = filters.paymentVerified ? "1" : "0";
  if (filters.enterpriseOnly !== undefined) params.enterprise = filters.enterpriseOnly ? "1" : "0";
  return params;
}

function selectionFor(feedKey: FeedKey, query: string | undefined, filters: SearchFilters = {}): FeedSelection {
  const spec = FEEDS[feedKey];
  if (feedKey === "search") {
    if (!query?.trim()) throw new Error("Search feed requires a query or an Upwork search URL");
    return { kind: "search", url: toUpworkSearchUrl(buildSearchUrl(query, filters)), query, filters };
  }
  if (!spec.url) throw new Error(`Feed ${feedKey} has no URL`);
  return { kind: feedKey, url: toUpworkSearchUrl(spec.url) };
}

function toUpworkSearchUrl(value: string): HttpUrl {
  const url = new URL(value);
  if (url.protocol !== "https:" || !UPWORK_ORIGINS.has(url.hostname)) {
    throw new Error(`URL is not an HTTPS Upwork URL: ${value}`);
  }
  return value as HttpUrl;
}

export function buildSearchUrl(queryOrUrl: string, filters: SearchFilters = {}): string {
  if (/^https?:\/\//i.test(queryOrUrl)) {
    const url = new URL(queryOrUrl);
    if (url.protocol !== "https:" || !UPWORK_ORIGINS.has(url.hostname) || !url.pathname.startsWith("/nx/search/jobs/")) {
      throw new Error("Search URL must be an HTTPS Upwork job-search URL");
    }
    if (Object.keys(filters).length === 0) return queryOrUrl;
    for (const [key, value] of Object.entries(searchFilterParams(filters))) url.searchParams.set(key, value);
    return url.toString();
  }
  const params = new URLSearchParams({ ...SEARCH_DEFAULTS, ...searchFilterParams(filters), q: queryOrUrl });
  return `https://www.upwork.com/nx/search/jobs/?${params.toString()}`;
}

function jobCiphertextFromUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || !UPWORK_ORIGINS.has(url.hostname) || !url.pathname.startsWith("/jobs/")) {
    throw new Error(`URL is not an HTTPS Upwork job URL: ${value}`);
  }
  const segment = url.pathname.split("/").filter(Boolean).at(-1);
  if (!segment) throw new Error(`Upwork job URL has no job identifier: ${value}`);
  const ciphertext = decodeURIComponent(segment);
  if (!/^[A-Za-z0-9_.~-]+$/.test(ciphertext)) throw new Error(`Upwork job URL has an invalid job identifier: ${value}`);
  return ciphertext;
}

function jobSelection(jobUrl: string): Extract<FeedSelection, { kind: "job" }> {
  const url = toUpworkUrl(jobUrl);
  return { kind: "job", url, jobUrl: url };
}

function parseFeedJob(value: unknown, selection: FeedSelection): FeedJob {
  const job = objectValue(value);
  if (!job) throw new Error("Feed state contained a non-object job");

  const id = textValue(job.uid ?? job.id);
  const ciphertext = textValue(job.ciphertext);
  if (!id || !ciphertext) throw new Error("Feed state contained a job without uid or ciphertext");

  const client = objectValue(job.client);
  const location = objectValue(client?.location);
  const url = textValue(job.url) || `https://www.upwork.com/jobs/${ciphertext}`;
  return {
    selection,
    id: toJobId(id),
    ciphertext,
    url: toUpworkUrl(url),
    title: textValue(job.title) || "",
    description: textValue(job.description) || "",
    publishedAt: toIsoDate(textValue(job.publishedOn) || textValue(job.createdOn)),
    clientCountry: textValue(location?.country),
  };
}

interface EmbeddedFeed {
  jobs: FeedJob[];
  rawJobs: Record<string, unknown>[];
}

async function readEmbeddedJobs(page: Page, statePath: string, selection: FeedSelection): Promise<EmbeddedFeed> {
  try {
    await page.waitForFunction(
      (path) => {
        const jobs = window.__NUXT__?.state?.[path]?.jobs;
        return Array.isArray(jobs) && jobs.length > 0;
      },
      statePath,
      { timeout: FEED_WAIT_MS }
    );
  } catch (error) {
    const location = page.url();
    if (/login|signup|challenge|captcha/i.test(location)) {
      throw new Error(`Upwork feed is unavailable because the browser is not logged in or is Cloudflare-challenged: ${location}`, { cause: error });
    }
    throw new Error(`Upwork feed state ${statePath} did not hydrate at ${location}`, { cause: error });
  }

  const serialized = await page.evaluate((path) => {
    const jobs = window.__NUXT__?.state?.[path]?.jobs;
    return Array.isArray(jobs) ? JSON.stringify(jobs) : null;
  }, statePath);
  if (!serialized) throw new Error(`Upwork feed state ${statePath} was empty after hydration`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`Upwork feed state ${statePath} was not valid JSON`, { cause: error });
  }
  if (!Array.isArray(parsed)) throw new Error(`Upwork feed state ${statePath} was not an array`);
  const rawJobs = parsed.map((job) => {
    const raw = objectValue(job);
    if (!raw) throw new Error(`Upwork feed state ${statePath} contained a non-object job`);
    return raw;
  });
  return { rawJobs, jobs: rawJobs.map((job) => parseFeedJob(job, selection)) };
}

async function loadFeed(page: Page, feedKey: FeedKey, selection: FeedSelection): Promise<EmbeddedFeed> {
  const spec = FEEDS[feedKey];
  const url = selection.kind === "search" ? selection.url : spec.url;
  if (!url) throw new Error(`Feed ${feedKey} has no URL`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: FEED_WAIT_MS });
  return readEmbeddedJobs(page, spec.statePath, selection);
}

async function loadJobPage(page: Page, selection: Extract<FeedSelection, { kind: "job" }>): Promise<EmbeddedFeed> {
  const ciphertext = jobCiphertextFromUrl(selection.jobUrl);
  await page.goto(selection.jobUrl, { waitUntil: "domcontentloaded", timeout: FEED_WAIT_MS });
  const serialized = await page.evaluate(() => {
    const job = window.__NUXT__?.vuex?.jobDetails?.job;
    return job && typeof job === "object" ? JSON.stringify(job) : null;
  });
  let embedded: Record<string, unknown> = {};
  if (serialized) {
    try {
      const parsed: unknown = JSON.parse(serialized);
      embedded = objectValue(parsed) || {};
    } catch (error) {
      throw new Error(`Upwork job page state was not valid JSON: ${selection.jobUrl}`, { cause: error });
    }
  }
  const raw: Record<string, unknown> = {
    ...embedded,
    uid: textValue(embedded.uid ?? embedded.id) || ciphertext,
    ciphertext: textValue(embedded.ciphertext) || ciphertext,
    url: selection.jobUrl,
    title: textValue(embedded.title) || "",
    description: textValue(embedded.description) || "",
  };
  return { rawJobs: [raw], jobs: [parseFeedJob(raw, selection)] };
}

function bearerFromHeaders(headers: Record<string, string>): string | null {
  const authorization = Object.entries(headers).find(([key]) => key.toLowerCase() === "authorization")?.[1] || "";
  return /^bearer\s+\S+$/i.test(authorization) ? authorization : null;
}

function isUpworkGraphqlRequest(url: string): boolean {
  try {
    const requestUrl = new URL(url);
    return UPWORK_ORIGINS.has(requestUrl.hostname) && requestUrl.pathname.startsWith("/api/graphql/");
  } catch {
    return false;
  }
}

export function graphqlBearerCandidate(url: string, headers: Record<string, string>): string | null {
  return isUpworkGraphqlRequest(url) ? bearerFromHeaders(headers) : null;
}

export async function selectJobDetailsBearer(
  candidates: readonly string[],
  canFetchDetails: (candidate: string) => Promise<boolean>,
): Promise<string | null> {
  for (const candidate of candidates) {
    if (await canFetchDetails(candidate)) return candidate;
  }
  return null;
}

async function defaultBrowser(platform: ReturnType<typeof osPlatform> = osPlatform()): Promise<{ id: string | null; name: string; chromium: boolean }> {
  let raw = "";
  try {
    if (platform === "darwin") {
      const plist = join(homedir(), "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist");
      const { stdout } = await execFileAsync("plutil", ["-convert", "json", "-o", "-", plist]);
      const parsed: unknown = JSON.parse(stdout);
      const handlers = isRecord(parsed) && Array.isArray(parsed.LSHandlers) ? parsed.LSHandlers : [];
      const handler = handlers.find((item) => isRecord(item) && (item.LSHandlerURLScheme === "https" || item.LSHandlerURLScheme === "http"));
      raw = isRecord(handler) ? textValue(handler.LSHandlerRoleAll) || "" : "";
    } else if (platform === "win32") {
      const { stdout } = await execFileAsync("reg", [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice",
        "/v",
        "ProgId",
      ]);
      raw = stdout.match(/ProgId\s+REG_SZ\s+(\S+)/i)?.[1] || "";
    } else {
      const { stdout } = await execFileAsync("xdg-settings", ["get", "default-web-browser"]);
      raw = stdout.trim();
    }
  } catch {
    raw = platform === "darwin" ? "com.apple.safari" : "unknown";
  }

  const normalized = raw.toLowerCase();
  const chromium = CHROMIUM_BROWSERS.find((browser) =>
    browser.macBundleIds.includes(normalized) || browser.linuxDesktops.includes(normalized) || browser.winProgIds.some((id) => id.toLowerCase() === normalized)
  );
  if (chromium) return { id: chromium.id, name: chromium.name, chromium: true };
  const other = NON_CHROMIUM_BROWSERS.find((browser) =>
    browser.macBundleIds.includes(normalized) || browser.linuxDesktops.includes(normalized) || browser.winProgIds.some((id) => id.toLowerCase() === normalized)
  );
  return { id: other?.id || null, name: other?.name || raw || "unknown", chromium: false };
}

function installedChromium(platform: ReturnType<typeof osPlatform> = osPlatform()): BrowserDefinition | null {
  for (const browser of CHROMIUM_BROWSERS) {
    if (executableFor(browser, platform)) return browser;
  }
  return null;
}

interface BrowserExecutable {
  launcher: "open" | "exe";
  path: string;
  app?: string;
}

function executableFor(browser: BrowserDefinition, platform: ReturnType<typeof osPlatform> = osPlatform(), env = processEnvironment()): BrowserExecutable | null {
  if (platform === "darwin") {
    const locations = ["/Applications", join(env.HOME || homedir(), "Applications")];
    for (const directory of locations) {
      const path = join(directory, `${browser.macApp}.app`);
      if (existsSync(path)) return { launcher: "open", path, app: browser.macApp };
    }
    return null;
  }
  if (platform === "win32") {
    const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter((root): root is string => Boolean(root));
    for (const relative of browser.winPaths) {
      for (const root of roots) {
        const path = join(root, relative);
        if (existsSync(path)) return { launcher: "exe", path };
      }
    }
    return null;
  }
  const directories = (env.PATH || "").split(delimiter).filter(Boolean);
  for (const binary of browser.linuxBins) {
    for (const directory of directories) {
      const path = join(directory, binary);
      if (existsSync(path)) return { launcher: "exe", path };
    }
  }
  return null;
}

async function launchPlan(): Promise<{ browser: BrowserDefinition; executable: BrowserExecutable; fallbackReason: string | null }> {
  const detected = await defaultBrowser();
  const preferred = CHROMIUM_BROWSERS.find((browser) => browser.id === detected.id);
  const preferredExecutable = preferred && executableFor(preferred);
  if (preferred && preferredExecutable) return { browser: preferred, executable: preferredExecutable, fallbackReason: null };

  const fallback = installedChromium();
  const executable = fallback && executableFor(fallback);
  if (!fallback || !executable) {
    throw new Error(`No Chromium-family browser is installed. The detected default browser is ${detected.name}. Install Chrome, Brave, Edge, Vivaldi, Opera, Arc, or Chromium.`);
  }
  const fallbackReason = detected.chromium
    ? `default browser ${detected.name} was not executable`
    : `default browser ${detected.name} cannot be driven over CDP`;
  return { browser: fallback, executable, fallbackReason };
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function ensureCdp(cdpUrl: string): Promise<void> {
  if (await cdpAvailable(cdpUrl)) return;
  if (/^ws/i.test(cdpUrl)) throw new Error(`No CDP endpoint is available at ${cdpUrl}`);

  const plan = await launchPlan();
  if (plan.fallbackReason) process.stderr.write(`Using ${plan.browser.name}: ${plan.fallbackReason}.\n`);
  if (plan.executable.launcher === "open") {
    const running = await execFileAsync("pgrep", ["-f", `${plan.browser.macApp}.app`]).then(() => true).catch(() => false);
    if (running) {
      throw new Error(`${plan.browser.name} is already running without remote debugging. Fully quit it, then retry so Upwork can be opened with CDP enabled.`);
    }
  }

  const port = new URL(cdpUrl).port || "9222";
  const args = [`--remote-debugging-port=${port}`, "--restore-last-session"];
  const child = plan.executable.launcher === "open"
    ? spawn("open", ["-a", plan.executable.app || plan.browser.name, "--args", ...args], { detached: true, stdio: "ignore" })
    : spawn(plan.executable.path, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();

  for (let attempt = 0; attempt < 40; attempt++) {
    if (await cdpAvailable(cdpUrl)) return;
    await sleep(500);
  }
  throw new Error(`The DevTools endpoint did not come up at ${cdpUrl}. Start ${plan.browser.name} with remote debugging enabled and retry.`);
}

async function browserName(): Promise<string> {
  const detected = await defaultBrowser();
  if (detected.chromium) return detected.name;
  const fallback = installedChromium();
  if (fallback) return `${fallback.name} (default browser: ${detected.name})`;
  return detected.name;
}

async function cdpAvailable(cdpUrl: string): Promise<boolean> {
  if (/^ws/i.test(cdpUrl)) return true;
  try {
    const response = await fetch(`${cdpUrl.replace(/\/$/, "")}/json/version`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function newBackgroundPage(browser: Browser, context: BrowserContext, initialUrl: HttpUrl): Promise<Page> {
  return queueBackgroundPageCreation(async () => {
    const marker = new URL(initialUrl);
    const markerHash = `#upwho-${randomUUID()}`;
    marker.hash = markerHash;
    const markerUrl = marker.toString();
    const cdp = await browser.newBrowserCDPSession();
    let targetId: string | null = null;

    try {
      const target = await cdp.send("Target.createTarget", { url: markerUrl, background: true });
      targetId = target.targetId;
      const deadline = Date.now() + BACKGROUND_TAB_READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        checkpoint();
        // The fragment survives the redirects Upwork applies to a feed URL, so the tab stays findable.
        const page = context.pages().find((candidate) => candidate.url().endsWith(markerHash));
        if (page) return page;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Background tab did not become ready within ${BACKGROUND_TAB_READY_TIMEOUT_MS}ms`);
    } catch (error) {
      if (targetId) await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      throw error;
    } finally {
      await cdp.detach().catch(() => {});
    }
  });
}

async function openSession(selection: FeedSelection, load: (page: Page) => Promise<EmbeddedFeed>, cdpUrl = parseConfig().cdpUrl): Promise<FeedSession> {
  const signal = currentCancellationSignal();
  checkpoint(signal);
  await ensureCdp(cdpUrl);
  checkpoint(signal);

  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 15_000 });
  let page: Page | null = null;
  const cancel = () => { void browser.close().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const candidateTokens = new Set<string>();
  const pendingHeaderReads = new Set<Promise<void>>();
  const captureRequest = (request: { url(): string; headers(): Record<string, string>; allHeaders(): Promise<Record<string, string>> }) => {
    if (!isUpworkGraphqlRequest(request.url())) return;
    const candidate = graphqlBearerCandidate(request.url(), request.headers());
    if (candidate) {
      candidateTokens.add(candidate);
      return;
    }
    const read = request.allHeaders().then((headers) => {
      const token = graphqlBearerCandidate(request.url(), headers);
      if (token) candidateTokens.add(token);
    }).catch(() => {});
    pendingHeaderReads.add(read);
    void read.finally(() => pendingHeaderReads.delete(read));
  };

  try {
    checkpoint(signal);
    const context = browser.contexts()[0];
    if (!context) throw new Error("The CDP browser has no usable browser context");
    const feedPage = await newBackgroundPage(browser, context, selection.url);
    page = feedPage;
    feedPage.on("request", captureRequest);
    const loaded = await load(feedPage);
    const firstJob = loaded.jobs[0];
    if (!firstJob) throw new Error("The feed loaded without any jobs");
    const testedTokens = new Set<string>();
    let detailToken: string | null = null;
    for (let attempt = 0; attempt < 40 && !detailToken; attempt++) {
      await Promise.allSettled([...pendingHeaderReads]);
      const untestedTokens = [...candidateTokens].filter((token) => !testedTokens.has(token));
      for (const token of untestedTokens) testedTokens.add(token);
      detailToken = await selectJobDetailsBearer(untestedTokens, async (token) => {
        try {
          await requestJobDetails(feedPage, token, firstJob.ciphertext);
          return true;
        } catch {
          return false;
        }
      });
      if (!detailToken) await feedPage.waitForTimeout(250);
    }
    if (!detailToken) throw new Error(`The feed exposed ${candidateTokens.size} bearer token candidates, but none could fetch authenticated job details`);
    return { browser, context, page: feedPage, browserName: await browserName(), selection, ...loaded, token: detailToken };
  } catch (error) {
    await page?.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export async function openFeed(
  feedKey: FeedKey = "best-matches",
  query?: string,
  { cdpUrl = parseConfig().cdpUrl, searchFilters = {} }: { cdpUrl?: string; searchFilters?: SearchFilters } = {},
): Promise<FeedSession> {
  const selection = selectionFor(feedKey, query, searchFilters);
  return openSession(selection, (page) => loadFeed(page, feedKey, selection), cdpUrl);
}

export async function openJobUrl(jobUrl: string, { cdpUrl = parseConfig().cdpUrl } = {}): Promise<FeedSession> {
  const selection = jobSelection(jobUrl);
  return openSession(selection, (page) => loadJobPage(page, selection), cdpUrl);
}

export async function closeFeed(session: FeedSession): Promise<void> {
  await session.page.close().catch(() => {});
  await session.browser.close().catch(() => {});
}

interface DetailFetchResult {
  status: number;
  text: string;
}

function parsedObject(value: unknown, label: string): Record<string, unknown> {
  const object = objectValue(value);
  if (!object) throw new Error(`${label} was not an object`);
  return object;
}

async function requestJobDetails(page: Page, token: string, ciphertext: string): Promise<unknown> {
  const response = await page.evaluate(
    async ({ alias, query, token: authorization, ciphertext: jobCiphertext, tenantId }): Promise<DetailFetchResult> => {
      const result = await fetch(`/api/graphql/v1?alias=${encodeURIComponent(alias)}`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Authorization: authorization,
          "X-Upwork-API-TenantId": tenantId,
          "X-Upwork-Accept-Language": "en-US",
        },
        body: JSON.stringify({
          query,
          variables: { id: jobCiphertext },
        }),
      });
      return { status: result.status, text: await result.text() };
    },
    { alias: DETAIL_QUERY_ALIAS, query: DETAIL_QUERY, token, ciphertext, tenantId: UPWORK_TENANT_ID }
  );

  if (response.status !== 200) throw new Error(`Job details request failed with HTTP ${response.status}`);

  let payload: unknown;
  try {
    payload = JSON.parse(response.text);
  } catch (error) {
    throw new Error("Job details response was not valid JSON", { cause: error });
  }
  const body = parsedObject(payload, "Job details response");
  const errors = body.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`Job details GraphQL error: ${JSON.stringify(errors[0]).slice(0, 500)}`);
  }
  const data = parsedObject(body.data, "Job details response data");
  return data.jobAuthDetails ?? null;
}

export async function fetchJobDetails(session: FeedSession, ciphertext: string): Promise<unknown> {
  return requestJobDetails(session.page, session.token, ciphertext);
}

export interface PublicJobAttachment {
  fileName: string;
  uri: string;
}

export interface PublicJob {
  description: string;
  attachments: PublicJobAttachment[];
}

function dereferenceNuxt(values: unknown[], reference: unknown): unknown {
  let value = reference;
  const visited = new Set<number>();
  while (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < values.length && !visited.has(value)) {
    visited.add(value);
    value = values[value];
    if (Array.isArray(value) && (value[0] === "Reactive" || value[0] === "ShallowReactive")) value = value[1];
  }
  return value;
}

function nuxtProperty(values: unknown[], value: unknown, key: string): unknown {
  const object = objectValue(dereferenceNuxt(values, value));
  return object ? dereferenceNuxt(values, object[key]) : null;
}

export function parsePublicJobHtml(html: string): PublicJob | null {
  if (!html.includes("__NUXT_DATA__")) return null;
  const script = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!script?.[1]) return null;
  let values: unknown;
  try {
    values = JSON.parse(script[1]);
  } catch (error) {
    throw new Error("Public job Nuxt state was not valid JSON", { cause: error });
  }
  if (!Array.isArray(values)) return null;
  const root = dereferenceNuxt(values, 0);
  const vuex = nuxtProperty(values, root, "vuex");
  const jobDetails = nuxtProperty(values, vuex, "jobDetails");
  const job = nuxtProperty(values, jobDetails, "job");
  const description = nuxtProperty(values, job, "description");
  if (typeof description !== "string") return null;
  const rawAttachments = nuxtProperty(values, job, "attachments");
  const attachments = Array.isArray(rawAttachments) ? rawAttachments.flatMap((reference): PublicJobAttachment[] => {
    const attachment = dereferenceNuxt(values, reference);
    const fileName = textValue(nuxtProperty(values, attachment, "fileName"));
    const uri = textValue(nuxtProperty(values, attachment, "uri"));
    return fileName && uri ? [{ fileName, uri }] : [];
  }) : [];
  return { description: Array.from(description).slice(0, 5_000).join(""), attachments };
}

const CHALLENGE_PATTERN = /__cf_chl|cf[-_]challenge|<title>[^<]*challenge[^<]*<\/title>|\bcaptcha\b/i;

export function isChallengeResponse(status: number, body: string): boolean {
  return status === 403 && CHALLENGE_PATTERN.test(body.slice(0, 4_000));
}

export function isChallengeUrl(url: string): boolean {
  return /__cf_chl|login|signup|challenge|captcha/i.test(url);
}

export type PublicJobRead =
  | { kind: "job"; job: PublicJob }
  | { kind: "challenged" }
  | { kind: "unavailable" };

export const PUBLIC_JOB_READ_TIMEOUT_MS = 20_000;

async function withTimeout<Value>(work: Promise<Value>, timeoutMs: number, message: string): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function fetchPublicJobState(
  page: Page,
  ciphertext: string,
  timeoutMs = PUBLIC_JOB_READ_TIMEOUT_MS,
): Promise<PublicJobRead> {
  const read = await withTimeout(
    page.evaluate(async ({ requestPath, budgetMs }) => {
      const response = await fetch(requestPath, { credentials: "include", signal: AbortSignal.timeout(budgetMs) });
      const html = await response.text();
      return {
        status: response.status,
        head: html.slice(0, 4_000),
        state: response.status === 200 ? html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1] || null : null,
      };
    }, { requestPath: `/jobs/${ciphertext}`, budgetMs: timeoutMs }),
    timeoutMs + 5_000,
    `Public job ${ciphertext} read did not finish within ${timeoutMs + 5_000}ms`,
  );
  if (isChallengeResponse(read.status, read.head)) return { kind: "challenged" };
  if (!read.state) return { kind: "unavailable" };
  const job = parsePublicJobHtml(`<script id="__NUXT_DATA__" type="application/json">${read.state}</script>`);
  return job ? { kind: "job", job } : { kind: "unavailable" };
}

export async function fetchRenderedPublicJob(page: Page, ciphertext: string): Promise<PublicJob | null> {
  const path = `/jobs/${ciphertext}`;
  await page.goto(`https://www.upwork.com${path}`, { waitUntil: "domcontentloaded", timeout: FEED_WAIT_MS });
  let sawChallenge = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (isChallengeUrl(page.url())) {
      // Give an in-place Cloudflare challenge time to redirect back to the job.
      sawChallenge = true;
      await page.waitForTimeout(400);
      continue;
    }
    const read = page.evaluate(() => {
      const job = window.__NUXT__?.vuex?.jobDetails?.job;
      if (!job || typeof job.description !== "string") return null;
      const attachments = Array.isArray(job.attachments)
        ? job.attachments.flatMap((value) => {
            const fileName = typeof value === "object" && value !== null && "fileName" in value && typeof value.fileName === "string" ? value.fileName : null;
            const uri = typeof value === "object" && value !== null && "uri" in value && typeof value.uri === "string" ? value.uri : null;
            return fileName && uri ? [{ fileName, uri }] : [];
          })
        : [];
      return { description: job.description.slice(0, 5_000), attachments };
    });
    const rendered = await withTimeout(read, PUBLIC_JOB_READ_TIMEOUT_MS, `Public job ${ciphertext} did not answer within ${PUBLIC_JOB_READ_TIMEOUT_MS}ms`)
      .catch((error: unknown) => {
        if (isChallengeUrl(page.url())) {
          sawChallenge = true;
          return null;
        }
        throw error;
      });
    if (rendered) return rendered;
    const location = page.url();
    if (isChallengeUrl(location)) {
      sawChallenge = true;
      await page.waitForTimeout(400);
      continue;
    }
    if (/page-not-found|sorry/i.test(location)) return null;
    await page.waitForTimeout(400);
  }
  if (sawChallenge) throw new Error(`Upwork login or challenge blocked public job ${ciphertext}`);
  throw new Error(`Public job ${ciphertext} did not hydrate before timeout`);
}
