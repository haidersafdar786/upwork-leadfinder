import { readFileSync } from "node:fs";
import type { Page, Request } from "playwright";
import { UPWORK_TENANT_ID } from "./upwork-browser.ts";
import type { Identity } from "./types.ts";

const FEEDBACKS_QUERY = readFileSync(new URL("./graphql/feedbacks-query.graphql", import.meta.url), "utf8");
const PAGE_SIZE = 50;
const MAX_REVIEWS = 400;
const DAY = 86_400_000;
const UID_QUERY = "query GetTalentUid($profileUrl: String) { talentVPDAuthProfile(filter: { profileUrl: $profileUrl }) { identity { uid: id } } }";

export interface WorkHistoryEntry {
  title: string;
  jobId: string | null;
  jobCiphertext: string | null;
  freelancerCiphertext: string | null;
  access: string | null;
  freelancerName: string | null;
  startDate: string | null;
  endDate: string | null;
  reviewed: boolean;
}

export interface FreelancerReviewRecord {
  assignmentTitle: string;
  assignmentEndedOn: string | null;
  clientFirstName: string | null;
  clientLastName: string | null;
  score: number | null;
  text: string;
}

export interface RecoveredName {
  clientName: string;
  agreement: number;
  viaFreelancer: string | null;
  matchedJob: string;
  reviewTitle: string;
  freelancerId: string;
  score: number | null;
  otherNames: Array<{ name: string; count: number }>;
}

export interface NameRecoveryResult {
  match: RecoveredName | null;
  attempted: number;
  succeeded: number;
  failures: string[];
}

