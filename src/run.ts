import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  attachmentMetadata,
  attachmentUrl,
  collectAttachmentTexts,
  type AttachmentFailureRecord,
  type AttachmentTextRecord,
} from "./attachments.ts";
import { clientHistoryFromRecord } from "./client-history.ts";
import { checkpoint, currentCancellationSignal, rethrowCancellation } from "./cancellation.ts";
import { enrichClient, emptyWebPresence, evidenceSupportingPresence } from "./enrichment.ts";
import { identifyRecord } from "./identity-model.ts";
import { gatherPastJobs, selectedPublicJobs, type PastJobResearch, type PastJobTextRecord } from "./past-jobs.ts";
import {
  applyRecoveredName,
  recoverClientName,
  workHistoryFromRecord,
  type NameRecoveryResult,
  type RecoveredName,
  type WorkHistoryEntry,
} from "./reviews.ts";
import {
  createRunFolder,
  readRunResult,
  writeRawJobRecord,
  writeRunResult,
  type RawJobRecord,
} from "./run-files.ts";
import { ResearchPagePool } from "./research-pages.ts";
import {
  closeFeed,
  fetchJobDetails,
  openFeed,
  type FeedKey,
  type FeedSession,
} from "./upwork-browser.ts";
import type {
  Attachment,
  BuyerId,
  Client,
  ContractAccess,
  Evidence,
  FeedJob,
  FeedSelection,
  FreelancerId,
  HttpUrl,
  Identity,
  IsoDate,
  Job,
  JobDetails,
  JobId,
  NameRecoveryDiagnostics,
  PastContract,
  Review,
  RunId,
  RunResult,
  ProgressCallback,
  ProgressEvent,
} from "./types.ts";

export const DEFAULT_COUNTRY_SKIP = ["India", "Israel", "Pakistan", "Bangladesh", "Philippines", "Ukraine", "Kenya", "Nigeria"] as const;
export const DEFAULT_CLIENT_CONCURRENCY = 8;
export const DEFAULT_RESEARCH_CONCURRENCY = 3;
const MAX_CLIENT_CONCURRENCY = 8;

export interface RunOptions {
  root?: string;
  countries?: readonly string[];
  force?: boolean;
  useModel?: boolean;
  detailConcurrency?: number;
  clientConcurrency?: number;
  researchConcurrency?: number;
  onlyJobIds?: readonly string[];
  onlyBuyerId?: string;
}

export interface RunFailure {
  jobId: string;
  message: string;
}

interface JobFetchFailure extends RunFailure {
  jobId: JobId;
}

export function detailFetchFailure({
  selectedJobs,
  fetchedRecords,
  failures,
}: {
  selectedJobs: number;
  fetchedRecords: number;
  failures: readonly RunFailure[];
}): Error | null {
  if (selectedJobs === 0 || fetchedRecords > 0) return null;
  const firstError = failures[0]?.message;
  return new Error(`All ${selectedJobs} selected job detail requests failed.${firstError ? ` First error: ${firstError}` : ""}`);
}

export interface RunExecution {
  runDirectory: string;
  result: RunResult;
  failures: RunFailure[];
}

interface LoadedRecord {
  job: FeedJob;
  rawFeed: Record<string, unknown>;
  details: unknown;
  attachmentsText: AttachmentTextRecord[];
  attachmentFailures: AttachmentFailureRecord[];
  buyerId?: BuyerId;
}

