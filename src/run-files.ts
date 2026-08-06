import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { FeedJob, FeedSelection, HttpUrl, Identity, IdentityClaimEvidence, IdentityClaimEvidenceSet, IdentityEvidenceSource, RunResult } from "./types.ts";
import type { AttachmentFailureRecord, AttachmentTextRecord } from "./attachments.ts";
import type { Client, IsoDate, RunId, SearchFilters } from "./types.ts";

export interface RawJobRecord {
  uid: string;
  ciphertext: string;
  title: string;
  url: string;
  scrapedAt: string;
  feed: Record<string, unknown>;
  details: unknown;
  attachmentsText: AttachmentTextRecord[];
  siblingJobs: [];
  attachmentFailures?: AttachmentFailureRecord[];
}

export interface RunManifest {
  version: 1;
  status: "complete";
  runId: RunId;
  feed: FeedSelection;
  startedAt: IsoDate;
  completedAt: IsoDate;
  resultFile: "result.json";
  dataFileCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is IsoDate {
  return isText(value) && Number.isFinite(Date.parse(value));
}

function isSearchFilters(value: unknown): value is SearchFilters {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    "allWords", "anyWords", "exactPhrase", "excludeWords", "title", "skills", "jobTypes", "experienceLevels",
    "clientHires", "workloads", "durations", "proposals", "locations", "daysPosted", "paymentVerified", "enterpriseOnly", "sort",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  for (const key of ["allWords", "anyWords", "exactPhrase", "excludeWords", "title", "skills", "sort"]) {
    if (value[key] !== undefined && !isText(value[key])) return false;
  }
  for (const key of ["jobTypes", "experienceLevels", "clientHires", "workloads", "durations", "proposals", "locations"]) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some((item) => !isText(item)))) return false;
  }
  if (value.daysPosted !== undefined && (typeof value.daysPosted !== "number" || !Number.isInteger(value.daysPosted))) return false;
  return (value.paymentVerified === undefined || typeof value.paymentVerified === "boolean")
    && (value.enterpriseOnly === undefined || typeof value.enterpriseOnly === "boolean");
}

function isUpworkUrl(value: unknown): value is string {
  return isText(value) && /^https:\/\/www\.upwork\.com\//.test(value);
}

function isFeedSelection(value: unknown): value is FeedSelection {
  if (!isRecord(value) || !isUpworkUrl(value.url)) return false;
  if (["best-matches", "most-recent", "my-feed", "saved"].includes(String(value.kind))) return true;
  if (value.kind === "search") return isText(value.query) && isSearchFilters(value.filters);
  return value.kind === "job" && isUpworkUrl(value.jobUrl) && value.url === value.jobUrl;
}

function isIdentitySource(value: unknown): value is IdentityEvidenceSource {
  return ["description", "attachment", "sibling-job", "past-job", "review-to-client", "past-title", "job-title"].includes(String(value));
}

function isClaimEvidenceSet(value: unknown): value is IdentityClaimEvidenceSet {
  if (!isRecord(value)) return false;
  for (const field of ["name", "company", "product", "website", "industry"]) {
    const claim = value[field];
    if (claim === null) continue;
    if (!isRecord(claim) || !isText(claim.value) || !isText(claim.quote) || !isIdentitySource(claim.source) || !isText(claim.sourceId)) return false;
  }
  return true;
}

function isIdentity(value: unknown): value is Identity {
  if (!isRecord(value)) return false;
  if (value.kind === "unknown") {
    return value.status === "unknown"
      && value.evidenceStrength === "none"
      && value.evidenceQuote === null
      && value.evidenceSource === null
      && value.evidenceSourceId === null
      && isClaimEvidenceSet(value.claimEvidence);
  }
  return value.kind === "identified"
    && (value.status === "verified" || value.status === "possible")
    && ["high", "medium", "low"].includes(String(value.evidenceStrength))
    && isText(value.evidenceQuote)
    && isIdentitySource(value.evidenceSource)
    && isText(value.evidenceSourceId)
    && isClaimEvidenceSet(value.claimEvidence);
}

