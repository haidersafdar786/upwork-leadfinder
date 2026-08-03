import { z } from "zod";
import { emptyContactDetails, extractEmailAddresses, extractPhoneNumbers, extractWhatsAppUrls } from "./contacts.ts";
import type { Client, EmailAddress, HttpUrl, Identity, PhoneNumber, WebPresence } from "./types.ts";
import { runOpenCodeWeb, type OpenCodeTool } from "./opencode.ts";

const EnrichmentModelSchema = z.object({
  personLinkedin: z.string().nullable(),
  companyLinkedin: z.string().nullable(),
  website: z.string().nullable(),
  socials: z.array(z.string()),
  summary: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
}).strict();

type EnrichmentModelOutput = z.infer<typeof EnrichmentModelSchema>;

export interface KnownClient {
  name: string | null;
  people: string[];
  company: string | null;
  product: string | null;
  website: string | null;
  industry: string | null;
  location: string | null;
  evidence: string | null;
}

function parseModelOutput(text: string): EnrichmentModelOutput {
  const value = text.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/, "");
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("OpenCode enrichment response did not contain a JSON object");
  return EnrichmentModelSchema.parse(JSON.parse(value.slice(start, end + 1)));
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebEvidence extends WebSearchResult {
  source: "websearch" | "webfetch";
  query: string | null;
  callID: string | null;
  fetchedFrom: string | null;
}

export interface WebPresenceResolution {
  personLinkedIn: string | null;
  companyLinkedIn: string | null;
  verifiedSite: string | null;
  socials: string[];
  emails: EmailAddress[];
  phones: PhoneNumber[];
  whatsApp: string[];
  supportingLinks: Array<{ url: string; title: string }>;
  confidence: "low" | "medium";
}

export interface WebResearch {
  presence: WebPresence;
  results: WebSearchResult[];
  evidence: WebEvidence[];
  queries: string[];
  queryCoverage: { completed: number; total: number; missing: string[] };
}