const noopProgress: ProgressCallback = () => {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function at(value: unknown, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function isoDate(value: unknown): IsoDate | null {
  const text = textValue(value);
  return text && Number.isFinite(Date.parse(text)) ? text as IsoDate : null;
}

function jobId(value: unknown): JobId | null {
  const text = textValue(value);
  return text && /^\d+$/.test(text) ? text as JobId : null;
}

function buyerId(value: unknown, fallback: JobId): BuyerId {
  const companyId = textValue(at(value, "buyer", "info", "company", "companyId"));
  return (companyId || `unknown-${fallback}`) as BuyerId;
}

function freelancerId(value: unknown): FreelancerId {
  return String(value) as FreelancerId;
}

function buyerCountry(details: unknown, job: FeedJob): string | null {
  return textValue(at(details, "buyer", "info", "location", "country")) || job.clientCountry;
}

function jobDescription(details: unknown, job: FeedJob): string {
  return textValue(at(details, "opening", "job", "description")) || job.description || "";
}

function contractAccess(value: unknown): ContractAccess {
  const access = textValue(value)?.toUpperCase();
  if (access === "PUBLIC_INDEX") return "public";
  if (access === "PRIVATE") return "private";
  return "unknown";
}

function review(value: unknown, endedAt: IsoDate | null): Review | null {
  const object = objectValue(value);
  const text = textValue(object?.comment);
  const score = numberValue(object?.score);
  if (!text && score === null) return null;
  return { text: text || "", score, endedAt };
}

function contracts(details: unknown): PastContract[] {
  return arrayRecords(at(details, "buyer", "workHistory")).flatMap((work) => {
    const job = objectValue(work.jobInfo);
    const contractor = objectValue(work.contractorInfo);
    const title = textValue(job?.title);
    if (!title) return [];
    const endDate = isoDate(work.endDate);
    const freelancerCiphertext = textValue(contractor?.ciphertext);
    return [{
      jobId: jobId(job?.id) || jobId(job?.uid),
      ciphertext: textValue(job?.ciphertext),
      title,
      access: contractAccess(job?.access),
      startDate: isoDate(work.startDate),
      endDate,
      freelancer: {
        name: textValue(contractor?.contractorName),
        profileCiphertext: freelancerCiphertext,
        id: null,
      },
      reviewFromClient: review(work.feedback, endDate),
      reviewToClient: review(work.feedbackToClient, endDate),
    } satisfies PastContract];
  });
}

function attachmentModel(details: unknown, texts: readonly AttachmentTextRecord[]): Attachment[] {
  const textByName = new Map(texts.map((item) => [item.fileName, item.text]));
  return attachmentMetadata(details).map((metadata) => {
    const text = textByName.get(metadata.fileName) || "";
    return {
      fileName: metadata.fileName,
      url: attachmentUrl(metadata.uri),
      text: text
        ? { kind: "extracted", value: text, method: "native" }
        : { kind: "unavailable", reason: "unsupported" },
    } satisfies Attachment;
  });
}

function pastJobEvidence(items: readonly PastJobTextRecord[]): JobDetails["pastJobs"] {
  return items.map((item) => ({
    ciphertext: item.ciphertext,
    title: item.title,
    description: item.description,
    attachments: item.attachments.map((attachment) => ({ fileName: attachment.fileName, text: attachment.text })),
  }));
}

function jobModel(record: LoadedRecord, pastJobs: readonly PastJobTextRecord[]): Job {
  const details: JobDetails = {
    description: jobDescription(record.details, record.job),
    buyerCountry: buyerCountry(record.details, record.job),
    buyerIndustry: textValue(at(record.details, "buyer", "info", "company", "profile", "industry")),
    workHistory: contracts(record.details),
    pastJobs: pastJobEvidence(pastJobs),
  };
  return {
    feed: record.job,
    buyerId: record.buyerId || buyerId(record.details, record.job.id),
    details,
    attachments: attachmentModel(record.details, record.attachmentsText),
  };
}

function aggregateRecord(records: readonly LoadedRecord[], pastJobs: readonly PastJobTextRecord[]): Record<string, unknown> {
  const first = records[0];
  const siblingJobs = records.slice(1).map((record) => {
    const attachmentText = record.attachmentsText.map((item) => `${item.fileName}\n${item.text}`).join("\n");
    return { title: record.job.title, description: [jobDescription(record.details, record.job), attachmentText].filter(Boolean).join("\n\n") };
  });
  return {
    uid: first.job.id,
    ciphertext: first.job.ciphertext,
    title: first.job.title,
    description: jobDescription(first.details, first.job),
    url: first.job.url,
    scrapedAt: new Date().toISOString(),
    feed: first.rawFeed,
    details: first.details,
    attachmentsText: first.attachmentsText,
    siblingJobs,
    pastJobsText: pastJobs,
  };
}

function jobIdForCiphertext(details: unknown): Map<string, JobId> {
  const result = new Map<string, JobId>();
  for (const work of arrayRecords(at(details, "buyer", "workHistory"))) {
    const job = objectValue(work.jobInfo);
    const ciphertext = textValue(job?.ciphertext);
    const id = jobId(job?.id) || jobId(job?.uid);
    if (ciphertext && id) result.set(ciphertext, id);
  }
  return result;
}

function evidenceFor(
  buyer: BuyerId,
  records: readonly LoadedRecord[],
  pastJobs: readonly PastJobTextRecord[],
  recovery: RecoveredName | null,
): Evidence[] {
  const evidence: Evidence[] = [];
  for (const record of records) {
    const description = jobDescription(record.details, record.job);
    if (description) evidence.push({ source: "description", buyerId: buyer, jobId: record.job.id, text: description });
    for (const attachment of record.attachmentsText) {
      if (attachment.text) evidence.push({ source: "attachment", buyerId: buyer, jobId: record.job.id, fileName: attachment.fileName, text: attachment.text });
    }
    for (const work of arrayRecords(at(record.details, "buyer", "workHistory"))) {
      const job = objectValue(work.jobInfo);
      const title = textValue(job?.title);
      const text = textValue(at(work, "feedbackToClient", "comment"));
      if (title && text) evidence.push({ source: "client-review", buyerId: buyer, jobId: jobId(job?.id) || jobId(job?.uid), contractTitle: title, text });
    }
  }
  const pastIds = jobIdForCiphertext(records[0]?.details);
  for (const past of pastJobs) {
    const text = [past.title, past.description, ...past.attachments.map((item) => `${item.fileName}: ${item.text}`)].filter(Boolean).join("\n");
    if (text) evidence.push({ source: "past-job", buyerId: buyer, jobId: pastIds.get(past.ciphertext) || null, title: past.title, text });
  }
  if (recovery) evidence.push({
    source: "freelancer-side-review",
    buyerId: buyer,
    jobId: null,
    freelancerId: freelancerId(recovery.freelancerId),
    title: recovery.reviewTitle,
    text: recovery.clientName,
  });
  return evidence;
}

function unknownIdentity(): Identity {
  return { kind: "unknown", name: null, people: [], company: null, product: null, website: null, industry: null, confidence: "unknown", evidenceQuote: null };
}

export function clientWorkerCount(requested: number | undefined, totalClients: number): number {
  const concurrency = requested ?? DEFAULT_CLIENT_CONCURRENCY;
  return Math.min(Math.max(1, concurrency), MAX_CLIENT_CONCURRENCY, totalClients || 1);
}

export function researchPageCount(requested: number | undefined, totalClients: number): number {
  const concurrency = requested ?? DEFAULT_RESEARCH_CONCURRENCY;
  return Math.min(Math.max(1, concurrency), MAX_CLIENT_CONCURRENCY, totalClients || 1);
}

export function browserResearchNeeded(workHistory: readonly WorkHistoryEntry[]): boolean {
  return selectedPublicJobs(workHistory).length > 0
    || workHistory.some((work) => Boolean(work.freelancerCiphertext));
}

function nameRecoveryDiagnostics(result: NameRecoveryResult): NameRecoveryDiagnostics {
  const shared = { attempted: result.attempted, succeeded: result.succeeded, failures: result.failures };
  if (!result.match) return { kind: "not-found", ...shared };
  return {
    kind: "matched",
    ...shared,
    clientName: result.match.clientName,
    agreement: result.match.agreement,
    matchedJob: result.match.matchedJob,
    reviewTitle: result.match.reviewTitle,
  };
}

function normalizedSet(values: readonly string[]): Set<string> {
  return new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function rawAttachmentRecords(value: unknown): AttachmentTextRecord[] {
  return arrayRecords(value).flatMap((item) => {
    const fileName = textValue(item.fileName);
    const text = typeof item.text === "string" ? item.text : null;
    if (!fileName || text === null) return [];
    return [{ fileName, chars: numberValue(item.chars) || text.length, text }];
  });
}

function rawFailureRecords(value: unknown): AttachmentFailureRecord[] {
  return arrayRecords(value).flatMap((item) => {
    const fileName = textValue(item.fileName);
    const error = textValue(item.error);
    return fileName && error ? [{ fileName, error }] : [];
  });
}

async function processedJobIds(root: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let directories;
  try {
    directories = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return ids;
    throw error;
  }
  for (const directory of directories.filter((entry) => entry.isDirectory())) {
    let files;
    try {
      files = await readdir(join(root, directory.name, "data"), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))) {
      try {
        const value: unknown = JSON.parse(await readFile(join(root, directory.name, "data", file.name), "utf8"));
        const uid = textValue(at(value, "uid"));
        if (uid) ids.add(uid);
      } catch {
        // A partially written or unrelated file should not prevent a new run.
      }
    }
  }
  return ids;
}

async function fetchRecords(session: FeedSession, jobs: readonly FeedJob[], runDirectory: string, concurrency: number): Promise<{ records: LoadedRecord[]; failures: JobFetchFailure[] }> {
  const rawById = new Map(session.jobs.map((job, index) => [job.id, session.rawJobs[index]]));
  const records: LoadedRecord[] = [];
  const failures: JobFetchFailure[] = [];
  let next = 0;
  const worker = async () => {
    while (true) {
      checkpoint();
      const recordIndex = next++;
      const job = jobs[recordIndex];
      if (!job) return;
      const rawFeed = rawById.get(job.id);
      if (!rawFeed) {
        failures.push({ jobId: job.id, message: "Feed job had no preserved raw state" });
        continue;
      }
      try {
        const details = await fetchJobDetails(session, job.ciphertext);
        const attachments = await collectAttachmentTexts(session.page, details);
        await writeRawJobRecord(runDirectory, job, rawFeed, details, attachments.items, attachments.failures);
        records.push({ job, rawFeed, details, attachmentsText: attachments.items, attachmentFailures: attachments.failures, buyerId: buyerId(details, job.id) });
      } catch (error) {
        rethrowCancellation(error);
        failures.push({ jobId: job.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), jobs.length || 1) }, () => worker()));
  const order = new Map(jobs.map((job, index) => [job.id, index]));
  records.sort((left, right) => (order.get(left.job.id) || 0) - (order.get(right.job.id) || 0));
  return { records, failures };
}

async function report(progress: ProgressCallback, event: ProgressEvent): Promise<void> {
  await progress(event);
}

async function processRecords(
  session: FeedSession,
  runDirectory: string,
  records: readonly LoadedRecord[],
  options: RunOptions,
  progress: ProgressCallback,
  { publishClients = true }: { publishClients?: boolean } = {},
): Promise<{ clients: Client[]; failures: RunFailure[] }> {
  const grouped = new Map<BuyerId, LoadedRecord[]>();
  for (const record of records) {
    const id = record.buyerId || buyerId(record.details, record.job.id);
    const group = grouped.get(id) || [];
    group.push({ ...record, buyerId: id });
    grouped.set(id, group);
  }
  const entries = [...grouped.entries()].filter(([id]) => !options.onlyBuyerId || id === options.onlyBuyerId);
  const clients: Client[] = [];
  const failures: RunFailure[] = [];
  let next = 0;
  let completed = 0;
  const researchPages = new ResearchPagePool({
    browser: session.browser,
    context: session.context,
    initialUrl: session.selection.url,
    capacity: researchPageCount(options.researchConcurrency, entries.length),
  });
  const worker = async () => {
    while (true) {
      checkpoint();
      const itemIndex = next++;
      const item = entries[itemIndex];
      if (!item) return;
      const [buyer, clientRecords] = item;
      try {
        await report(progress, { kind: "client-progress", buyerId: buyer, phase: "gather-evidence", completedClients: completed, totalClients: entries.length });
        const aggregate = aggregateRecord(clientRecords, []);
        const workHistory = workHistoryFromRecord(aggregate);
        const needsBrowserResearch = browserResearchNeeded(workHistory);
        let past: PastJobResearch = { items: [], failures: [], attempted: 0 };
        let recoveryResult: NameRecoveryResult = { match: null, attempted: 0, succeeded: 0, failures: [] };
        if (needsBrowserResearch) {
          const lease = await researchPages.acquire();
          try {
            try {
              past = await gatherPastJobs(lease.page, aggregate);
            } catch (error) {
              rethrowCancellation(error);
              past.failures.push(error instanceof Error ? error.message : String(error));
            }
            await report(progress, { kind: "client-progress", buyerId: buyer, phase: "recover-name", completedClients: completed, totalClients: entries.length });
            try {
              recoveryResult = await recoverClientName(lease.page, workHistory);
            } catch (error) {
              rethrowCancellation(error);
              recoveryResult.failures.push(error instanceof Error ? error.message : String(error));
            }
          } finally {
            await lease.release();
          }
        } else {
          await report(progress, { kind: "client-progress", buyerId: buyer, phase: "recover-name", completedClients: completed, totalClients: entries.length });
        }
        const recovery = recoveryResult.match;
        const nameRecovery = nameRecoveryDiagnostics(recoveryResult);

        const recordForIdentity = aggregateRecord(clientRecords, past.items);
        await report(progress, { kind: "client-progress", buyerId: buyer, phase: "identify", completedClients: completed, totalClients: entries.length });
        const identified = await identifyRecord(recordForIdentity, { useModel: options.useModel !== false });
        if (identified.error) throw new Error(`Identity analysis failed: ${identified.error}`);
        const identity = recovery ? applyRecoveredName(identified.identity, recovery) : identified.identity;

        const jobs = clientRecords.map((record) => jobModel(record, past.items));
        const evidence = evidenceFor(buyer, clientRecords, past.items, recovery);
        const history = clientHistoryFromRecord({ feed: clientRecords[0]?.rawFeed, details: clientRecords[0]?.details });
        const client: Client = { buyerId: buyer, jobs, history, evidence, identity, nameRecovery, webPresence: emptyWebPresence(), webEvidence: [] };
        await report(progress, { kind: "client-progress", buyerId: buyer, phase: "enrich", completedClients: completed, totalClients: entries.length });
        const evidenceBackedWebsite = identity.kind === "identified" ? identity.website : null;
        try {
          const research = await enrichClient(client);
          const presence = research.presence;
          const verifiedSite = presence.verifiedSite || evidenceBackedWebsite;
          client.webPresence = { ...presence, verifiedSite };
          client.webEvidence = evidenceSupportingPresence(research.evidence, client.webPresence);
        } catch (error) {
          rethrowCancellation(error);
          past.failures.push(error instanceof Error ? error.message : String(error));
          client.webPresence = { ...client.webPresence, verifiedSite: evidenceBackedWebsite };
        }
        checkpoint();
        await report(progress, { kind: "client-progress", buyerId: buyer, phase: "write", completedClients: completed, totalClients: entries.length });
        clients.push(client);
        for (const message of past.failures) failures.push({ jobId: clientRecords[0]?.job.id || String(buyer), message });
        completed++;
        if (publishClients) await report(progress, { kind: "client-completed", client });
      } catch (error) {
        rethrowCancellation(error);
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ jobId: clientRecords[0]?.job.id || String(buyer), message });
        await report(progress, { kind: "client-failed", buyerId: buyer, message });
      }
    }
  };
  const concurrency = clientWorkerCount(options.clientConcurrency, entries.length);
  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } finally {
    await researchPages.close();
  }
  clients.sort((left, right) => left.buyerId.localeCompare(right.buyerId));
  return { clients, failures };
}

