import type { ContactDetails, EmailAddress, HttpUrl, PhoneNumber } from "./types.ts";

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_PATTERN = /(?:\+\d{1,3}[\s().-]*)?(?:\(?\d{2,4}\)?[\s.-]+){2,4}\d{2,4}/g;
const WHATSAPP_PATTERN = /https?:\/\/(?:(?:api|www)\.)?(?:wa\.me|whatsapp\.com)\/[^\s<>"')\]]+/gi;

function uniqueBy<Value>(values: readonly Value[], key: (value: Value) => string): Value[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = key(value);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function httpUrl(value: string): HttpUrl | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value as HttpUrl : null;
  } catch {
    return null;
  }
}

export function extractEmailAddresses(value: string): EmailAddress[] {
  const matches = value.match(EMAIL_PATTERN) || [];
  return uniqueBy(matches.map((email) => email.toLowerCase() as EmailAddress), (email) => email);
}

function isDateOrNumberSequence(value: string): boolean {
  const cleaned = value.trim();
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2})?$/.test(cleaned)) return true;
  const groups = cleaned.split(/[\s.-]+/).filter(Boolean);
  return groups.length >= 5 && groups.every((group) => /^\d{1,2}$/.test(group));
}

function hasPhoneContext(value: string, start: number, length: number): boolean {
  const nearby = value.slice(Math.max(0, start - 32), Math.min(value.length, start + length + 20));
  return /\b(?:call|cell|contact|mobile|phone|tel(?:ephone)?|whats\s*app)\b/i.test(nearby);
}

export function extractPhoneNumbers(value: string): PhoneNumber[] {
  const withoutUrls = value.replace(/https?:\/\/\S+/gi, " ");
  const valid = [...withoutUrls.matchAll(PHONE_PATTERN)].flatMap((match) => {
    const candidate = match[0];
    const cleaned = candidate.trim().replace(/\s+/g, " ");
    const digits = cleaned.replace(/\D/g, "");
    const hasDialingSyntax = cleaned.startsWith("+") || cleaned.includes("(");
    const start = match.index || 0;
    if (digits.length < 7 || digits.length > 15 || isDateOrNumberSequence(cleaned)) return [];
    if (!hasDialingSyntax && (digits.length < 10 || !hasPhoneContext(withoutUrls, start, candidate.length))) return [];
    return [cleaned as PhoneNumber];
  });
  return uniqueBy(valid, (phone) => phone.replace(/\D/g, ""));
}

function isDirectWhatsAppUrl(value: string): boolean {
  const url = new URL(value);
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (host === "wa.me") return /^\/\d{7,15}\/?$/.test(url.pathname);
  if (host !== "whatsapp.com" && host !== "api.whatsapp.com") return false;
  return /^\/send\/?$/i.test(url.pathname) && /^\d{7,15}$/.test(url.searchParams.get("phone") || "");
}

export function extractWhatsAppUrls(value: string): HttpUrl[] {
  const matches = value.match(WHATSAPP_PATTERN) || [];
  const urls = matches.flatMap((match) => {
    const parsed = httpUrl(match.replace(/[.,;:!?]+$/, ""));
    return parsed && isDirectWhatsAppUrl(parsed) ? [parsed] : [];
  });
  return uniqueBy(urls, (url) => url.toLowerCase());
}

export function emptyContactDetails(): ContactDetails {
  return { emails: [], phones: [], whatsApp: [] };
}

export function mergeContactDetails(...details: readonly ContactDetails[]): ContactDetails {
  return {
    emails: uniqueBy(details.flatMap((item) => item.emails), (email) => email.toLowerCase()),
    phones: uniqueBy(details.flatMap((item) => item.phones), (phone) => phone.replace(/\D/g, "")),
    whatsApp: uniqueBy(details.flatMap((item) => item.whatsApp), (url) => url.toLowerCase()),
  };
}

export function emailsMatchingWebsite(emails: readonly EmailAddress[], website: HttpUrl | null): EmailAddress[] {
  if (!website) return [];
  const siteHost = new URL(website).hostname.replace(/^www\./, "").toLowerCase();
  return emails.filter((email) => {
    const domain = email.split("@")[1]?.toLowerCase();
    return Boolean(domain && (domain === siteHost || domain.endsWith("." + siteHost) || siteHost.endsWith("." + domain)));
  });
}
