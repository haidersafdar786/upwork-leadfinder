type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type BuyerId = Brand<string, "BuyerId">;
export type JobId = Brand<string, "JobId">;
export type FreelancerId = Brand<string, "FreelancerId">;
export type RunId = Brand<string, "RunId">;
export type HttpUrl = Brand<string, "HttpUrl">;
export type IsoDate = Brand<string, "IsoDate">;
export type EmailAddress = Brand<string, "EmailAddress">;
export type PhoneNumber = Brand<string, "PhoneNumber">;

export const SEARCH_JOB_TYPES = ["hourly", "fixed-price"] as const;
export type SearchJobType = typeof SEARCH_JOB_TYPES[number];

export const SEARCH_EXPERIENCE_LEVELS = ["entry-level", "intermediate", "expert"] as const;
export type SearchExperienceLevel = typeof SEARCH_EXPERIENCE_LEVELS[number];

export const SEARCH_CLIENT_HIRE_RANGES = ["0-1", "1-9", "10+"] as const;
export type SearchClientHireRange = typeof SEARCH_CLIENT_HIRE_RANGES[number];

export const SEARCH_WORKLOADS = ["as-needed", "part-time", "full-time"] as const;
export type SearchWorkload = typeof SEARCH_WORKLOADS[number];

export const SEARCH_DURATIONS = ["less-than-1-month", "1-to-3-months", "3-to-6-months", "more-than-6-months"] as const;
export type SearchDuration = typeof SEARCH_DURATIONS[number];

export const SEARCH_PROPOSAL_RANGES = ["0-4", "5-9", "10-15", "15-20", "20-50", "50+"] as const;
export type SearchProposalRange = typeof SEARCH_PROPOSAL_RANGES[number];

export const SEARCH_SORTS = ["relevance+desc", "recency+desc", "client_total_charge+desc", "client_rating+desc"] as const;
export type SearchSort = typeof SEARCH_SORTS[number];

export interface SearchFilters {
  allWords?: string;
  anyWords?: string;
  exactPhrase?: string;
  excludeWords?: string;
  title?: string;
  skills?: string;
  jobTypes?: SearchJobType[];
  experienceLevels?: SearchExperienceLevel[];
  clientHires?: SearchClientHireRange[];
  workloads?: SearchWorkload[];
  durations?: SearchDuration[];
  proposals?: SearchProposalRange[];
  locations?: string[];
  page?: number;
  perPage?: number;
  daysPosted?: number;
  paymentVerified?: boolean;
  enterpriseOnly?: boolean;
  sort?: SearchSort;
}

export type FeedSelection =
  | { kind: "best-matches"; url: HttpUrl }
  | { kind: "most-recent"; url: HttpUrl }
  | { kind: "my-feed"; url: HttpUrl }
  | { kind: "saved"; url: HttpUrl }
  | { kind: "search"; url: HttpUrl; query: string; filters: SearchFilters }
  | { kind: "job"; url: HttpUrl; jobUrl: HttpUrl };

export interface FeedJob {
  selection: FeedSelection;
  id: JobId;
  ciphertext: string;
  url: HttpUrl;
  title: string;
  description: string;
  publishedAt: IsoDate | null;
  clientCountry: string | null;
}

export interface Attachment {
  fileName: string;
  url: HttpUrl;
  text:
    | { kind: "extracted"; value: string; method: "native" | "ocr" }
    | { kind: "unavailable"; reason: "unsupported" | "tool-missing" | "ocr-disabled" };
}

export interface Review {
  text: string;
  score: number | null;
  endedAt: IsoDate | null;
}

export interface FreelancerRef {
  name: string | null;
  profileCiphertext: string | null;
  id: FreelancerId | null;
}

export type ContractAccess = "public" | "private" | "unknown";

export interface PastContract {
  jobId: JobId | null;
  ciphertext: string | null;
  title: string;
  access: ContractAccess;
  startDate: IsoDate | null;
  endDate: IsoDate | null;
  freelancer: FreelancerRef;
  reviewFromClient: Review | null;
  reviewToClient: Review | null;
}

export interface FreelancerSideReview extends Review {
  assignmentTitle: string;
  clientName: string | null;
  freelancerId: FreelancerId;
}

export interface PastJobEvidence {
  ciphertext: string;
  title: string;
  description: string;
  attachments: Array<{ fileName: string; text: string }>;
}

export interface JobDetails {
  description: string;
  buyerCountry: string | null;
  buyerIndustry: string | null;
  workHistory: PastContract[];
  pastJobs: PastJobEvidence[];
}

export interface Job {
  feed: FeedJob;
  buyerId: BuyerId;
  details: JobDetails;
  attachments: Attachment[];
}