function feedKeyFor(selection: FeedSelection): { feed: FeedKey; query?: string } {
  if (selection.kind === "search") return { feed: "search", query: selection.query };
  return { feed: selection.kind };
}

async function loadStoredRecords(runDirectory: string, client: Client): Promise<LoadedRecord[]> {
  const records: LoadedRecord[] = [];
  for (const job of client.jobs) {
    const path = join(runDirectory, "data", `${job.feed.id}.json`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      throw new Error(`Cannot rerun buyer ${client.buyerId}: missing raw job ${job.feed.id}`, { cause: error });
    }
    if (!isRecord(parsed)) throw new Error(`Stored raw job ${job.feed.id} was not an object`);
    const rawFeed = isRecord(parsed.feed) ? parsed.feed : { ...job.feed };
    records.push({
      job: job.feed,
      rawFeed,
      details: parsed.details || job.details,
      attachmentsText: rawAttachmentRecords(parsed.attachmentsText),
      attachmentFailures: rawFailureRecords(parsed.attachmentFailures),
      buyerId: client.buyerId,
    });
  }
  return records;
}

export async function runOnce(
  feed: FeedKey = "best-matches",
  query: string | undefined = undefined,
  options: RunOptions = {},
  progress: ProgressCallback = noopProgress,
): Promise<RunExecution> {
  const startedAt = new Date().toISOString() as IsoDate;
  const root = options.root || "runs";
  const signal = currentCancellationSignal();
  let session: FeedSession | null = null;
  const cancelSession = () => { if (session) void closeFeed(session); };
  try {
    checkpoint();
    session = await openFeed(feed, query);
    signal?.addEventListener("abort", cancelSession, { once: true });
    await report(progress, { kind: "feed-loaded", feed: session.selection, jobCount: session.jobs.length });
    const runDirectory = await createRunFolder(session.selection, root);
    const skippedCountries = normalizedSet(options.countries === undefined ? DEFAULT_COUNTRY_SKIP : options.countries);
    const processed = options.force ? new Set<string>() : await processedJobIds(root);
    const requested = options.onlyJobIds ? new Set(options.onlyJobIds) : null;
    const selected: FeedJob[] = [];
    for (const job of session.jobs) {
      if (requested && !requested.has(job.id)) continue;
      if (skippedCountries.has((job.clientCountry || "").trim().toLowerCase())) {
        await report(progress, { kind: "job-skipped", jobId: job.id, reason: "country" });
        continue;
      }
      if (processed.has(job.id)) {
        await report(progress, { kind: "job-skipped", jobId: job.id, reason: "processed" });
        continue;
      }
      selected.push(job);
    }
    if (requested && !selected.length) throw new Error("None of the requested job IDs were present and eligible in the feed");
    const fetched = await fetchRecords(session, selected, runDirectory, options.detailConcurrency || 4);
    for (const failure of fetched.failures) {
      await report(progress, { kind: "job-failed", jobId: failure.jobId, message: failure.message });
    }
    const fetchFailure = detailFetchFailure({ selectedJobs: selected.length, fetchedRecords: fetched.records.length, failures: fetched.failures });
    if (fetchFailure) throw fetchFailure;
    await session.page.close().catch(() => {});
    const processedClients = await processRecords(session, runDirectory, fetched.records, options, progress);
    if (fetched.records.length && !processedClients.clients.length) {
      throw new Error(`All client processing failed (${processedClients.failures.length} recorded failures)`);
    }
    if (options.onlyBuyerId && !processedClients.clients.length) throw new Error(`Buyer ${options.onlyBuyerId} was not found in the selected feed`);
    const completedAt = new Date().toISOString() as IsoDate;
    const result: RunResult = {
      runId: basename(runDirectory) as RunId,
      feed: session.selection,
      startedAt,
      completedAt,
      clients: processedClients.clients,
    };
    checkpoint();
    await writeRunResult(runDirectory, result);
    const failures = [...fetched.failures, ...processedClients.failures];
    await report(progress, { kind: "run-completed", result });
    return { runDirectory, result, failures };
  } catch (error) {
    if (signal?.aborted) await report(progress, { kind: "run-cancelled" });
    else await report(progress, { kind: "run-failed", message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancelSession);
    if (session) await closeFeed(session);
  }
}

export function mergeRerunResult(previous: RunResult, updatedClient: Client, completedAt: IsoDate): RunResult {
  if (!previous.clients.some((client) => client.buyerId === updatedClient.buyerId)) {
    throw new Error(`Buyer ${updatedClient.buyerId} was not found in run ${previous.runId}`);
  }
  return {
    ...previous,
    completedAt,
    clients: previous.clients.map((client) => client.buyerId === updatedClient.buyerId ? updatedClient : client),
  };
}

export async function rerunClient(
  sourceRunDirectory: string,
  buyer: string,
  options: Omit<RunOptions, "root" | "onlyBuyerId" | "onlyJobIds"> = {},
  progress: ProgressCallback = noopProgress,
): Promise<RunExecution> {
  const previous = await readRunResult(sourceRunDirectory);
  if (!previous) throw new Error(`Run ${sourceRunDirectory} has no result.json`);
  const client = previous.clients.find((item) => item.buyerId === buyer);
  if (!client) throw new Error(`Buyer ${buyer} was not found in ${sourceRunDirectory}`);
  const { feed, query } = feedKeyFor(previous.feed);
  const signal = currentCancellationSignal();
  let session: FeedSession | null = null;
  const cancelSession = () => { if (session) void closeFeed(session); };
  try {
    checkpoint();
    session = await openFeed(feed, query);
    signal?.addEventListener("abort", cancelSession, { once: true });
    await report(progress, { kind: "feed-loaded", feed: session.selection, jobCount: session.jobs.length });
    const storedRecords = await loadStoredRecords(sourceRunDirectory, client);
    const records: LoadedRecord[] = [];
    for (const stored of storedRecords) {
      const refreshed = await collectAttachmentTexts(session.page, stored.details);
      const freshByName = new Map(refreshed.items.map((item) => [item.fileName, item]));
      const oldByName = new Map(stored.attachmentsText.map((item) => [item.fileName, item]));
      const attachmentsText = attachmentMetadata(stored.details).flatMap((metadata) => {
        const item = freshByName.get(metadata.fileName) || oldByName.get(metadata.fileName);
        return item ? [item] : [];
      });
      const record = { ...stored, attachmentsText, attachmentFailures: refreshed.failures };
      records.push(record);
    }
    await session.page.close().catch(() => {});
    const processed = await processRecords(session, sourceRunDirectory, records, { ...options, onlyBuyerId: buyer }, progress, { publishClients: false });
    const updatedClient = processed.clients[0];
    if (!updatedClient) throw new Error(`Buyer ${buyer} could not be rerun`);
    checkpoint();
    for (const record of records) {
      await writeRawJobRecord(sourceRunDirectory, record.job, record.rawFeed, record.details, record.attachmentsText, record.attachmentFailures);
    }
    checkpoint();
    const completedAt = new Date().toISOString() as IsoDate;
    const result = mergeRerunResult(previous, updatedClient, completedAt);
    await writeRunResult(sourceRunDirectory, result);
    await report(progress, { kind: "run-completed", result });
    return { runDirectory: sourceRunDirectory, result, failures: processed.failures };
  } catch (error) {
    if (signal?.aborted) await report(progress, { kind: "run-cancelled" });
    else await report(progress, { kind: "run-failed", message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancelSession);
    if (session) await closeFeed(session);
  }
}
