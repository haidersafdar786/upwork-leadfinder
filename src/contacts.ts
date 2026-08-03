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

function hasLocalPhoneSyntax(value: string): boolean {
  return /\(\d{2,4}\)/.test(value) || /(?:\d{2,4}[.-]){2,3}\d{2,4}/.test(value);
}

export function extractPhoneNumbers(value: string): PhoneNumber[] {
  const withoutUrls = value.replace(/https?:\/\/\S+/gi, " ");
  const valid = [...withoutUrls.matchAll(PHONE_PATTERN)].flatMap((match) => {
    const candidate = match[0];
    let cleaned = candidate.trim().replace(/\s+/g, " ");
    const opening = (cleaned.match(/\(/g) || []).length;
    const closing = (cleaned.match(/\)/g) || []).length;
    if (opening !== closing) return [];
    const parenthesis = cleaned.indexOf("(");
    if (parenthesis > 0 && /^\d{2,6}\s+$/.test(cleaned.slice(0, parenthesis))) cleaned = cleaned.slice(parenthesis);
    cleaned = cleaned.replace(/^((?:\d{3}[.-]){2}\d{4})\s+\d{2,5}$/, "$1");
    const digits = cleaned.replace(/\D/g, "");
    const hasDialingSyntax = cleaned.startsWith("+");
    if (digits.length < 7 || digits.length > 15 || isDateOrNumberSequence(cleaned)) return [];
    if (!hasDialingSyntax && (digits.length < 10 || !hasLocalPhoneSyntax(cleaned))) return [];
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

export function emailsMatchingWebsite(emails: readonly EmailAddress[], website: string | null): EmailAddress[] {
  if (!website) return [];
  let siteHost: string;
  try {
    siteHost = new URL(website.startsWith("http://") || website.startsWith("https://") ? website : `https://${website}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return [];
  }
  return emails.filter((email) => {
    const domain = email.split("@")[1]?.toLowerCase();
    return Boolean(domain && (domain === siteHost || domain.endsWith("." + siteHost) || siteHost.endsWith("." + domain)));
  });
}