export function applyRecoveredName(identity: Identity, recovery: RecoveredName): Identity {
  const people = [...new Set([recovery.clientName, ...identity.people])];
  if (identity.kind === "identified") return { ...identity, name: recovery.clientName, people };
  return {
    kind: "identified",
    name: recovery.clientName,
    people,
    company: null,
    product: null,
    website: null,
    industry: null,
    confidence: "medium",
    evidenceQuote: recovery.clientName,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arrayValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function workHistoryFromRecord(input: unknown): WorkHistoryEntry[] {
  const record = objectValue(input);
  const details = objectValue(record?.details);
  const buyer = objectValue(details?.buyer);
  return arrayValue(buyer?.workHistory).flatMap((work) => {
    const job = objectValue(work.jobInfo);
    const contractor = objectValue(work.contractorInfo);
    const title = stringValue(job?.title);
    if (!title) return [];
    return [{
      title,
      jobId: stringValue(job?.id) || stringValue(job?.uid),
      jobCiphertext: stringValue(job?.ciphertext),
      freelancerCiphertext: stringValue(contractor?.ciphertext),
      access: stringValue(job?.access),
      freelancerName: stringValue(contractor?.contractorName),
      startDate: stringValue(work.startDate),
      endDate: stringValue(work.endDate),
      reviewed: isRecord(work.feedback),
    }];
  });
}

export function normalizeReviewTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

export function reviewTitlesMatch(left: string, right: string): boolean {
  const a = normalizeReviewTitle(left);
  const b = normalizeReviewTitle(right);
  return Boolean(a && a === b);
}

export function pickMatchingReview(
  reviews: readonly FreelancerReviewRecord[],
  jobTitle: string,
  jobDate: string | null
): FreelancerReviewRecord | null {
  const exact = reviews.filter((review) => reviewTitlesMatch(review.assignmentTitle, jobTitle));
  if (!exact.length) return null;
  const jobTimestamp = jobDate ? Date.parse(jobDate) : Number.NaN;
  if (Number.isNaN(jobTimestamp)) return exact.length === 1 ? exact[0] : null;

  let best: FreelancerReviewRecord | null = null;
  let bestDifference = Number.POSITIVE_INFINITY;
  for (const review of exact) {
    const reviewTimestamp = Date.parse(review.assignmentEndedOn || "");
    if (Number.isNaN(reviewTimestamp)) continue;
    const difference = Math.abs(reviewTimestamp - jobTimestamp);
    if (difference < bestDifference) {
      best = review;
      bestDifference = difference;
    }
  }
  if (best && bestDifference <= 180 * DAY) return best;
  return exact.length === 1 ? exact[0] : null;
}

function reviewName(review: FreelancerReviewRecord): string | null {
  const name = [review.clientFirstName, review.clientLastName].filter((value): value is string => Boolean(value)).join(" ").trim();
  return name || null;
}

function parseReview(value: unknown): FreelancerReviewRecord | null {
  const review = objectValue(value);
  const assignmentTitle = stringValue(review?.assignmentTitle);
  if (!assignmentTitle) return null;
  return {
    assignmentTitle,
    assignmentEndedOn: stringValue(review?.assignmentEndedOn),
    clientFirstName: stringValue(review?.clientFirstName),
    clientLastName: stringValue(review?.clientLastName),
    score: numberValue(review?.score),
    text: stringValue(review?.text) || "",
  };
}

async function captureProfileToken(page: Page, seeds: string[]): Promise<string | null> {
  let token: string | null = null;
  const pending = new Set<Promise<void>>();
  const capture = (request: Request) => {
    if (token || !request.url().includes("alias=getDetails")) return;
    const read = request.allHeaders().then((headers) => {
      const authorization = Object.entries(headers).find(([key]) => key.toLowerCase() === "authorization")?.[1] || "";
      if (/^bearer\s+\S+$/i.test(authorization)) token = authorization;
    }).catch(() => {});
    pending.add(read);
    void read.finally(() => pending.delete(read));
  };
  page.on("request", capture);
  try {
    for (const ciphertext of seeds) {
      if (token) break;
      await page.goto(`https://www.upwork.com/freelancers/${ciphertext}`, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
      for (let attempt = 0; attempt < 30 && !token; attempt++) await page.waitForTimeout(300);
    }
    await Promise.allSettled([...pending]);
    return token;
  } finally {
    page.off("request", capture);
  }
}

async function resolveFreelancerId(page: Page, ciphertext: string, token: string): Promise<string | null> {
  const response = await page.evaluate(async ({ query, profileUrl, authorization, tenantId }) => {
    const result = await fetch("/api/graphql/v1?alias=getDetails", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Authorization: authorization, "X-Upwork-API-TenantId": tenantId },
      body: JSON.stringify({ query, variables: { profileUrl } }),
    });
    return { status: result.status, text: await result.text() };
  }, { query: UID_QUERY, profileUrl: ciphertext, authorization: token, tenantId: UPWORK_TENANT_ID });
  if (response.status !== 200) throw new Error(`freelancer profile lookup failed with HTTP ${response.status}`);
  let payload: unknown;
  try {
    payload = JSON.parse(response.text);
  } catch (error) {
    throw new Error("freelancer profile lookup returned malformed JSON", { cause: error });
  }
  const body = objectValue(payload);
  const errors = body?.errors;
  if (Array.isArray(errors) && errors.length) throw new Error(`freelancer profile GraphQL error: ${JSON.stringify(errors[0]).slice(0, 300)}`);
  const data = objectValue(body?.data);
  const profile = objectValue(data?.talentVPDAuthProfile);
  const identity = objectValue(profile?.identity);
  return stringValue(identity?.uid) || stringValue(identity?.id);
}

async function fetchFreelancerReviews(page: Page, token: string, freelancerId: string, jobTitle: string): Promise<FreelancerReviewRecord[]> {
  const reviews: FreelancerReviewRecord[] = [];
  for (let pageNumber = 1; reviews.length < MAX_REVIEWS; pageNumber++) {
    const response = await page.evaluate(async ({ query, authorization, freelancerId: id, pageNumber: after, pageSize, tenantId }) => {
      const result = await fetch("/api/graphql/v1?alias=store/reviews/fetchFeedbacks", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Authorization: authorization, "X-Upwork-API-TenantId": tenantId },
        body: JSON.stringify({ query, variables: { freelancerId: id, filter: { pagination: { after: String(after), first: pageSize }, sortBy: "DATE", sortDirection: "DESC", fetchPersons: true } } }),
      });
      return { status: result.status, text: await result.text() };
    }, { query: FEEDBACKS_QUERY, authorization: token, freelancerId, pageNumber, pageSize: PAGE_SIZE, tenantId: UPWORK_TENANT_ID });
    if (response.status !== 200) throw new Error(`freelancer review fetch failed with HTTP ${response.status}`);

    let payload: unknown;
    try {
      payload = JSON.parse(response.text);
    } catch (error) {
      throw new Error("freelancer review response was malformed JSON", { cause: error });
    }
    const body = objectValue(payload);
    const errors = body?.errors;
    if (Array.isArray(errors) && errors.length) throw new Error(`freelancer review GraphQL error: ${JSON.stringify(errors[0]).slice(0, 300)}`);
    const data = objectValue(body?.data);
    const feedbacks = objectValue(data?.freelancerFeedBacks);
    if (!feedbacks) throw new Error("freelancer review response omitted freelancerFeedBacks");
    const items = Array.isArray(feedbacks.feedbacks)
      ? feedbacks.feedbacks.flatMap((value) => {
          const parsed = parseReview(value);
          return parsed ? [parsed] : [];
        })
      : [];
    reviews.push(...items);
    if (items.some((review) => reviewTitlesMatch(review.assignmentTitle, jobTitle))) break;
    const totalItems = typeof feedbacks.totalItems === "number" ? feedbacks.totalItems : null;
    if ((totalItems !== null && reviews.length >= totalItems) || items.length < PAGE_SIZE) break;
  }
  return reviews;
}

