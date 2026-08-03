import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { emailsMatchingWebsite, extractPhoneNumbers, extractWhatsAppUrls } from "../src/contacts.ts";
import { extractIdentitySignals, isAllowedIdentityCandidate } from "../src/identity-extraction.ts";
import { identifyRecord } from "../src/identity-model.ts";

async function fixture(file) {
  return JSON.parse(await readFile(new URL(`./fixtures/${file}`, import.meta.url), "utf8"));
}

const newlane = await fixture("newlane.json");
const signals = extractIdentitySignals(newlane);
assert.ok(signals.candidates.some((candidate) => candidate.value === "Newlane University"));
assert.equal((await identifyRecord(newlane, { useModel: false })).identity.company, "Newlane University");

const adrianMagnus = await fixture("job_2079130192376414852.json");
const adrianSignals = extractIdentitySignals(adrianMagnus);
assert.ok(adrianSignals.candidates.some((candidate) => candidate.value === "Adrian Magnus Humidors"));
assert.equal((await identifyRecord(adrianMagnus, { useModel: false })).identity.company, "Adrian Magnus Humidors");

const anonymous = await fixture("null_architect_marketplace.json");
assert.equal((await identifyRecord(anonymous, { useModel: false })).identity.company, null);

assert.equal(isAllowedIdentityCandidate("React"), false);
assert.equal(isAllowedIdentityCandidate("Financial Reporting Workbook"), false);
assert.equal(isAllowedIdentityCandidate("Adrian Magnus Humidors"), true);

const contactSignals = extractIdentitySignals({
  description: "Contact studio@acme.example or +1 (415) 555-0199. WhatsApp https://wa.me/14155550199. Updated 2026-07-19.",
});
assert.deepEqual(contactSignals.emails, ["studio@acme.example"]);
assert.deepEqual(contactSignals.phones, ["+1 (415) 555-0199"]);
assert.deepEqual(contactSignals.whatsApp, ["https://wa.me/14155550199"]);
assert.deepEqual(emailsMatchingWebsite(contactSignals.emails, "https://www.acme.example"), ["studio@acme.example"]);
assert.deepEqual(emailsMatchingWebsite(contactSignals.emails, "https://different.example"), []);
assert.deepEqual(extractPhoneNumbers("Updated 2026-07-19 14 and version 12.34.56.78.90"), []);
assert.deepEqual(extractPhoneNumbers("VAT 12 345 678 901"), []);
assert.deepEqual(extractPhoneNumbers("Phone 415-555-0199"), ["415-555-0199"]);
assert.deepEqual(extractWhatsAppUrls("https://www.whatsapp.com/download https://wa.me/14155550199"), ["https://wa.me/14155550199"]);

const historicalContactSignals = extractIdentitySignals({
  description: "No direct contact is listed.",
  details: { buyer: { workHistory: [{ feedbackToClient: { comment: "Third party https://wa.me/442079460999" } }] } },
});
assert.deepEqual(historicalContactSignals.whatsApp, []);

console.log("identity checks passed");
