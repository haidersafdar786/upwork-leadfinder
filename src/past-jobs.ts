import type { Page } from "playwright";
import { attachmentUrl, downloadAttachment, extractText, type AttachmentTextRecord } from "./attachments.ts";
import { fetchPublicJob } from "./upwork-browser.ts";
import { workHistoryFromRecord, type WorkHistoryEntry } from "./reviews.ts";

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

export function selectedPublicJobs(workHistory: readonly WorkHistoryEntry[], limit = 50): WorkHistoryEntry[] {
  const seen = new Set<string>();
  return [...workHistory].sort((left, right) => jobTimestamp(right) - jobTimestamp(left)).filter((work) => {
    if (work.access !== "PUBLIC_INDEX" || !work.jobCiphertext || seen.has(work.jobCiphertext)) return false;
    seen.add(work.jobCiphertext);
    return true;
  }).slice(0, Math.max(0, limit));
}

export async function gatherPastJobs(
  page: Page,
  record: unknown,
  { limit = 50, ocrModel = process.env.OPENCODE_OCR_MODEL || null }: { limit?: number; ocrModel?: string | null } = {}
): Promise<PastJobResearch> {
  const candidates = selectedPublicJobs(workHistoryFromRecord(record), limit);
  const items: PastJobTextRecord[] = [];
  const failures: string[] = [];
  let attempted = 0;

  for (const job of candidates) {
    attempted++;
    const ciphertext = job.jobCiphertext;
    if (!ciphertext) continue;
    let fetched;
    try {
      fetched = await fetchPublicJob(page, ciphertext);
    } catch (error) {
      failures.push(`${ciphertext}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!fetched) continue;

    const attachments: AttachmentTextRecord[] = [];
    for (const attachment of fetched.attachments) {
      try {
        const text = await extractText(await downloadAttachment(page, attachmentUrl(attachment.uri)), attachment.fileName, ocrModel);
        if (text) attachments.push({ fileName: attachment.fileName, chars: text.length, text: text.slice(0, MAX_PAST_JOB_TEXT) });
      } catch (error) {
        failures.push(`${ciphertext}/${attachment.fileName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const description = fetched.description.replace(/\s+/g, " ").trim().slice(0, 3_000);
    if (description || attachments.length) items.push({ ciphertext, title: job.title, description, attachments });
  }
  return { items, failures, attempted };
}
