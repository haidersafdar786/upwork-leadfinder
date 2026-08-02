import type { FeedJob } from "./types.ts";
import { collectAttachmentTexts } from "./attachments.ts";
import { closeFeed, fetchJobDetails, type FeedSession } from "./upwork-browser.ts";
import { createRunFolder, writeRawJobRecord } from "./run-files.ts";

export interface ReplayFailure {
  jobId: string;
  message: string;
}

export interface ReplayResult {
  runDirectory: string;
  written: number;
  failures: ReplayFailure[];
}

export async function replayFeed(
  session: FeedSession,
  { jobs = session.jobs, root = "runs", concurrency = 4 }: { jobs?: FeedJob[]; root?: string; concurrency?: number } = {}
): Promise<ReplayResult> {
  const runDirectory = await createRunFolder(session.selection, root);
  const rawByJobId = new Map(session.jobs.map((job, index) => [job.id, session.rawJobs[index]]));
  const failures: ReplayFailure[] = [];
  let next = 0;
  let written = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      const job = jobs[index];
      if (!job) return;
      const rawFeed = rawByJobId.get(job.id);
      if (!rawFeed) {
        failures.push({ jobId: job.id, message: "Feed job had no preserved raw state" });
        continue;
      }
      try {
        const details = await fetchJobDetails(session, job.ciphertext);
        const attachments = await collectAttachmentTexts(session.page, details);
        await writeRawJobRecord(runDirectory, job, rawFeed, details, attachments.items, attachments.failures);
        written++;
      } catch (error) {
        failures.push({ jobId: job.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), jobs.length || 1) }, () => worker()));
  return { runDirectory, written, failures };
}

export async function replayAndClose(
  session: FeedSession,
  options: { jobs?: FeedJob[]; root?: string; concurrency?: number } = {}
): Promise<ReplayResult> {
  try {
    return await replayFeed(session, options);
  } finally {
    await closeFeed(session);
  }
}