function isClient(value: unknown): value is Client {
  if (!isRecord(value)) return false;
  return isText(value.buyerId)
    && Array.isArray(value.jobs)
    && isRecord(value.history)
    && Array.isArray(value.evidence)
    && isIdentity(value.identity)
    && isRecord(value.nameRecovery)
    && Array.isArray(value.webEvidence)
    && isRecord(value.webPresence);
}

function unknownIdentity(): Identity {
  return {
    kind: "unknown",
    status: "unknown",
    name: null,
    people: [],
    company: null,
    product: null,
    website: null,
    industry: null,
    evidenceStrength: "none",
    evidenceQuote: null,
    evidenceSource: null,
    evidenceSourceId: null,
    claimEvidence: { name: null, company: null, product: null, website: null, industry: null },
  };
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function legacyHttpUrl(value: unknown): HttpUrl | null {
  if (!isText(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value as HttpUrl : null;
  } catch {
    return null;
  }
}

interface LegacyEvidenceSource {
  source: IdentityEvidenceSource;
  sourceId: string;
  text: string;
}

function legacyEvidenceSources(value: unknown): LegacyEvidenceSource[] {
  if (!Array.isArray(value)) return [];
  const sourceMap: Record<string, IdentityEvidenceSource> = {
    description: "description",
    attachment: "attachment",
    "client-review": "review-to-client",
    "past-job": "past-job",
  };
  return value.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const source = typeof item.source === "string" ? sourceMap[item.source] : undefined;
    const text = isText(item.text) ? item.text : null;
    if (!source || !text) return [];
    const sourceId = `legacy-evidence-${index + 1}`;
    return [{ source, sourceId, text }];
  });
}

function sourceContains(source: string, value: string): boolean {
  return compact(source).toLocaleLowerCase().includes(compact(value).toLocaleLowerCase());
}

function legacyClaimQuote(source: LegacyEvidenceSource, value: string, preferredQuote: string | null): string | null {
  if (preferredQuote && source.text.includes(preferredQuote) && sourceContains(preferredQuote, value)) return preferredQuote;
  const sourceIndex = source.text.toLocaleLowerCase().indexOf(value.toLocaleLowerCase());
  if (sourceIndex < 0) return null;
  const start = Math.max(0, sourceIndex - 120);
  const end = Math.min(source.text.length, sourceIndex + value.length + 120);
  return source.text.slice(start, end).trim();
}

function legacyEvidenceClaim(
  value: string | null,
  sources: readonly LegacyEvidenceSource[],
  preferredQuote: string | null,
): IdentityClaimEvidence | null {
  if (!value) return null;
  const ordered = [...sources].sort((left, right) => {
    const leftPreferred = preferredQuote && sourceContains(left.text, preferredQuote) ? 1 : 0;
    const rightPreferred = preferredQuote && sourceContains(right.text, preferredQuote) ? 1 : 0;
    return rightPreferred - leftPreferred;
  });
  for (const source of ordered) {
    if (!sourceContains(source.text, value)) continue;
    const quote = legacyClaimQuote(source, value, preferredQuote);
    if (quote) return { value, quote, source: source.source, sourceId: source.sourceId };
  }
  return null;
}

