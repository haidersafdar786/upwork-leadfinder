export type IdentitySource = "description" | "attachment" | "sibling-job" | "past-job" | "review" | "past-title" | "job-title";

export interface IdentityText {
  source: IdentitySource;
  label: string;
  text: string;
}

export interface IdentitySignals {
  uid: string;
  title: string;
  url: string;
  description: string;
  location: string | null;
  texts: IdentityText[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function cleanText(value: string): string {
  return value
    .replace(/[®™©]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceText(source: IdentitySource, label: string, value: unknown): IdentityText | null {
  const text = cleanText(stringValue(value));
  return text ? { source, label, text } : null;
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function collectTexts(record: Record<string, unknown>): { title: string; description: string; texts: IdentityText[] } {
  const details = isRecord(record.details) ? record.details : {};
  const opening = isRecord(details.opening) ? details.opening : {};
  const job = isRecord(opening.job) ? opening.job : {};
  const texts: IdentityText[] = [];
  const add = (item: IdentityText | null) => {
    if (item) texts.push(item);
  };
  const title = stringValue(record.title) || stringValue(job.title);
  const description = stringValue(job.description) || stringValue(record.description);
  add(sourceText("job-title", "current job title", title));
  add(sourceText("description", "current job description", description));
  for (const attachment of arrayRecords(record.attachmentsText)) {
    add(sourceText("attachment", stringValue(attachment.fileName) || "attachment", attachment.text));
  }
  for (const sibling of arrayRecords(record.siblingJobs)) {
    const siblingTitle = stringValue(sibling.title);
    add(sourceText("sibling-job", siblingTitle || "other job", `${siblingTitle}\n${stringValue(sibling.description)}`));
  }
  for (const past of arrayRecords(record.pastJobsText)) {
    const pastTitle = stringValue(past.title);
    add(sourceText("past-job", pastTitle || "past job", `${pastTitle}\n${stringValue(past.description)}`));
    for (const attachment of arrayRecords(past.attachments)) {
      add(sourceText("past-job", stringValue(attachment.fileName) || "past attachment", attachment.text));
    }
  }

  const buyer = recordValue(details, "buyer");
  for (const work of arrayRecords(recordValue(buyer, "workHistory"))) {
    const jobInfo = recordValue(work, "jobInfo");
    const workTitle = stringValue(recordValue(jobInfo, "title"));
    add(sourceText("past-title", "past job title", workTitle));
    add(sourceText("review", "freelancer review", recordValue(recordValue(work, "feedbackToClient"), "comment")));
  }
  return { title, description, texts };
}

export function extractIdentitySignals(input: unknown): IdentitySignals {
  const record = isRecord(input) ? input : {};
  const collected = collectTexts(record);
  const details = isRecord(record.details) ? record.details : {};
  const buyer = isRecord(details.buyer) ? details.buyer : {};
  const info = isRecord(buyer.info) ? buyer.info : {};
  const location = isRecord(info.location) ? info.location : {};
  const city = stringValue(location.city);
  const country = stringValue(location.country);
  return {
    uid: stringValue(record.uid),
    title: collected.title,
    url: stringValue(record.url),
    description: collected.description,
    location: [city, country].filter(Boolean).join(", ") || null,
    texts: collected.texts,
  };
}