const SOCIAL_HOSTS = new Set([
  "linkedin.com", "instagram.com", "tiktok.com", "facebook.com", "fb.com", "twitter.com", "x.com",
  "youtube.com", "youtu.be", "pinterest.com", "threads.net", "t.me", "github.com", "crunchbase.com",
]);
const SUPPORT_STOP_WORDS = new Set(["the", "and", "for", "with", "from", "that", "this", "our", "are", "were", "has", "have"]);
const CONTEXT_STOP_WORDS = new Set([...SUPPORT_STOP_WORDS, "company", "product", "platform", "building", "hiring", "client"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function validUrl(value: unknown): string | null {
  const text = textValue(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? text : null;
  } catch {
    return null;
  }
}

function hostOf(value: string): string {
  try {
    return new URL(value.startsWith("http") ? value : "https://" + value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return value.replace(/^www\./, "").toLowerCase();
  }
}

function urlKey(value: string): string {
  try {
    const url = new URL(value);
    return url.hostname.replace(/^www\./, "").toLowerCase() + url.pathname.replace(/\/+$/, "") + url.search;
  } catch {
    return value.toLowerCase();
  }
}

function words(value: unknown): string[] {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3);
}

function squish(value: unknown): string {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isSocialUrl(value: string): boolean {
  return SOCIAL_HOSTS.has(hostOf(value));
}

function resultFrom(value: unknown): WebSearchResult | null {
  if (!isRecord(value)) return null;
  const url = validUrl(value.url);
  if (!url) return null;
  return { title: clean(value.title), url, snippet: clean(value.snippet) };
}

function normalizeResults(results: readonly WebSearchResult[]): WebSearchResult[] {
  return results.flatMap((result) => {
    const parsed = resultFrom(result);
    return parsed ? [parsed] : [];
  });
}

function parseSearchOutput(output: string, query: string | null, callID: string | null): WebEvidence[] {
  return output.split(/\n\s*---\s*\n/).flatMap((block) => {
    const title = block.match(/^Title:\s*(.+)$/m)?.[1];
    const url = validUrl(block.match(/^URL:\s*(https?:\/\/\S+)$/m)?.[1]);
    if (!title || !url) return [];
    const highlights = block.split(/^Highlights:\s*$/m)[1] || "";
    return [{ title: clean(title), url, snippet: clean(highlights.replace(/^\.\.\.\s*$/gm, "")).slice(0, 500), source: "websearch", query, callID, fetchedFrom: null }];
  });
}

function parseFetchedOutput(tool: OpenCodeTool): WebEvidence[] {
  const inputUrl = textValue(tool.state.input.url) || textValue(tool.state.input.URL);
  const output = tool.state.output;
  const links = [...output.matchAll(/https?:\/\/[^\s<>"')\]]+/g)].map((match) => match[0].replace(/[.,;:!?]+$/, ""));
  return [...new Set([inputUrl, ...links].filter((url): url is string => Boolean(validUrl(url))))].map((url) => ({
    title: "(from " + hostOf(inputUrl || url) + ")",
    url,
    snippet: clean(output).slice(0, 500),
    source: "webfetch",
    query: null,
    callID: tool.callID,
    fetchedFrom: inputUrl,
  }));
}

export function evidenceFromOpenCodeTools(tools: readonly OpenCodeTool[]): WebEvidence[] {
  const evidence = tools.flatMap((tool) => {
    if (tool.state.status !== "completed") return [];
    if (tool.tool === "websearch") return parseSearchOutput(tool.state.output, textValue(tool.state.input.query), tool.callID);
    if (tool.tool === "webfetch") return parseFetchedOutput(tool);
    return [];
  });
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = urlKey(item.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function researchPrompt(known: KnownClient, queries: string[]): string {
  return "You are researching one client's public web presence.\n" +
    "Use websearch once for every query below. For a contact query, prefer an official contact page and include any public email, phone, or WhatsApp details in the observed tool evidence. You may webfetch at most one URL, and only a URL returned by websearch or the known client website. Never guess a domain or contact detail. Do not use shell, filesystem, task, or other tools. Copy URLs exactly from observed tool results; never invent or normalize them.\n\n" +
    "KNOWN CLIENT:\n" + JSON.stringify(known) + "\n\n" +
    "QUERIES:\n" + queries.map((query, index) => (index + 1) + ". " + query).join("\n") + "\n\n" +
    "Return exactly one JSON object with these keys: personLinkedin, companyLinkedin, website, socials, summary, confidence. Use null or [] when no public match is supported.";
}

export async function researchWebPresence(known: KnownClient, options: { timeoutMs?: number; attemptTimeoutMs?: number } = {}): Promise<WebResearch> {
  const queries = buildEnrichmentQueries(known);
  if (!queries.length) return { presence: emptyWebPresence(), results: [], evidence: [], queries, queryCoverage: { completed: 0, total: 0, missing: [] } };
  const run = await runOpenCodeWeb({ prompt: researchPrompt(known, queries), timeoutMs: options.timeoutMs, attemptTimeoutMs: options.attemptTimeoutMs, retries: 1 });
  const selection = parseModelOutput(run.text);
  const evidence = evidenceFromOpenCodeTools(run.tools);
  const results = evidence.map(({ title, url, snippet }) => ({ title, url, snippet }));
  const resolution = resolveWebPresence(known, results, selection);
  const completedQueries = new Set(run.tools.filter((tool) => tool.tool === "websearch" && tool.state.status === "completed").map((tool) => textValue(tool.state.input.query)?.toLowerCase()));
  const missing = queries.filter((query) => !completedQueries.has(query.toLowerCase()));
  return { presence: toWebPresence(resolution), results, evidence, queries, queryCoverage: { completed: queries.length - missing.length, total: queries.length, missing } };
}

export async function enrichClient(client: Client, options: { timeoutMs?: number; attemptTimeoutMs?: number } = {}): Promise<WebResearch> {
  return researchWebPresence(knownFromClient(client), options);
}

function organizationAppears(text: string, organization: string | null): boolean {
  const key = squish(organization);
  return key.length >= 4 && squish(text).includes(key);
}

function visiblePersonMatch(name: string | null, title: string): boolean {
  const known = String(name || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (known.length < 2) return false;
  const visible = title.split(/\s+(?:\||[-–—])\s+/)[0].toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (visible.length < 2 || visible[0] !== known[0]) return false;
  const suffixes = new Set(["jr", "sr", "ii", "iii", "iv"]);
  const family = visible.slice(1).filter((word) => !suffixes.has(word)).at(-1) || "";
  return known.at(-1)?.length === 1 ? family.startsWith(known.at(-1) || "") : family === known.at(-1);
}

function corroborates(url: string | null, kind: "person" | "company" | "website" | "social", known: KnownClient, results: WebSearchResult[]): boolean {
  if (!url) return false;
  const result = results.find((item) => urlKey(item.url) === urlKey(url));
  if (!result) return false;
  const text = result.title + " " + result.snippet + " " + url;
  const hay = new Set(words(text));
  const orgOk = organizationAppears(text, known.company) || organizationAppears(text, known.product);
  const siteName = known.website ? hostOf(known.website).split(".")[0] : "";
  const siteOk = Boolean(siteName && (hay.has(siteName) || squish(text).includes(siteName)));
  const nameWords = words(known.name);
  const fullName = nameWords.length >= 2;
  const nameOk = nameWords.length > 0 && nameWords.every((word) => hay.has(word));
  if (kind === "company") return orgOk || siteOk;
  if (kind === "website") return orgOk || siteOk || (fullName && nameOk && words(known.location).some((word) => hay.has(word)));
  if (kind === "person") {
    const visibleText = result.title + " " + result.snippet;
    return visiblePersonMatch(known.name, result.title) && (organizationAppears(visibleText, known.company) || organizationAppears(visibleText, known.product) || (known.website ? visibleText.toLowerCase().includes(hostOf(known.website)) : false));
  }
  return orgOk || siteOk || (fullName && nameOk);
}

function matchesKnownContext(known: KnownClient, result: WebSearchResult): boolean {
  const orgWords = new Set(words((known.company || "") + " " + (known.product || "")));
  const context = words((known.industry || "") + " " + (known.location || "") + " " + (known.evidence || "")).filter((word) => !orgWords.has(word) && !CONTEXT_STOP_WORDS.has(word));
  if (!context.length) return false;
  const resultWords = new Set(words(result.title + " " + result.snippet));
  return context.some((word) => resultWords.has(word));
}

function hasPersonOrgContext(known: KnownClient, results: WebSearchResult[]): boolean {
  const orgWords = words(known.company || known.product);
  return known.people.some((person) => {
    const personWords = words(person);
    return personWords.length > 0 && results.some((result) => {
      const resultWords = new Set(words(result.title + " " + result.snippet));
      return personWords.every((word) => resultWords.has(word)) && orgWords.every((word) => resultWords.has(word));
    });
  });
}

function companySlug(url: string): string {
  return squish(url.match(/linkedin\.com\/company\/([^/?#]+)/i)?.[1] || "");
}

function supportingLinks(known: KnownClient, results: WebSearchResult[]): Array<{ url: string; title: string }> {
  const clues = [...new Set(words(known.evidence).filter((word) => !SUPPORT_STOP_WORDS.has(word)))];
  if (clues.length < 4) return [];
  return results
    .filter((result) => /linkedin\.com\/posts\//i.test(result.url))
    .filter((result) => {
      const text = result.title + " " + result.snippet;
      const resultWords = new Set(words(text));
      const overlap = clues.filter((word) => resultWords.has(word)).length;
      return (organizationAppears(text, known.company) || organizationAppears(text, known.product)) && overlap / clues.length >= 0.6;
    })
    .map((result) => ({ url: result.url, title: result.title }))
    .slice(0, 3);
}

export function emptyWebPresence(): WebPresence {
  return { personLinkedIn: null, companyLinkedIn: null, socials: [], verifiedSite: null, supportingLinks: [], ...emptyContactDetails() };
}

function emptyResolution(): WebPresenceResolution {
  return { personLinkedIn: null, companyLinkedIn: null, verifiedSite: null, socials: [], emails: [], phones: [], whatsApp: [], supportingLinks: [], confidence: "low" };
}

export function knownFromIdentity(identity: Identity, location: string | null = null): KnownClient {
  if (identity.kind === "unknown") return { name: null, people: [], company: null, product: null, website: null, industry: null, location, evidence: null };
  return { name: identity.name, people: identity.people, company: identity.company, product: identity.product, website: identity.website, industry: identity.industry, location, evidence: identity.evidenceQuote };
}

export function knownFromClient(client: Client): KnownClient {
  const location = client.jobs.find((job) => job.details.buyerCountry)?.details.buyerCountry || null;
  return knownFromIdentity(client.identity, location);
}

export function buildEnrichmentQueries(known: KnownClient): string[] {
  const org = known.company || known.product;
  const site = known.website ? hostOf(known.website) : null;
  const contact = site ? site + " contact" : org ? org + " contact" : known.name ? known.name + " " + (known.location || "") + " contact" : null;
  const queries = [site, known.name && org ? known.name + " " + org + " linkedin" : null, org ? org + " linkedin" : null, contact, org || null, known.name && !org ? known.name + " " + (known.location || "") + " linkedin" : null];
  return [...new Set(queries.filter((query): query is string => Boolean(query && query.trim())).map((query) => query.replace(/[®™©]/g, "").replace(/\s+/g, " ").trim()))].slice(0, 4);
}

function sameSite(left: string, right: string): boolean {
  const leftHost = hostOf(left);
  const rightHost = hostOf(right);
  return leftHost === rightHost || leftHost.endsWith("." + rightHost) || rightHost.endsWith("." + leftHost);
}

function identityAppearsInHost(url: string, known: KnownClient): boolean {
  const host = squish(hostOf(url));
  if (/alternatives?|compar(?:e|ison)|competitors?|directory|marketplace|reviews?/.test(host)) return false;
  const organizationKeys = [known.company, known.product]
    .flatMap((value) => [squish(value), ...words(value).map(squish)])
    .filter((key) => key.length >= 4);
  if (organizationKeys.length) return organizationKeys.some((key) => host.includes(key));
  const nameWords = words(known.name);
  return nameWords.length >= 2 && host.includes(squish(nameWords.join("")));
}

function trustedContactSite(known: KnownClient, verifiedSite: string | null): string | null {
  const candidate = known.website || verifiedSite;
  return candidate && identityAppearsInHost(candidate, known) ? candidate : null;
}

function resolveContacts(known: KnownClient, results: readonly WebSearchResult[], verifiedSite: string | null): Pick<WebPresenceResolution, "emails" | "phones" | "whatsApp"> {
  const site = trustedContactSite(known, verifiedSite);
  const relevant = site ? results.filter((result) => sameSite(result.url, site)) : [];
  const text = relevant.map((result) => result.title + "\n" + result.snippet + "\n" + result.url).join("\n");
  return {
    emails: extractEmailAddresses(text),
    phones: extractPhoneNumbers(text),
    whatsApp: extractWhatsAppUrls(text),
  };
}

export function resolveWebPresence(known: KnownClient, rawResults: readonly WebSearchResult[], model: Partial<EnrichmentModelOutput> = {}): WebPresenceResolution {
  const results = normalizeResults(rawResults);
  const byUrl = new Map(results.map((result) => [urlKey(result.url), result.url]));
  const observed = (value: string | null | undefined): string | null => value ? byUrl.get(urlKey(value)) || null : null;
  const negative = /\b(?:no (?:clear |public |verifiable )?(?:web presence|match)(?: found)?|not a match|unrelated|different individual|could not identify|couldn't identify|not found)\b/i.test(model.summary || "");
  const resolved = emptyResolution();
  const modelWebsite = negative ? null : observed(model.website);
  resolved.personLinkedIn = negative ? null : observed(model.personLinkedin);
  resolved.verifiedSite = corroborates(modelWebsite, "website", known, results) ? modelWebsite : null;
  resolved.socials = negative ? [] : (model.socials || []).flatMap((url) => {
    const exact = observed(url);
    return exact && isSocialUrl(exact) && !/linkedin\.com/i.test(exact) && corroborates(exact, "social", known, results) ? [exact] : [];
  });
  if (resolved.personLinkedIn && !corroborates(resolved.personLinkedIn, "person", known, results)) resolved.personLinkedIn = null;

  const siteName = hostOf(known.website || "").split(".")[0];
  const namedOrg = known.company || known.product || "";
  const orgKey = squish(namedOrg).length >= 4 ? squish(namedOrg) : squish(siteName);
  const companyResults = results.filter((result) => companySlug(result.url));
  if (orgKey.length >= 4) {
    const identityWords = words(namedOrg || siteName);
    const relevant = new Set(companyResults.filter((result) => identityWords.length && identityWords.every((word) => squish(result.title + " " + result.snippet + " " + result.url).includes(word))).map((result) => companySlug(result.url)));
    const unambiguous = relevant.size <= 1;
    const siteAnchor = (result: WebSearchResult) => Boolean(siteName && squish(result.title + " " + result.snippet + " " + result.url).includes(squish(siteName)));
    const canonical = companyResults.filter((result) => squish(result.title.replace(/\s*[|–-]\s*LinkedIn.*$/i, "").trim()) === orgKey);
    const exact = companyResults.find((result) => companySlug(result.url) === orgKey);
    if (canonical.length === 1 && (matchesKnownContext(known, canonical[0]) || siteAnchor(canonical[0]))) resolved.companyLinkedIn = canonical[0].url;
    else if (exact && (unambiguous || siteAnchor(exact))) resolved.companyLinkedIn = exact.url;
    else {
      const partial = companyResults.filter((result) => companySlug(result.url).length >= 4 && (companySlug(result.url).includes(orgKey) || orgKey.includes(companySlug(result.url))));
      const partialSlugs = new Set(partial.map((result) => companySlug(result.url)));
      if (partialSlugs.size === 1 && unambiguous && (identityWords.length > 1 || hasPersonOrgContext(known, results) || siteAnchor(partial[0]))) resolved.companyLinkedIn = partial[0].url;
    }
  }

  if (!resolved.verifiedSite) {
    const knownSite = known.website ? hostOf(known.website) : "";
    const knownSiteResult = knownSite && results.find((result) => {
      const host = hostOf(result.url);
      return host === knownSite || host.endsWith("." + knownSite);
    });
    if (knownSiteResult) resolved.verifiedSite = knownSiteResult.url;
  }
  if (resolved.verifiedSite && !known.website) {
    const siteResult = results.find((result) => urlKey(result.url) === urlKey(resolved.verifiedSite || ""));
    if (!siteResult || (!matchesKnownContext(known, siteResult) && !hasPersonOrgContext(known, results))) resolved.verifiedSite = null;
  }
  if (!resolved.verifiedSite && orgKey.length >= 4) {
    const candidates = results.filter((result) => !isSocialUrl(result.url) && !/linkedin\.com/i.test(result.url) && squish(hostOf(result.url)).includes(orgKey) && (matchesKnownContext(known, result) || hasPersonOrgContext(known, results)));
    const hosts = [...new Set(candidates.map((result) => hostOf(result.url)))];
    if (hosts.length === 1) resolved.verifiedSite = candidates[0].url;
  }

  if (!negative) {
    for (const person of known.people) {
      const matches = results.filter((result) => /linkedin\.com\/in\//i.test(result.url) && corroborates(result.url, "person", { ...known, name: person }, results));
      if (new Set(matches.map((result) => urlKey(result.url))).size === 1) {
        resolved.personLinkedIn ||= matches[0]?.url || null;
        break;
      }
    }
  }
  const contacts = resolveContacts(known, results, resolved.verifiedSite);
  resolved.emails = contacts.emails;
  resolved.phones = contacts.phones;
  resolved.whatsApp = contacts.whatsApp;
  resolved.supportingLinks = supportingLinks(known, results);
  if (resolved.personLinkedIn || resolved.companyLinkedIn || resolved.verifiedSite || resolved.socials.length || resolved.emails.length || resolved.phones.length || resolved.whatsApp.length || resolved.supportingLinks.length) resolved.confidence = "medium";
  return resolved;
}

function toHttpUrl(value: string | null): HttpUrl | null {
  return value && validUrl(value) ? value as HttpUrl : null;
}

export function toWebPresence(resolution: WebPresenceResolution): WebPresence {
  return {
    personLinkedIn: toHttpUrl(resolution.personLinkedIn),
    companyLinkedIn: toHttpUrl(resolution.companyLinkedIn),
    socials: resolution.socials.flatMap((url) => toHttpUrl(url) || []),
    emails: resolution.emails,
    phones: resolution.phones,
    whatsApp: resolution.whatsApp.flatMap((url) => toHttpUrl(url) || []),
    verifiedSite: toHttpUrl(resolution.verifiedSite),
    supportingLinks: resolution.supportingLinks.flatMap((link) => {
      const url = toHttpUrl(link.url);
      return url ? [{ url, title: link.title }] : [];
    }),
  };
}

export function selectedEnrichmentUrls(enrichment: WebPresenceResolution | WebPresence): string[] {
  const candidates = [
    enrichment.personLinkedIn,
    enrichment.companyLinkedIn,
    "verifiedSite" in enrichment ? enrichment.verifiedSite : null,
    ...enrichment.socials,
    ...(enrichment.whatsApp || []),
    ...enrichment.supportingLinks.map((link) => link.url),
  ].filter((url): url is string => typeof url === "string" && url.length > 0);
  return [...new Set(candidates)];
}

export function retainSelectedEvidence(evidence: readonly WebEvidence[], enrichment: WebPresenceResolution | WebPresence, limit = 60): WebEvidence[] {
  const selected = selectedEnrichmentUrls(enrichment);
  const byUrl = new Map(evidence.map((item) => [item.url, item]));
  const missing = selected.filter((url) => !byUrl.has(url));
  if (missing.length) throw new Error("Selected enrichment URL lacks observed evidence: " + missing.join(", "));
  const selectedSet = new Set(selected);
  const selectedEvidence = selected.map((url) => byUrl.get(url)).filter((item): item is WebEvidence => Boolean(item));
  const cap = Math.max(Number.isInteger(limit) && limit >= 0 ? limit : 60, selectedEvidence.length);
  return [...evidence.filter((item) => !selectedSet.has(item.url)).slice(0, cap - selectedEvidence.length), ...selectedEvidence];
}