export type Evidence =
  | {
      source: "description";
      buyerId: BuyerId;
      jobId: JobId;
      text: string;
    }
  | {
      source: "attachment";
      buyerId: BuyerId;
      jobId: JobId;
      fileName: string;
      text: string;
    }
  | {
      source: "client-review";
      buyerId: BuyerId;
      jobId: JobId | null;
      contractTitle: string;
      text: string;
    }
  | {
      source: "past-job";
      buyerId: BuyerId;
      jobId: JobId | null;
      title: string;
      text: string;
    }
  | {
      source: "freelancer-side-review";
      buyerId: BuyerId;
      jobId: JobId | null;
      freelancerId: FreelancerId;
      title: string;
      text: string;
    };

export type Identity =
  | {
      kind: "identified";
      status: "verified" | "possible";
      name: string | null;
      people: string[];
      company: string | null;
      product: string | null;
      website: HttpUrl | null;
      industry: string | null;
      evidenceStrength: "high" | "medium" | "low";
      evidenceQuote: string;
      evidenceSource: IdentityEvidenceSource;
      evidenceSourceId: string;
      claimEvidence: IdentityClaimEvidenceSet;
    }
  | {
      kind: "unknown";
      status: "unknown";
      name: null;
      people: string[];
      company: null;
      product: null;
      website: null;
      industry: null;
      evidenceStrength: "none";
      evidenceQuote: null;
      evidenceSource: null;
      evidenceSourceId: null;
      claimEvidence: IdentityClaimEvidenceSet;
    };

export type IdentityEvidenceSource = "description" | "attachment" | "sibling-job" | "past-job" | "review-to-client" | "past-title" | "job-title";

export interface IdentityClaimEvidence {
  value: string;
  quote: string;
  source: IdentityEvidenceSource;
  sourceId: string;
}

export interface IdentityClaimEvidenceSet {
  name: IdentityClaimEvidence | null;
  company: IdentityClaimEvidence | null;
  product: IdentityClaimEvidence | null;
  website: IdentityClaimEvidence | null;
  industry: IdentityClaimEvidence | null;
}

export function identityStatus(identity: Identity): IdentityStatus {
  return identity.status;
}

export type IdentityStatus = "verified" | "possible" | "unknown";

export interface SupportingLink {
  url: HttpUrl;
  title: string;
}

export interface PublicWebEvidence {
  title: string;
  url: HttpUrl;
  snippet: string;
  source: "websearch" | "webfetch";
  query: string | null;
  fetchedFrom: HttpUrl | null;
}

export interface ContactDetails {
  emails: EmailAddress[];
  phones: PhoneNumber[];
  whatsApp: HttpUrl[];
}

export interface WebPresence extends ContactDetails {
  personLinkedIn: HttpUrl | null;
  companyLinkedIn: HttpUrl | null;
  socials: HttpUrl[];
  verifiedSite: HttpUrl | null;
  supportingLinks: SupportingLink[];
}

export interface Client {
  buyerId: BuyerId;
  jobs: Job[];
  history: ClientHistory;
  evidence: Evidence[];
  identity: Identity;
  nameRecovery: NameRecoveryDiagnostics;
  webPresence: WebPresence;
  webEvidence: PublicWebEvidence[];
}

interface NameRecoveryAttempt {
  attempted: number;
  succeeded: number;
  failures: string[];
}

export type NameRecoveryDiagnostics =
  | NameRecoveryAttempt & {
      kind: "matched";
      clientName: string;
      agreement: number;
      matchedJob: string;
      reviewTitle: string;
    }
  | NameRecoveryAttempt & {
      kind: "not-found";
    };

export interface ClientHistory {
  totalSpent: number | null;
  totalHires: number | null;
  totalReviews: number | null;
  rating: number | null;
}

export interface RunResult {
  runId: RunId;
  feed: FeedSelection;
  startedAt: IsoDate;
  completedAt: IsoDate;
  clients: Client[];
}

export type ClientPhase = "gather-evidence" | "identify" | "recover-name" | "enrich" | "write";

export type ProgressEvent =
  | { kind: "feed-loaded"; feed: FeedSelection; jobCount: number }
  | { kind: "job-skipped"; jobId: JobId; reason: "country" | "processed" }
  | { kind: "job-failed"; jobId: JobId; message: string }
  | {
      kind: "client-progress";
      buyerId: BuyerId;
      phase: ClientPhase;
      completedClients: number;
      totalClients: number;
    }
  | { kind: "client-completed"; client: Client }
  | { kind: "client-failed"; buyerId: BuyerId; message: string }
  | { kind: "run-completed"; result: RunResult }
  | { kind: "run-cancelled" }
  | { kind: "run-failed"; message: string };

export type ProgressCallback = (event: ProgressEvent) => void | Promise<void>;
