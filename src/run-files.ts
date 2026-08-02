import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FeedJob, FeedSelection, RunResult } from "./types.ts";
import type { AttachmentFailureRecord, AttachmentTextRecord } from "./attachments.ts";

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

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function feedLabel(selection: FeedSelection): string {
  if (selection.kind !== "search") return selection.kind;
  const query = selection.query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
  return `search_${query || "query"}`;
}

function timestamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)}_${iso.slice(11, 19).replaceAll(":", "")}${iso.slice(20, 23)}`;
}

export async function createRunFolder(selection: FeedSelection, root = "runs", now = new Date()): Promise<string> {
  await mkdir(root, { recursive: true });
  const base = join(root, `${timestamp(now)}_${feedLabel(selection)}`);
  let directory = base;
  for (let suffix = 2; ; suffix++) {
    try {
      await mkdir(directory, { recursive: false });
      await mkdir(join(directory, "data"), { recursive: false });
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
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return path;
}

export async function writeRunResult(runDirectory: string, result: RunResult): Promise<string> {
  const path = join(runDirectory, "result.json");
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return path;
}

export async function readRunResult(runDirectory: string): Promise<RunResult | null> {
  try {
    return JSON.parse(await readFile(join(runDirectory, "result.json"), "utf8")) as RunResult;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
