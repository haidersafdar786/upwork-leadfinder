import type { Page } from "playwright";
import { attachmentUrl, downloadAttachment, extractText, type AttachmentTextRecord } from "./attachments.ts";
import { fetchPublicJobState, fetchRenderedPublicJob, type PublicJob, type PublicJobRead } from "./upwork-browser.ts";
import { workHistoryFromRecord, type WorkHistoryEntry } from "./reviews.ts";
import { checkpoint, rethrowCancellation } from "./cancellation.ts";
import { parseConfig } from "./config.ts";
import { isOpenCodeProviderStopped } from "./opencode.ts";

const MAX_PAST_JOB_TEXT = 12_000;
export interface PastJobTextRecord {
  ciphertext: string;
  title: string;
  description: string;
  attachments: AttachmentTextRecord[];
}

export interface PastJobResearch {
  items: PastJobTextRecord[];
  failures: string[];
  attempted: number;
}

function jobTimestamp(work: WorkHistoryEntry): number {
  const parsed = Date.parse(work.endDate || work.startDate || "");
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

// The ends of the history provide the most useful identity and current-work evidence.
export const DEFAULT_NEWEST_PAST_JOBS = 4;
export const DEFAULT_OLDEST_PAST_JOBS = 4;

export function selectedPublicJobs(
  workHistory: readonly WorkHistoryEntry[],
  { newest = DEFAULT_NEWEST_PAST_JOBS, oldest = DEFAULT_OLDEST_PAST_JOBS }: { newest?: number; oldest?: number } = {}
): WorkHistoryEntry[] {
  const seen = new Set<string>();
  const ordered = [...workHistory].sort((left, right) => jobTimestamp(right) - jobTimestamp(left)).filter((work) => {
    if (work.access !== "PUBLIC_INDEX" || !work.jobCiphertext || seen.has(work.jobCiphertext)) return false;
    seen.add(work.jobCiphertext);
    return true;
  });
  const head = Math.max(0, newest);
  const tail = Math.max(0, oldest);
  if (ordered.length <= head + tail) return head + tail > 0 ? ordered : [];
  return [...ordered.slice(0, head), ...(tail > 0 ? ordered.slice(ordered.length - tail) : [])];
}

export const CHALLENGE_FAILURE = "Upwork served a bot challenge and rendering the page did not clear it";
export const NAVIGATION_LIMIT_FAILURE = "not read: this run's rendered-page budget for past jobs was spent";

// -1 keeps every rendered fallback; nonnegative values bound the slow path.
export function navigationLimitFromEnvironment(raw: string | number | undefined = parseConfig().pastJobNavigations): number {
  if (raw === undefined) return -1;
  const trimmed = String(raw).trim();
  if (!trimmed) return -1;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= -1 ? parsed : -1;
}

interface FetchOutcome {
  job: PublicJob | null;
  challenged: boolean;
  navigated: boolean;
  error: string | null;
}

function countNavigations(outcomes: readonly FetchOutcome[]): number {
  return outcomes.filter((outcome) => outcome.navigated).length;
}

async function mapConcurrently<Item, Value>(
  items: readonly Item[],
  concurrency: number,
  work: (item: Item, index: number) => Promise<Value>,
): Promise<Value[]> {
  const results = new Array<Value>(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      checkpoint();
      const index = next++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      results[index] = await work(item, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length || 1) }, worker));
  return results;
}

