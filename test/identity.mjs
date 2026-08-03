import assert from "node:assert/strict";
import { emailsMatchingWebsite, extractEmailAddresses, extractPhoneNumbers, extractWhatsAppUrls } from "../src/contacts.ts";
import { extractIdentitySignals } from "../src/identity-extraction.ts";
import { identifyRecord } from "../src/identity-model.ts";

function runner(responses) {
  const queue = [...responses];
  return async () => {
    const response = queue.shift();
    if (response === undefined) throw new Error("Unexpected model call");
    return JSON.stringify(response);
  };
}

const namedRecord = {
  title: "Backend engineer",
  description: "About us: Newlane University is a licensed online university for working adults.",
};
const accepted = await identifyRecord(namedRecord, {
  verificationPasses: 2,
  runModel: runner([
    {
      name: null,
      company: { value: "Newlane University", sourceId: "source-2", quote: "Newlane University is a licensed online university" },
      product: null,
      website: null,
      industry: { value: "online university", sourceId: "source-2", quote: "Newlane University is a licensed online university" },
      confidence: "high",
    },
    { name: false, company: true, product: false, website: false, industry: true, reason: "Explicit About us ownership." },
    { name: false, company: true, product: false, website: false, industry: true, reason: "The source identifies the buyer organization." },
  ]),
});
assert.equal(accepted.identity.kind, "identified");
assert.equal(accepted.identity.company, "Newlane University");
assert.equal(accepted.identity.industry, "online university");

const genericRecord = {
  title: "Full-Stack AI Developer for Document Intelligence Web App",
  description: "Project brief for an AI assistant for solar and electrical installers.",
};
const rejectedGeneric = await identifyRecord(genericRecord, {
  verificationPasses: 2,
  runModel: runner([
    {
      name: null,
      company: { value: "Solar", sourceId: "source-2", quote: "solar and electrical installers" },
      product: null,
      website: null,
      industry: null,
      confidence: "high",
    },
    { name: false, company: false, product: false, website: false, industry: false, reason: "Solar is an industry reference." },
    { name: false, company: false, product: false, website: false, industry: false, reason: "No owned company is named." },
  ]),
});
assert.equal(rejectedGeneric.identity.kind, "unknown");

const competitorRecord = {
  title: "Build RigScore",
  description: "Existing products include Can You RUN It (systemrequirementslab.com). RigScore combines these ideas into a new product.",
};
const rejectedCompetitor = await identifyRecord(competitorRecord, {
  verificationPasses: 2,
  runModel: runner([
    {
      name: null,
      company: { value: "systemrequirementslab.com", sourceId: "source-2", quote: "Existing products include Can You RUN It (systemrequirementslab.com)" },
      product: null,
      website: { value: "https://systemrequirementslab.com", sourceId: "source-2", quote: "Existing products include Can You RUN It (systemrequirementslab.com)" },
      industry: null,
      confidence: "medium",
    },
    { name: false, company: false, product: false, website: false, industry: false, reason: "The site is a referenced competitor." },
    { name: false, company: false, product: false, website: false, industry: false, reason: "The buyer does not own this site." },
  ]),
});
assert.equal(rejectedCompetitor.identity.kind, "unknown");

const disagreement = await identifyRecord(namedRecord, {
  verificationPasses: 2,
  runModel: runner([
    {
      name: null,
      company: { value: "Newlane University", sourceId: "source-2", quote: "Newlane University is a licensed online university" },
      product: null,
      website: null,
      industry: null,
      confidence: "high",
    },
    { name: false, company: true, product: false, website: false, industry: false, reason: "Accepted." },
    { name: false, company: false, product: false, website: false, industry: false, reason: "Ambiguous." },
  ]),
});
assert.equal(disagreement.identity.kind, "unknown");

const inventedQuote = await identifyRecord(namedRecord, {
  runModel: runner([{
    name: null,
    company: { value: "Newlane University", sourceId: "source-2", quote: "We own Newlane University" },
    product: null,
    website: null,
    industry: null,
    confidence: "high",
  }]),
});
assert.equal(inventedQuote.identity.kind, "unknown");

assert.equal((await identifyRecord(namedRecord, { useModel: false })).identity.kind, "unknown");

const directContacts = "Contact studio@acme.example or +1 (415) 555-0199. WhatsApp https://wa.me/14155550199. Updated 2026-07-19.";
assert.deepEqual(extractEmailAddresses(directContacts), ["studio@acme.example"]);
assert.deepEqual(extractPhoneNumbers(directContacts), ["+1 (415) 555-0199"]);
assert.deepEqual(extractWhatsAppUrls(directContacts), ["https://wa.me/14155550199"]);
assert.deepEqual(emailsMatchingWebsite(extractEmailAddresses(directContacts), "https://www.acme.example"), ["studio@acme.example"]);
assert.deepEqual(emailsMatchingWebsite(extractEmailAddresses(directContacts), "https://different.example"), []);
assert.deepEqual(extractPhoneNumbers("Updated 2026-07-19 14 and version 12.34.56.78.90"), []);
assert.deepEqual(extractPhoneNumbers("VAT 12 345 678 901"), []);
assert.deepEqual(extractPhoneNumbers("Phone 415-555-0199"), ["415-555-0199"]);
assert.deepEqual(extractPhoneNumbers("Call (888-522-6249"), []);
assert.deepEqual(extractPhoneNumbers("Reference 5667 (916) 933-7622"), ["(916) 933-7622"]);
assert.deepEqual(extractPhoneNumbers("Phone 619.483.4549 1502"), ["619.483.4549"]);
assert.deepEqual(extractWhatsAppUrls("https://www.whatsapp.com/download https://wa.me/14155550199"), ["https://wa.me/14155550199"]);

console.log("identity checks passed");
