type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type BuyerId = Brand<string, "BuyerId">;
export type JobId = Brand<string, "JobId">;
export type FreelancerId = Brand<string, "FreelancerId">;
export type RunId = Brand<string, "RunId">;
export type HttpUrl = Brand<string, "HttpUrl">;
export type IsoDate = Brand<string, "IsoDate">;

export type FeedSelection =
  | { kind: "best-matches"; url: HttpUrl }
  | { kind: "most-recent"; url: HttpUrl }
  | { kind: "my-feed"; url: HttpUrl }
  | { kind: "saved"; url: HttpUrl }
  | { kind: "search"; url: HttpUrl; query: string };

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
      name: string | null;
      people: string[];
      company: string | null;
      product: string | null;
      website: HttpUrl | null;
      industry: string | null;
      confidence: "high" | "medium" | "low";
      evidenceQuote: string;
    }
  | {
      kind: "unknown";
      name: null;
      people: string[];
      company: null;
      product: null;
      website: null;
      industry: null;
      confidence: "unknown";
      evidenceQuote: null;
    };

export interface SupportingLink {
  url: HttpUrl;
  title: string;
}

export interface WebPresence {
  personLinkedIn: HttpUrl | null;
  companyLinkedIn: HttpUrl | null;
  socials: HttpUrl[];
  verifiedSite: HttpUrl | null;
  supportingLinks: SupportingLink[];
}

export interface Client {
  buyerId: BuyerId;
  jobs: Job[];
  evidence: Evidence[];
  identity: Identity;
  webPresence: WebPresence;
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
  | { kind: "run-failed"; message: string };

export type ProgressCallback = (event: ProgressEvent) => void | Promise<void>;
