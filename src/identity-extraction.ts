export type IdentitySource = "description" | "attachment" | "sibling-job" | "past-job" | "review" | "past-title" | "job-title";

export interface IdentityText {
  source: IdentitySource;
  label: string;
  text: string;
}

export interface IdentityCandidate {
  value: string;
  field: "company" | "product";
  source: IdentitySource;
  quote: string;
  confidence: "high" | "medium";
  score: number;
  ownershipScore: number;
}

export interface IdentitySignals {
  uid: string;
  title: string;
  url: string;
  description: string;
  location: string | null;
  texts: IdentityText[];
  urls: string[];
  emails: string[];
  candidates: IdentityCandidate[];
  names: string[];
}

const GENERIC_DOMAINS = new Set([
  "amazon.com", "booking.com", "bark.com", "bubble.io", "fly.io", "github.com", "gitlab.com", "google.com",
  "googleapis.com", "youtube.com", "facebook.com", "instagram.com", "linkedin.com", "tiktok.com", "x.com",
  "shopify.com", "wix.com", "wordpress.com", "squarespace.com", "supabase.com", "supabase.io", "vercel.com",
  "netlify.com", "stripe.com", "authorize.net", "figma.com", "canva.com", "openai.com", "anthropic.com",
  "claude.ai", "chatgpt.com", "lovable.dev", "replit.com", "notion.so", "airtable.com", "calendly.com",
  "zapier.com", "metricool.com", "pantone.com", "disney.com", "cal.com", "n8n.io", "provider.co", "patterns.de",
]);

const GENERIC_WORDS = new Set([
  "a", "an", "the", "our", "my", "your", "this", "that", "us", "we", "i", "mine", "company", "brand",
  "business", "startup", "store", "shop", "agency", "platform", "app", "application", "website", "site",
  "product", "project", "system", "software", "service", "services", "solution", "solutions", "tool", "portal",
  "marketplace", "saas", "technology", "technologies", "consulting", "consultancy", "development", "design",
  "graphic", "newsletter", "overview", "summary", "role", "review", "reviews", "competitor", "comparison",
  "luxury", "premium", "lifestyle", "fashion", "floral", "healthcare", "real", "estate", "finance", "fintech",
  "medical", "education", "edtech", "ai", "white", "labeled", "white-label", "mobile", "web", "social",
  "media", "communication", "customer", "client", "clients", "team", "group", "firm", "organization", "org",
  "enterprise", "enterprise", "training", "trainings", "online", "home", "personal", "professional", "ecommerce",
  "e-commerce", "operating", "engine", "engineer", "developer", "designer", "manager", "specialist", "assistant",
  "college", "intro", "quality", "assurance", "board", "vehicle", "german", "english", "spanish", "french",
  "complete", "quick", "fixes", "enhancements", "redesign", "migration", "setup", "development", "lawn", "care",
  "sponsorship", "cigar", "humidor", "humidors", "cosmetics", "magazine", "creatives", "workbook", "financial", "reporting",
  "super", "cool", "yc", "ai-native", "version", "b2b",
]);

const GENERIC_VENDORS = new Set([
  "react", "reactjs", "nextjs", "next", "node", "nodejs", "typescript", "javascript", "python", "php", "java",
  "android", "ios", "flutter", "supabase", "firebase", "vercel", "netlify", "shopify", "wix", "wordpress", "stripe",
  "figma", "canva", "claude", "anthropic", "openai", "chatgpt", "lovable", "bubble", "pagefly", "fluidengine",
  "metricool", "pantone", "disney", "amazon", "facebook", "instagram", "tiktok", "youtube", "google", "whatsapp",
  "heygen", "synthesia", "elevenlabs", "squarespace", "gsc", "ga4", "aws", "azure", "gcp", "mongodb", "mysql",
  "postgres", "postgresql", "graphql", "api", "mvp", "saas", "mine", "ai", "seo", "ui", "ux", "codex", "zohobooks",
  "weebly", "louisvuitton", "app.com", "appcom", "trigger.dev", "trigger.de", "triggerde", "woocommerce", "hunter.io", "hunterio",
  "socket.io", "socketio", "schema.org", "schemaorg", "asp.net", "aspnet", "make.com", "makecom", "ai-powered", "ai-assisted", "n8n",
  "twilio", "quickbooks", "excel", "hmrc", "b2b", "kdp", "klaviyo",
]);