function legacyIdentity(value: unknown, evidence: unknown): Identity {
  const raw = isRecord(value) ? value : null;
  if (!raw || raw.kind === "unknown") return unknownIdentity();
  const sources = legacyEvidenceSources(evidence);
  const preferredQuote = isText(raw.evidenceQuote) ? raw.evidenceQuote : null;
  const claims: IdentityClaimEvidenceSet = {
    name: legacyEvidenceClaim(isText(raw.name) ? raw.name : null, sources, preferredQuote),
    company: legacyEvidenceClaim(isText(raw.company) ? raw.company : null, sources, preferredQuote),
    product: legacyEvidenceClaim(isText(raw.product) ? raw.product : null, sources, preferredQuote),
    website: legacyEvidenceClaim(legacyHttpUrl(raw.website), sources, preferredQuote),
    industry: legacyEvidenceClaim(isText(raw.industry) ? raw.industry : null, sources, preferredQuote),
  };
  const primary = claims.name || claims.company || claims.product || claims.website || claims.industry;
  if (!primary) return unknownIdentity();
  const strength = raw.evidenceStrength || raw.confidence;
  const evidenceStrength = strength === "high" || strength === "medium" || strength === "low" ? strength : "low";
  return {
    kind: "identified",
    status: "possible",
    name: claims.name?.value || null,
    people: claims.name ? [claims.name.value] : [],
    company: claims.company?.value || null,
    product: claims.product?.value || null,
    website: claims.website ? claims.website.value as HttpUrl : null,
    industry: claims.industry?.value || null,
    evidenceStrength,
    evidenceQuote: primary.quote,
    evidenceSource: primary.source,
    evidenceSourceId: primary.sourceId,
    claimEvidence: claims,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => isText(item)) : [];
}

function legacyWebPresence(value: unknown): Client["webPresence"] {
  const raw = isRecord(value) ? value : {};
  const links = Array.isArray(raw.supportingLinks)
    ? raw.supportingLinks.flatMap((item) => {
      if (!isRecord(item) || !isText(item.url) || !isText(item.title)) return [];
      return [{ url: item.url as HttpUrl, title: item.title }];
    })
    : [];
  return {
    personLinkedIn: isText(raw.personLinkedIn) ? raw.personLinkedIn as HttpUrl : null,
    companyLinkedIn: isText(raw.companyLinkedIn) ? raw.companyLinkedIn as HttpUrl : null,
    verifiedSite: isText(raw.verifiedSite) ? raw.verifiedSite as HttpUrl : null,
    socials: stringArray(raw.socials) as HttpUrl[],
    emails: stringArray(raw.emails) as Client["webPresence"]["emails"],
    phones: stringArray(raw.phones) as Client["webPresence"]["phones"],
    whatsApp: stringArray(raw.whatsApp) as Client["webPresence"]["whatsApp"],
    supportingLinks: links,
  };
}

function legacyNameRecovery(value: unknown): Client["nameRecovery"] {
  if (!isRecord(value)) return { kind: "not-found", attempted: 0, succeeded: 0, failures: [] };
  if (value.kind === "matched" && isText(value.clientName) && isText(value.matchedJob) && isText(value.reviewTitle)) {
    return {
      kind: "matched",
      clientName: value.clientName,
      agreement: typeof value.agreement === "number" ? value.agreement : 0,
      matchedJob: value.matchedJob,
      reviewTitle: value.reviewTitle,
      attempted: typeof value.attempted === "number" ? value.attempted : 0,
      succeeded: typeof value.succeeded === "number" ? value.succeeded : 0,
      failures: stringArray(value.failures),
    };
  }
  return {
    kind: "not-found",
    attempted: typeof value.attempted === "number" ? value.attempted : 0,
    succeeded: typeof value.succeeded === "number" ? value.succeeded : 0,
    failures: stringArray(value.failures),
  };
}

function legacyClient(value: unknown): Client | null {
  if (!isRecord(value) || !isText(value.buyerId)) return null;
  const evidence = Array.isArray(value.evidence) ? value.evidence : [];
  return {
    buyerId: value.buyerId as Client["buyerId"],
    jobs: Array.isArray(value.jobs) ? value.jobs as Client["jobs"] : [],
    history: isRecord(value.history) ? value.history as unknown as Client["history"] : { totalSpent: null, totalHires: null, totalReviews: null, rating: null },
    evidence: evidence as Client["evidence"],
    identity: legacyIdentity(value.identity, evidence),
    nameRecovery: legacyNameRecovery(value.nameRecovery),
    webPresence: legacyWebPresence(value.webPresence),
    webEvidence: Array.isArray(value.webEvidence) ? value.webEvidence as Client["webEvidence"] : [],
  };
}

function legacyFeed(value: unknown): FeedSelection | null {
  if (!isRecord(value)) return null;
  const candidate = value.kind === "search" && value.filters === undefined ? { ...value, filters: {} } : value;
  return isFeedSelection(candidate) ? candidate : null;
}

