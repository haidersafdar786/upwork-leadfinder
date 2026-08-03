import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { FeedJob, FeedSelection, HttpUrl, IsoDate, JobId } from "./types.ts";

const execFileAsync = promisify(execFile);
const UPWORK_ORIGINS = new Set(["upwork.com", "www.upwork.com"]);
const DETAIL_REQUEST = "get-auth-job-details-v2";
const DETAIL_QUERY = readFileSync(new URL("./graphql/detail-query.graphql", import.meta.url), "utf8");
export const UPWORK_TENANT_ID = "1538018989781975041";
const DEFAULT_CDP_URL = "http://127.0.0.1:9222";
const FEED_WAIT_MS = 45_000;
const BACKGROUND_TAB_READY_TIMEOUT_MS = 5_000;

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
  page: Page;
  browserName: string;
  selection: FeedSelection;
  jobs: FeedJob[];
  rawJobs: Record<string, unknown>[];
  token: string;
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
  if (!/^\d+$/.test(value)) throw new Error(`Feed job id is invalid: ${value}`);
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

function selectionFor(feedKey: FeedKey, query: string | undefined): FeedSelection {
  const spec = FEEDS[feedKey];
  if (feedKey === "search") {
    if (!query?.trim()) throw new Error("Search feed requires a query or an Upwork search URL");
    return { kind: "search", url: toUpworkSearchUrl(buildSearchUrl(query)), query };
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

export function buildSearchUrl(queryOrUrl: string, overrides: Record<string, string> = {}): string {
  if (/^https?:\/\//i.test(queryOrUrl)) {
    const url = new URL(queryOrUrl);
    if (url.protocol !== "https:" || !UPWORK_ORIGINS.has(url.hostname) || !url.pathname.startsWith("/nx/search/jobs/")) {
      throw new Error("Search URL must be an HTTPS Upwork job-search URL");
    }
    return queryOrUrl;
  }
  const params = { ...SEARCH_DEFAULTS, ...overrides, q: queryOrUrl };
  const encoded = Object.entries(params)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return `https://www.upwork.com/nx/search/jobs/?${encoded}`;
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

function bearerFromHeaders(headers: Record<string, string>): string | null {
  const authorization = Object.entries(headers).find(([key]) => key.toLowerCase() === "authorization")?.[1] || "";
  return /^bearer\s+\S+$/i.test(authorization) ? authorization : null;
}

async function clickTilesUntilToken(page: Page, token: () => string | null): Promise<void> {
  const links = page.locator("h3.job-tile-title a");
  const count = Math.min(await links.count(), 6);
  for (let index = 0; index < count && !token(); index++) {
    const link = links.nth(index);
    await link.evaluate((element) => element.setAttribute("target", "_self")).catch(() => {});
    await link.click({ timeout: 5_000 }).catch(() => {});
    for (let attempt = 0; attempt < 32 && !token(); attempt++) await page.waitForTimeout(250);
  }
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

function executableFor(browser: BrowserDefinition, platform: ReturnType<typeof osPlatform> = osPlatform(), env = process.env): BrowserExecutable | null {
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
  const marker = new URL(initialUrl);
  marker.hash = `upwho-${randomUUID()}`;
  const markerUrl = marker.toString();
  const pagePromise = context.waitForEvent("page", {
    predicate: (page) => page.url() === markerUrl,
    timeout: BACKGROUND_TAB_READY_TIMEOUT_MS,
  });
  const cdp = await browser.newBrowserCDPSession();

  try {
    await cdp.send("Target.createTarget", { url: markerUrl, background: true });
    return context.pages().find((page) => page.url() === markerUrl) ?? await pagePromise;
  } catch (error) {
    void pagePromise.catch(() => {});
    throw error;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

export async function openFeed(feedKey: FeedKey = "best-matches", query?: string, { cdpUrl = process.env.UPWHO_CDP_URL || DEFAULT_CDP_URL } = {}): Promise<FeedSession> {
  const selection = selectionFor(feedKey, query);
  await ensureCdp(cdpUrl);

  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 15_000 });
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close();
    throw new Error("The CDP browser has no usable browser context");
  }
  const page = await newBackgroundPage(browser, context, selection.url);
  let detailToken: string | null = null;
  const pendingHeaderReads = new Set<Promise<void>>();
  const captureRequest = (request: { url(): string; headers(): Record<string, string>; allHeaders(): Promise<Record<string, string>> }) => {
    if (!request.url().includes(DETAIL_REQUEST) || detailToken) return;
    detailToken = bearerFromHeaders(request.headers());
    if (detailToken) return;
    const read = request.allHeaders().then((headers) => {
      detailToken ||= bearerFromHeaders(headers);
    }).catch(() => {});
    pendingHeaderReads.add(read);
    void read.finally(() => pendingHeaderReads.delete(read));
  };
  page.on("request", captureRequest);

  try {
    const loaded = await loadFeed(page, feedKey, selection);
    await clickTilesUntilToken(page, () => detailToken);
    if (!detailToken && feedKey !== "best-matches") {
      const fallbackSelection = selectionFor("best-matches", undefined);
      await loadFeed(page, "best-matches", fallbackSelection);
      await clickTilesUntilToken(page, () => detailToken);
    }
    await Promise.allSettled([...pendingHeaderReads]);
    if (!detailToken) throw new Error("The feed loaded, but Upwork did not expose a job-details bearer token through the clicked job tile");
    return { browser, page, browserName: await browserName(), selection, ...loaded, token: detailToken };
  } catch (error) {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
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

export async function fetchJobDetails(session: FeedSession, ciphertext: string): Promise<unknown> {
  const response = await session.page.evaluate(
    async ({ query, token, ciphertext: jobCiphertext, tenantId }): Promise<DetailFetchResult> => {
      const result = await fetch("/api/graphql/v1?alias=gql-query-get-auth-job-details-v2", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Authorization: token,
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
    { query: DETAIL_QUERY, token: session.token, ciphertext, tenantId: UPWORK_TENANT_ID }
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

export interface PublicJobAttachment {
  fileName: string;
  uri: string;
}

export interface PublicJob {
  description: string;
  attachments: PublicJobAttachment[];
}

function parsePublicJobHtml(html: string): PublicJob | null {
  if (!html.includes("__NUXT_DATA__")) return null;
  const attachments: PublicJobAttachment[] = [];
  const attachmentPattern = /href="(\/att\/download\/[^\"]+)"[^>]*>(?:<!--[^>]*-->)*\s*([^<(]{1,140}?)\s*\(/g;
  for (const match of html.matchAll(attachmentPattern)) {
    const uri = match[1]?.trim();
    const fileName = match[2]?.trim();
    if (uri && fileName) attachments.push({ uri, fileName });
  }

  const script = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!script?.[1]) return null;
  let values: unknown;
  try {
    values = JSON.parse(script[1]);
  } catch (error) {
    throw new Error("Public job Nuxt state was not valid JSON", { cause: error });
  }
  const description = Array.isArray(values)
    ? values.filter((value): value is string => typeof value === "string" && /\s/.test(value)).sort((left, right) => right.length - left.length)[0] || ""
    : "";
  return { description: description.slice(0, 5_000), attachments };
}

export async function fetchPublicJob(page: Page, ciphertext: string): Promise<PublicJob | null> {
  const path = `/jobs/${ciphertext}`;
  const htmlResponse = await page.evaluate(async (requestPath) => {
    const response = await fetch(requestPath, { credentials: "include" });
    return { status: response.status, html: await response.text() };
  }, path);
  if (htmlResponse.status === 200) {
    const parsed = parsePublicJobHtml(htmlResponse.html);
    if (parsed) return parsed;
  }

  await page.goto(`https://www.upwork.com${path}`, { waitUntil: "domcontentloaded", timeout: FEED_WAIT_MS });
  for (let attempt = 0; attempt < 40; attempt++) {
    await page.waitForTimeout(400);
    const rendered = await page.evaluate(() => {
      const job = window.__NUXT__?.vuex?.jobDetails?.job;
      if (!job || typeof job.description !== "string") return null;
      const attachments = Array.isArray(job.attachments)
        ? job.attachments.flatMap((value) => {
            const item = objectValue(value);
            const fileName = textValue(item?.fileName);
            const uri = textValue(item?.uri);
            return fileName && uri ? [{ fileName, uri }] : [];
          })
        : [];
      return { description: job.description.slice(0, 5_000), attachments };
    });
    if (rendered) return rendered;
    const location = page.url();
    if (/login|signup|challenge|captcha/i.test(location)) throw new Error(`Upwork login or challenge blocked public job ${ciphertext}`);
    if (/page-not-found|sorry/i.test(location)) return null;
  }
  throw new Error(`Public job ${ciphertext} did not hydrate before timeout`);
}