const NOISE_WORDS = new Set([
  "about", "although", "am", "an", "and", "assistant", "assistants", "attached", "a", "are", "business", "card", "character",
  "client", "clients", "codebase", "communication", "concept", "contractor", "copyright", "core", "discover", "do", "entire",
  "experience", "features", "footer", "for", "full-time", "fulltime", "hiring", "in", "it", "job", "looking", "management",
  "marketing", "number", "our", "patterns", "process", "project", "provider", "recommended", "registrations", "requirements",
  "resend", "scope", "she", "someone", "starting", "support", "team", "the", "there", "this", "user", "us", "virtual", "visa",
  "we", "we're", "were", "what", "when", "which", "with", "work", "working", "you", "your", "zoho", "every", "will", "definitely",
  "be", "building", "something", "that", "genuinely", "remote", "co-owner/spouse", "scheduling", "news", "based", "mockups",
  "sports", "wellness", "hydration", "muay", "thai", "compression", "apparel", "storytelling", "travel", "photobook", "ultra-realistic",
  "content", "partnership", "long-term", "full-stack", "fulltime", "full-time", "co-owner", "spouse", "created", "by", "format",
  "him", "her", "his", "them", "again", "was", "truly", "enjoyable", "best", "thank", "thanks", "excellent", "awesome",
  "today", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "january", "february", "march", "april",
  "may", "june", "july", "august", "september", "october", "november", "december", "each", "any", "one", "all", "please",
  "really", "also", "forward", "question", "questions", "everything", "proven", "seeking", "existing", "order", "issue", "understands", "responsive",
  "fitness", "immigration", "law", "beef", "tallow", "skincare", "testimonials", "across", "multiple", "roles", "replit", "agent",
  "sales", "administration", "outreach", "custom", "code", "tasks", "sophisticated", "pet", "male", "ugc", "salaried", "shopfy", "year",
  "designer", "designers", "developer", "developers", "manager", "managers", "admin", "board", "vehicle", "german", "english", "spanish", "french",
  "redesign", "enhancements", "migration", "setup", "complete", "quick", "fixes", "lawn", "care", "sponsorship", "cigar",
  "cosmetics", "magazine", "creatives", "workbook", "financial", "reporting", "super", "cool", "quality", "assurance", "yc", "ai-native", "version",
  "administrator", "processing", "amount", "cancel", "block", "avs", "b2b",
]);

const GENERIC_PHRASE_WORDS = new Set([
  ...GENERIC_WORDS,
  "full", "stack", "front", "back", "end", "custom", "modern", "new", "growing", "leading", "national", "local",
  "global", "independent", "small", "large", "creative", "digital", "online", "cloud", "multi-tenant", "real-estate", "sports",
]);

const PLACES = new Set([
  "netherlands", "germany", "france", "spain", "italy", "portugal", "poland", "ukraine", "england", "ireland", "america",
  "usa", "canada", "mexico", "brazil", "india", "pakistan", "bangladesh", "china", "japan", "singapore", "australia",
  "europe", "asia", "scandinavia", "belgium", "austria", "switzerland", "sweden", "norway", "denmark", "finland", "israel",
  "dubai", "northcarolina", "southcarolina", "newyork", "newjersey", "newhampshire", "newmexico", "northdakota", "southdakota",
]);

const TLD = "com|io|co|ai|app|net|org|xyz|us|uk|de|fr|nl|design|studio|agency|so|me|tech|shop|store|online|cloud|digital|ca|ink|au";
const WORD = "[A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ0-9&'’/-]*";
const WORD_SEQUENCE = `${WORD}(?:\\s+${WORD}){0,3}`;

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

  const workHistory = arrayRecords(recordValue(details, "buyer") && recordValue(recordValue(details, "buyer"), "workHistory"));
  for (const work of workHistory) {
    const workTitle = stringValue(recordValue(recordValue(work, "jobInfo"), "title"));
    add(sourceText("past-title", "past job title", workTitle));
    add(sourceText("review", "freelancer review", recordValue(recordValue(work, "feedbackToClient"), "comment")));
  }
  return { title, description, texts };
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[®™©]/g, "").replace(/[^a-z0-9]+/g, "");
}

function words(value: string): string[] {
  return value.toLowerCase().replace(/[^a-z0-9À-ÿ-]+/gi, " ").split(/\s+/).filter(Boolean);
}