function isLegacyResultShape(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !Array.isArray(value.clients)) return false;
  const feed = isRecord(value.feed) ? value.feed : null;
  if (feed?.kind === "search" && feed.filters === undefined) return true;
  return value.clients.some((client) => {
    const identity = isRecord(client) && isRecord(client.identity) ? client.identity : null;
    return Boolean(identity && (identity.confidence !== undefined || identity.status === undefined || identity.claimEvidence === undefined));
  });
}

function normalizeLegacyResult(value: unknown): RunResult | null {
  if (!isRecord(value) || !isText(value.runId) || !isIsoDate(value.startedAt) || !isIsoDate(value.completedAt) || !Array.isArray(value.clients)) return null;
  const feed = legacyFeed(value.feed);
  if (!feed) return null;
  const clients = value.clients.map(legacyClient);
  if (clients.some((client): client is null => client === null)) return null;
  const result = {
    runId: value.runId as RunId,
    feed,
    startedAt: value.startedAt as IsoDate,
    completedAt: value.completedAt as IsoDate,
    clients: clients as Client[],
  };
  try {
    return RunResultSchema.parse(result);
  } catch {
    return null;
  }
}

const RunIdSchema = z.custom<RunId>((value) => isText(value));
const IsoDateSchema = z.custom<IsoDate>((value) => isIsoDate(value));
const FeedSelectionSchema = z.custom<FeedSelection>((value) => isFeedSelection(value));
const ClientSchema = z.custom<Client>((value) => isClient(value));

export const RunResultSchema = z.object({
  runId: RunIdSchema,
  feed: FeedSelectionSchema,
  startedAt: IsoDateSchema,
  completedAt: IsoDateSchema,
  clients: z.array(ClientSchema),
}).strict();

const RunManifestSchema = z.object({
  version: z.literal(1),
  status: z.literal("complete"),
  runId: RunIdSchema,
  feed: FeedSelectionSchema,
  startedAt: IsoDateSchema,
  completedAt: IsoDateSchema,
  resultFile: z.literal("result.json"),
  dataFileCount: z.number().int().nonnegative(),
}).strict();