function uniqueCandidates(workHistory: WorkHistoryEntry[], reviewed: boolean, limit: number): WorkHistoryEntry[] {
  const seen = new Set<string>();
  return workHistory.filter((work) => {
    if (!work.freelancerCiphertext || !work.title || work.reviewed !== reviewed || seen.has(work.freelancerCiphertext)) return false;
    seen.add(work.freelancerCiphertext);
    return true;
  }).slice(0, limit);
}

export async function recoverClientName(
  page: Page,
  workHistory: readonly WorkHistoryEntry[],
  { maxReviewed = 8, maxFallback = 3 }: { maxReviewed?: number; maxFallback?: number } = {}
): Promise<NameRecoveryResult> {
  const reviewed = uniqueCandidates([...workHistory], true, maxReviewed);
  const fallback = uniqueCandidates([...workHistory], false, maxFallback);
  const seeds = [...reviewed, ...fallback].flatMap((work) => work.freelancerCiphertext ? [work.freelancerCiphertext] : []);
  if (!seeds.length) return { match: null, attempted: 0, succeeded: 0, failures: [] };
  const token = await captureProfileToken(page, seeds);
  if (!token) return { match: null, attempted: 0, succeeded: 0, failures: ["Could not capture a freelancer profile bearer token"] };

  const votes = new Map<string, { name: string; count: number; hit: { work: WorkHistoryEntry; review: FreelancerReviewRecord; freelancerId: string } }>();
  const failures: string[] = [];
  let attempted = 0;
  let succeeded = 0;

  const probe = async (work: WorkHistoryEntry): Promise<boolean> => {
    attempted++;
    try {
      const freelancerId = await resolveFreelancerId(page, work.freelancerCiphertext || "", token);
      if (!freelancerId) {
        succeeded++;
        return false;
      }
      const reviews = await fetchFreelancerReviews(page, token, freelancerId, work.title);
      const review = pickMatchingReview(reviews, work.title, work.endDate || work.startDate);
      const name = review && reviewName(review);
      succeeded++;
      if (!review || !name) return false;
      const key = name.toLowerCase();
      const previous = votes.get(key);
      if (previous) previous.count++;
      else votes.set(key, { name, count: 1, hit: { work, review, freelancerId } });
      return true;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const probeList = async (candidates: WorkHistoryEntry[]) => {
    for (const work of candidates) {
      await probe(work);
      const leader = [...votes.values()].sort((left, right) => right.count - left.count)[0];
      if (leader?.count && leader.count >= 2) return;
    }
  };

  await probeList(reviewed);
  if (!votes.size) await probeList(fallback);
  const leader = [...votes.values()].sort((left, right) => right.count - left.count)[0];
  if (!leader) return { match: null, attempted, succeeded, failures };
  return {
    match: {
      clientName: leader.name,
      agreement: leader.count,
      viaFreelancer: leader.hit.work.freelancerName,
      matchedJob: leader.hit.work.title,
      reviewTitle: leader.hit.review.assignmentTitle,
      freelancerId: leader.hit.freelancerId,
      score: leader.hit.review.score,
      otherNames: [...votes.values()].filter((vote) => vote.name !== leader.name).map((vote) => ({ name: vote.name, count: vote.count })),
    },
    attempted,
    succeeded,
    failures,
  };
}