export function isAllowedIdentityCandidate(value: string): boolean {
  const trimmed = value.replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`,:;.!?]+$/g, "").trim();
  if (trimmed.length < 3 || trimmed.length > 80) return false;
  if (!/^[A-ZÀ-ÖØ-Ý0-9]/.test(trimmed) && !/^[a-z0-9-]+\.[a-z]{2,}$/i.test(trimmed)) return false;
  const squished = normalized(trimmed);
  if (!squished || squished.length < 3 || GENERIC_VENDORS.has(squished) || PLACES.has(squished)) return false;
  const parts = words(trimmed);
  if (!parts.length || parts.some((part) => GENERIC_VENDORS.has(part) || NOISE_WORDS.has(part))) return false;
  if (parts.length === 1 && GENERIC_WORDS.has(parts[0])) return false;
  if (parts.every((part) => GENERIC_PHRASE_WORDS.has(part))) return false;
  if (/^(?:about|overview|summary|job|role|project|title|description|requirements)$/i.test(trimmed)) return false;
  if (/^\d+$/.test(trimmed)) return false;
  return true;
}

function trimCandidate(value: string): string {
  let trimmed = value
    .replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`,:;.!?]+$/g, "")
    .replace(/\b(\w+)(\s+\1\b)+/gi, "$1")
    .replace(/['’]s$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const partsBeforeTail = trimmed.split(" ");
  if (partsBeforeTail.length > 1) {
    const half = partsBeforeTail.length / 2;
    if (Number.isInteger(half) && partsBeforeTail.slice(0, half).join(" ").toLowerCase() === partsBeforeTail.slice(half).join(" ").toLowerCase()) trimmed = partsBeforeTail.slice(0, half).join(" ");
  }
  let parts = trimmed.split(" ");
  while (parts.length > 1 && !/^[A-ZÀ-ÖØ-Ý0-9]/.test(parts.at(-1) || "")) parts.pop();
  while (parts.length > 1 && (GENERIC_WORDS.has((parts[0] || "").toLowerCase()) || NOISE_WORDS.has((parts[0] || "").toLowerCase()))) parts.shift();
  trimmed = parts.join(" ");
  return trimmed;
}

function quoteAround(text: string, index: number, length: number): string {
  return text.slice(Math.max(0, index - 90), Math.min(text.length, index + length + 130)).replace(/\s+/g, " ").trim();
}

function candidateFromTail(text: string, start: number): { value: string; length: number } | null {
  const tail = text.slice(start);
  const match = tail.match(new RegExp(`^(${WORD_SEQUENCE})`));
  if (!match) return null;
  const value = trimCandidate(match[1]);
  return isAllowedIdentityCandidate(value) ? { value, length: match[1].length } : null;
}

function addCandidate(
  candidates: IdentityCandidate[],
  text: IdentityText,
  value: string,
  index: number,
  confidence: "high" | "medium",
  field: "company" | "product" = "company"
): void {
  const candidate = trimCandidate(value);
  if (!isAllowedIdentityCandidate(candidate)) return;
  const sourceWeight = text.source === "description" || text.source === "attachment" ? 4 : text.source === "review" || text.source === "sibling-job" || text.source === "past-job" ? 3 : 1;
  const signalWeight = confidence === "high" ? 4 : 2;
  const before = text.text.slice(Math.max(0, index - 120), index);
  const after = text.text.slice(index + candidate.length, Math.min(text.text.length, index + candidate.length + 120));
  const beforeTail = before.replace(/\s+/g, " ").trim();
  const ownershipScore = scoreOwnership(text, candidate, beforeTail, after);
  candidates.push({
    value: candidate,
    field,
    source: text.source,
    quote: quoteAround(text.text, index, candidate.length),
    confidence,
    score: sourceWeight + signalWeight + Math.min(3, words(candidate).length) + (candidate.includes(".") ? 2 : 0),
    ownershipScore,
  });
}

function scoreOwnership(text: IdentityText, candidate: string, before: string, after: string): number {
  const afterLower = after.toLowerCase();
  let score = 0;

  if (candidate.includes(".") && ["description", "attachment", "sibling-job", "past-job"].includes(text.source)) score += 8;
  if (/(?:about(?:\s+us)?|client|brand|company|platform|website|websites|app|product|organization)\s*[:,-]?\s*$/i.test(before)) score += 9;
  if (/(?:(?:we['’]re|we\s+are|i['’]m)(?:\s+building)?|we\s+run|our\s+(?:brand|company|app|platform|website|websites)|my\s+(?:brand|company|app|platform|website))\s*[:,-]?\s*$/i.test(before)) score += 9;
  if (/(?:called|named|join|founder\s+of|built\s+for|website\s+for|brand\s+called|platform\s+called|app\s+called|team\s+at)\s*$/i.test(before)) score += 9;
  if (/(?:working|work|worked)\s+with\s*$/i.test(before)) score += text.source === "review" ? 9 : 4;
  if (/(?:working|work|worked)\s+for\s*$/i.test(before)) score += text.source === "review" ? 4 : 3;
  if (/(?:working|work|worked)\s+on\s+(?:a|an|the)?\s*$/i.test(before) && text.source !== "past-title") score += 7;
  if (/\b(?:for|at)\s*(?:a|an|the)?\s*$/i.test(before) && text.source !== "past-title" && !/(?:working|work|worked)\s+(?:with|for)\s*$/i.test(before)) score += 7;
  if (/^\s*[,;:-]?\s*(?:is|are|was|were)\s+(?:a|an|the|our|looking|hiring|seeking|searching|called|named|building)\b|^\s*[,;:-]?\s*(?:makes|helps|owns|runs|has)\b/i.test(afterLower)) score += 9;
  if (text.source === "review" && /^\s*(?:is|was|has been)\s+(?:a|an|the)?\s*(?:great|good|excellent|amazing|awesome|wonderful|fantastic|nice|pleasant|professional|client|person|leader|pleasure)\b/i.test(afterLower)) score = 0;
  if (text.source === "review" && /\/\s*$/i.test(before)) score += 10;

  // A past title is useful corroboration but is not ownership evidence by
  // itself: titles commonly name tools, roles, and generic project categories.
  if (text.source === "past-title") return 0;
  return score;
}

function extractDomains(text: IdentityText, candidates: IdentityCandidate[]): string[] {
  const domains: string[] = [];
  const pattern = new RegExp(`(?<![@\\w])(?:https?://|www\\.)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.(?:${TLD}))(?![a-z0-9-])(?:/[^\\s)>'\"]*)?`, "gi");
  for (const match of text.text.matchAll(pattern)) {
    const host = match[1].toLowerCase();
    if (GENERIC_DOMAINS.has(host) || domains.includes(host)) continue;
    domains.push(host);
    const before = text.text.slice(Math.max(0, (match.index ?? 0) - 140), match.index ?? 0);
    if (/\bcompetitors?\b|\bother\s+(?:brands|companies)\b/i.test(before)) continue;
    addCandidate(candidates, text, host, match.index ?? 0, "high");
  }
  for (const match of text.text.matchAll(/(?<![A-Za-z0-9])@([a-z][a-z0-9_-]{2,})/gi)) {
    addCandidate(candidates, text, match[1], match.index ?? 0, "high");
  }
  return domains;
}

function extractNames(texts: IdentityText[]): string[] {
  const names = new Set<string>();
  const add = (value: string) => {
    if (isAllowedIdentityCandidate(value)) names.add(value);
  };
  for (const text of texts.filter((item) => item.source === "review")) {
    for (const match of text.text.matchAll(/\b(?:Mr|Mrs|Ms|Dr)\.?\s+([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'-]{2,}(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'-]{2,})?)/g)) add(match[1]);
    for (const match of text.text.matchAll(/\bwith\s+([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'-]{2,}(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'-]{2,})?)/g)) add(match[1]);
    for (const match of text.text.matchAll(/\b([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'-]{2,}(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'-]{2,})?)\s+(?:was|is|has been)\b/g)) add(match[1]);
  }
  return [...names];
}