async function attempt<Value>(work: () => Promise<Value>): Promise<{ value: Value | null; error: string | null }> {
  try {
    return { value: await work(), error: null };
  } catch (error) {
    rethrowCancellation(error);
    if (isOpenCodeProviderStopped(error)) throw error;
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function gatherPastJobs(
  page: Page,
  record: unknown,
  {
    newest = DEFAULT_NEWEST_PAST_JOBS,
    oldest = DEFAULT_OLDEST_PAST_JOBS,
    ocrModel = parseConfig().opencodeOcrModel,
    concurrency = parseConfig().pastJobConcurrency,
    navigationLimit = navigationLimitFromEnvironment(),
  }: { newest?: number; oldest?: number; ocrModel?: string | null; concurrency?: number; navigationLimit?: number } = {}
): Promise<PastJobResearch> {
  const candidates = selectedPublicJobs(workHistoryFromRecord(record), { newest, oldest })
    .flatMap((job) => job.jobCiphertext ? [{ job, ciphertext: job.jobCiphertext }] : []);

  const fetched: FetchOutcome[] = candidates.map(() => ({ job: null, challenged: false, navigated: false, error: null }));

  // In-page reads can overlap; rendered fallbacks cannot because navigation owns the page.
  const readAll = async (only: (outcome: FetchOutcome, index: number) => boolean): Promise<void> => {
    const pending = candidates.flatMap((candidate, index) => {
      const outcome = fetched[index];
      return outcome && only(outcome, index) ? [{ candidate, index, outcome }] : [];
    });
    await mapConcurrently(pending, concurrency, async ({ candidate, outcome }) => {
      const read = await attempt<PublicJobRead>(() => fetchPublicJobState(page, candidate.ciphertext));
      outcome.job = read.value?.kind === "job" ? read.value.job : null;
      outcome.challenged = read.value?.kind === "challenged";
      outcome.error = read.error;
    });
  };
  await readAll(() => true);

  let retriedAfterNavigation = false;
  for (const [index, candidate] of candidates.entries()) {
    const outcome = fetched[index];
    // Treat read errors like challenges and give them the rendered fallback.
    if (!outcome || outcome.job || outcome.navigated) continue;
    if (navigationLimit >= 0 && countNavigations(fetched) >= navigationLimit) {
      outcome.error = outcome.challenged ? CHALLENGE_FAILURE : NAVIGATION_LIMIT_FAILURE;
      continue;
    }
    outcome.navigated = true;
    const rendered = await attempt(() => fetchRenderedPublicJob(page, candidate.ciphertext));
    outcome.job = rendered.value;
    outcome.error = rendered.error;
    if (retriedAfterNavigation) continue;
    retriedAfterNavigation = true;
    const navigationError = outcome.error;
    await readAll((other) => !other.job && (other === outcome || !other.navigated));
    if (!outcome.job && !outcome.error) outcome.error = navigationError;
  }

  const collected = await mapConcurrently(candidates, concurrency, async ({ job, ciphertext }, index) => {
    const outcome = fetched[index];
    const failures = outcome?.error ? [`${ciphertext}: ${outcome.error}`] : [];
    const publicJob = outcome?.job;
    if (!publicJob) return { item: null, failures };
    const extracted = await mapConcurrently(publicJob.attachments, concurrency, async (attachment) => {
      const result = await attempt(async () => {
        return extractText(await downloadAttachment(page, attachmentUrl(attachment.uri)), attachment.fileName, ocrModel);
      });
      if (result.error) return { text: null, failure: `${ciphertext}/${attachment.fileName}: ${result.error}` };
      return { text: result.value ? { fileName: attachment.fileName, chars: result.value.length, text: result.value.slice(0, MAX_PAST_JOB_TEXT) } : null, failure: null };
    });
    const attachments = extracted.flatMap((item): AttachmentTextRecord[] => item.text ? [item.text] : []);
    const description = publicJob.description.replace(/\s+/g, " ").trim().slice(0, 3_000);
    return {
      item: description || attachments.length ? { ciphertext, title: job.title, description, attachments } : null,
      failures: [...failures, ...extracted.flatMap((item) => item.failure ? [item.failure] : [])],
    };
  });

  return {
    items: collected.flatMap((entry) => entry.item ? [entry.item] : []),
    failures: collected.flatMap((entry) => entry.failures),
    attempted: candidates.length,
  };
}