interface LockOwner {
  pid: number;
  token: string;
  createdAt: string;
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

function warnUnreadableRun(runDirectory: string): void {
  process.stderr.write(`[upwho] ignoring unreadable or incomplete run: ${runDirectory}\n`);
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function countDataFiles(runDirectory: string): Promise<number> {
  try {
    const entries = await readdir(join(runDirectory, "data"), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return 0;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

export interface RunLock {
  release(): Promise<void>;
}

export async function acquireRunRootLock(root = "runs"): Promise<RunLock> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = join(root, ".upwho.lock");
  const ownerPath = join(directory, "owner.json");
  const token = randomUUID();
  const owner: LockOwner = { pid: process.pid, token, createdAt: new Date().toISOString() };
  for (;;) {
    try {
      await mkdir(directory, { recursive: false, mode: 0o700 });
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      let existing: LockOwner | null = null;
      try {
        const parsed: unknown = JSON.parse(await readFile(ownerPath, "utf8"));
        if (isRecord(parsed) && typeof parsed.pid === "number" && typeof parsed.token === "string" && typeof parsed.createdAt === "string") {
          existing = { pid: parsed.pid, token: parsed.token, createdAt: parsed.createdAt };
        }
      } catch {
        throw new Error(`Run root ${root} is locked by another process`);
      }
      if (!existing || processIsAlive(existing.pid)) throw new Error(`Run root ${root} is locked by process ${existing?.pid || "another"}`);
      await rm(directory, { recursive: true, force: false });
    }
  }
  try {
    await atomicWrite(ownerPath, `${JSON.stringify(owner)}\n`);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        const parsed: unknown = JSON.parse(await readFile(ownerPath, "utf8"));
        if (!isRecord(parsed) || parsed.token !== token || parsed.pid !== process.pid) return;
      } catch {
        return;
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function feedLabel(selection: FeedSelection): string {
  if (selection.kind === "job") return "job";
  if (selection.kind !== "search") return selection.kind;
  const query = selection.query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
  return `search_${query || "query"}`;
}

function timestamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)}_${iso.slice(11, 19).replaceAll(":", "")}${iso.slice(20, 23)}`;
}

export function wellFormedJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "string" ? item.toWellFormed() : item, 2);
}

export async function createRunFolder(selection: FeedSelection, root = "runs", now = new Date()): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const base = join(root, `${timestamp(now)}_${feedLabel(selection)}`);
  let directory = base;
  for (let suffix = 2; ; suffix++) {
    try {
      await mkdir(directory, { recursive: false, mode: 0o700 });
      await mkdir(join(directory, "data"), { recursive: false, mode: 0o700 });
      return directory;
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
      directory = `${base}_${suffix}`;
    }
  }
}

export async function writeRawJobRecord(
  runDirectory: string,
  job: FeedJob,
  rawFeed: Record<string, unknown>,
  details: unknown,
  attachmentsText: AttachmentTextRecord[],
  attachmentFailures: AttachmentFailureRecord[] = [],
  scrapedAt = new Date().toISOString()
): Promise<string> {
  const record: RawJobRecord = {
    uid: job.id,
    ciphertext: job.ciphertext,
    title: stripHtml(job.title),
    url: job.url,
    scrapedAt,
    feed: rawFeed,
    details,
    attachmentsText,
    siblingJobs: [],
    ...(attachmentFailures.length ? { attachmentFailures } : {}),
  };
  const path = join(runDirectory, "data", `${job.id}.json`);
  await atomicWrite(path, `${wellFormedJson(record)}\n`);
  return path;
}

export async function writeRunResult(runDirectory: string, result: RunResult): Promise<string> {
  const path = join(runDirectory, "result.json");
  RunResultSchema.parse(result);
  await atomicWrite(path, `${wellFormedJson(result)}\n`);
  const manifest: RunManifest = {
    version: 1,
    status: "complete",
    runId: result.runId,
    feed: result.feed,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    resultFile: "result.json",
    dataFileCount: await countDataFiles(runDirectory),
  };
  await atomicWrite(join(runDirectory, "manifest.json"), `${wellFormedJson(manifest)}\n`);
  return path;
}

export async function readRunResult(runDirectory: string): Promise<RunResult | null> {
  let manifest: RunManifest | null;
  try {
    manifest = await readRunManifest(runDirectory);
  } catch {
    warnUnreadableRun(runDirectory);
    return null;
  }
  if (manifest) {
    try {
      const result = RunResultSchema.parse(JSON.parse(await readFile(join(runDirectory, manifest.resultFile), "utf8")));
      const dataFileCount = await countDataFiles(runDirectory);
      if (
        result.runId !== manifest.runId
        || result.feed.kind !== manifest.feed.kind
        || result.startedAt !== manifest.startedAt
        || result.completedAt !== manifest.completedAt
        || JSON.stringify(result.feed) !== JSON.stringify(manifest.feed)
        || dataFileCount !== manifest.dataFileCount
      ) {
        warnUnreadableRun(runDirectory);
        return null;
      }
      return result;
    } catch {
      warnUnreadableRun(runDirectory);
      return null;
    }
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(runDirectory, "result.json"), "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    warnUnreadableRun(runDirectory);
    return null;
  }
  if (!isLegacyResultShape(raw)) {
    if (isRecord(raw) && Array.isArray(raw.clients) && raw.clients.length === 0 && await countDataFiles(runDirectory) === 0) {
      return normalizeLegacyResult(raw);
    }
    return null;
  }
  const result = normalizeLegacyResult(raw);
  if (!result) warnUnreadableRun(runDirectory);
  return result;
}

export async function readRunManifest(runDirectory: string): Promise<RunManifest | null> {
  try {
    return RunManifestSchema.parse(JSON.parse(await readFile(join(runDirectory, "manifest.json"), "utf8")));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}