function extractCandidates(text: IdentityText): IdentityCandidate[] {
  const candidates: IdentityCandidate[] = [];
  const textValue = text.text;
  const addTail = (match: RegExpMatchArray, confidence: "high" | "medium", field: "company" | "product" = "company") => {
    const start = (match.index ?? 0) + match[0].length;
    const candidate = candidateFromTail(textValue, start);
    if (candidate) addCandidate(candidates, text, candidate.value, start, confidence, field);
  };

  const direct = [
    /\b(?:about\s+us|about|why\s+join)\s*[:\s]+/gi,
    /\b(?:i['’]m|we['’]re|we\s+are|we\s+run)\s+(?:building\s+)?/gi,
    /\b(?:called|named|join|at|for|from|working\s+on|built\s+with)\s+(?:a\s+|an\s+|the\s+)?/gi,
    /\b(?:founder\s+of|working\s+for|built\s+for|website\s+for|brand\s+called|platform\s+called|app\s+called)\s+/gi,
    /\b(?:my|our)\s+(?:mobile\s+)?(?:app|platform|brand|company)[,\s]+/gi,
    /\b(?:brand|company|app|platform),\s+/gi,
    /\b(?:client|customer|brand|company)\s*:\s*/gi,
  ];
  for (const pattern of direct) {
    for (const match of textValue.matchAll(pattern)) addTail(match, "high");
  }

  const preceding = new RegExp(`(?:[.!?:\\)\\]}]\\s+|\\b(?:[Aa]bout|[Oo]verview|[Bb]rand|[Cc]ompany|[Pp]latform|[Tt]itle|[Dd]escription)\\s+)(${WORD_SEQUENCE})\\s+(?:is|makes|helps|owns|runs|was|has|looking|hiring|seeking)\\b`, "g");
  for (const match of textValue.matchAll(preceding)) {
    const value = trimCandidate(match[1]);
    addCandidate(candidates, text, value, (match.index ?? 0) + match[0].indexOf(match[1]), "high");
  }
  const beginning = new RegExp(`^(${WORD_SEQUENCE})\\s+(?:is|makes|helps|owns|runs|was|has|looking|hiring|seeking)\\b`, "g");
  for (const match of textValue.matchAll(beginning)) addCandidate(candidates, text, match[1], match.index ?? 0, "high");

  const team = new RegExp(`(?:^|[.!?:]\\s+|\\b(?:the|our|at|with)\\s+)(${WORD_SEQUENCE})\\s+(?:team|brand|company|platform)\\b`, "g");
  for (const match of textValue.matchAll(team)) addCandidate(candidates, text, match[1], (match.index ?? 0) + match[0].indexOf(match[1]), "high");

  if (text.source === "review") {
    const slash = new RegExp(`\\/\\s*(${WORD_SEQUENCE})(?=[.,;!?)\\n]|$)`, "g");
    for (const match of textValue.matchAll(slash)) addCandidate(candidates, text, match[1], (match.index ?? 0) + match[0].indexOf(match[1]), "high");
    const workingWith = new RegExp(`\\b(?:working|work|worked|experience)\\s+with\\s+(${WORD_SEQUENCE})`, "g");
    for (const match of textValue.matchAll(workingWith)) addCandidate(candidates, text, match[1], (match.index ?? 0) + match[0].indexOf(match[1]), words(match[1]).length > 1 ? "high" : "medium");
    const reviewName = new RegExp(`\\b(${WORD_SEQUENCE})\\s+(?:was|is)\\s+(?:great|good|clear|a\\s+pleasure|wonderful)`, "g");
    for (const match of textValue.matchAll(reviewName)) addCandidate(candidates, text, match[1], (match.index ?? 0) + match[0].indexOf(match[1]), "medium");
  }

  extractDomains(text, candidates);
  return candidates;
}

function selectCandidates(candidates: IdentityCandidate[]): IdentityCandidate[] {
  const unique = new Map<string, { candidate: IdentityCandidate; score: number; count: number }>();
  for (const candidate of candidates) {
    const key = normalized(candidate.value);
    const prior = unique.get(key);
    if (!prior) unique.set(key, { candidate, score: candidate.score, count: 1 });
    else {
      prior.score += candidate.score;
      prior.count++;
      if (candidate.ownershipScore > prior.candidate.ownershipScore || (candidate.ownershipScore === prior.candidate.ownershipScore && (candidate.score > prior.candidate.score || (candidate.score === prior.candidate.score && candidate.value.length > prior.candidate.value.length)))) prior.candidate = candidate;
    }
  }
  return [...unique.values()]
    .map(({ candidate, score, count }) => ({ ...candidate, score: score + (count - 1) * 2 }))
    .sort((a, b) => b.ownershipScore - a.ownershipScore || b.score - a.score || b.value.length - a.value.length);
}

export function extractIdentitySignals(input: unknown): IdentitySignals {
  const record = isRecord(input) ? input : {};
  const collected = collectTexts(record);
  const names = extractNames(collected.texts);
  const nameKeys = new Set(names.map(normalized));
  const candidates = collected.texts
    .flatMap(extractCandidates)
    .filter((candidate) => !(candidate.source === "review" && words(candidate.value).length === 1 && nameKeys.has(normalized(candidate.value))));
  const urls = [...new Set(collected.texts.flatMap((text) => extractDomains(text, [])))];
  const emails = [...new Set(collected.texts.flatMap((text) => text.text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map((email) => email.toLowerCase()))];
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
    urls,
    emails,
    candidates: selectCandidates(candidates),
    names,
  };
}
