import assert from "node:assert/strict";
import { emailsMatchingWebsite, extractEmailAddresses, extractPhoneNumbers, extractWhatsAppUrls } from "../src/contacts.ts";
import { extractIdentitySignals } from "../src/identity-extraction.ts";
import { identifyRecord } from "../src/identity-model.ts";
import { OpenCodeProviderStoppedError } from "../src/opencode.ts";

function runner(responses) {
  const queue = [...responses];
  return async () => {
    const response = queue.shift();
    if (response === undefined) throw new Error("Unexpected model call");
    return typeof response === "string" ? response : JSON.stringify(response);
  };
}

const namedRecord = {
  title: "Backend engineer",
  description: "About us: Newlane University is a licensed online university for working adults.",
};
const accepted = await identifyRecord(namedRecord, {
  analystAttempts: 1,
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
    { acceptedClaimIds: ["claim-1", "claim-2"], reason: "Explicit About us ownership." },
    { acceptedClaimIds: ["claim-1", "claim-2"], reason: "The source identifies the buyer organization." },
  ]),
});
assert.equal(accepted.identity.kind, "identified");
assert.equal(accepted.identity.company, "Newlane University");
assert.equal(accepted.identity.industry, "online university");

let analystCalls = 0;
let verifierCalls = 0;
const sharedVerification = await identifyRecord(namedRecord, {
  runModel: async (prompt) => {
    if (prompt.includes("VERIFICATION PASS")) {
      verifierCalls++;
      return JSON.stringify({ acceptedClaimIds: ["claim-1", "claim-2"], reason: "Explicit buyer organization." });
    }
    analystCalls++;
    return JSON.stringify({
      name: null,
      company: { value: "Newlane University", sourceId: "source-2", quote: "Newlane University is a licensed online university" },
      product: null,
      website: null,
      industry: { value: "online university", sourceId: "source-2", quote: "Newlane University is a licensed online university" },
      confidence: "high",
    });
  },
});
assert.equal(sharedVerification.identity.company, "Newlane University");
assert.equal(analystCalls, 3, "identity extraction should retain three independent analysts");
assert.equal(verifierCalls, 2, "the agreed analyst proposal should need only two shared verifier passes");

const bareDomain = await identifyRecord({
  title: "CRM developer",
  description: "Our company, Northstar Advisory, helps homeowners. Visit northstar-advisory.example to understand our business.",
}, {
  analystAttempts: 1,
  runModel: runner([
    {
      name: null,
      company: { value: "Northstar Advisory", sourceId: "source-2", quote: "Our company, Northstar Advisory, helps homeowners" },
      product: null,
      website: { value: "northstar-advisory.example", sourceId: "source-2", quote: "Visit northstar-advisory.example to understand our business" },
      industry: null,
      confidence: "high",
    },
    { acceptedClaimIds: ["claim-1", "claim-2"], reason: "Explicit company and business website." },
    { acceptedClaimIds: ["claim-1", "claim-2"], reason: "Both claims are explicit." },
  ]),
});
assert.equal(bareDomain.identity.kind, "identified");
assert.equal(bareDomain.identity.website, "https://northstar-advisory.example");

const retriedAnalyst = await identifyRecord(namedRecord, {
  analystAttempts: 2,
  runModel: runner([
    { name: null, company: null, product: null, website: null, industry: null, confidence: "low" },
    {
      name: null,
      company: { value: "Newlane University", sourceId: "source-2", quote: "Newlane University is a licensed online university" },
      product: null,
      website: null,
      industry: null,
      confidence: "high",
    },
    { acceptedClaimIds: ["claim-1"], reason: "Explicit company." },
    { acceptedClaimIds: ["claim-1"], reason: "Explicit company." },
  ]),
});
assert.equal(retriedAnalyst.identity.company, "Newlane University");

const complementaryAnalysts = await identifyRecord({
  title: "Platform engineer",
  description: "I am Alex Example, founder of Acme Labs.",
}, {
  analystAttempts: 2,
  runModel: runner([
    {
      name: { value: "Alex Example", sourceId: "source-2", quote: "I am Alex Example" },
      company: null, product: null, website: null, industry: null, confidence: "high",
    },
    {
      name: null,
      company: { value: "Acme Labs", sourceId: "source-2", quote: "founder of Acme Labs" },
      product: null, website: null, industry: null, confidence: "high",
    },
    { acceptedClaimIds: ["claim-1", "claim-2"], reason: "Explicit person and company." },
    { acceptedClaimIds: ["claim-1", "claim-2"], reason: "Both claims are explicit." },
  ]),
});
assert.equal(complementaryAnalysts.identity.name, "Alex Example");
assert.equal(complementaryAnalysts.identity.company, "Acme Labs");

const conflictingAnalysts = await identifyRecord(namedRecord, {
  analystAttempts: 2,
  runModel: runner([
    {
      name: null,
      company: { value: "Newlane University", sourceId: "source-2", quote: "Newlane University is a licensed online university" },
      product: null, website: null, industry: null, confidence: "low",
    },
    {
      name: null,
      company: { value: "Online University", sourceId: "source-2", quote: "Newlane University is a licensed online university" },
      product: null, website: null, industry: null, confidence: "high",
    },
    { acceptedClaimIds: ["claim-1"], reason: "Only the proper company name is explicit." },
    { acceptedClaimIds: ["claim-1"], reason: "The other candidate is a generic description." },
  ]),
});
assert.equal(conflictingAnalysts.identity.company, "Newlane University");
assert.equal(conflictingAnalysts.identity.confidence, "low", "rejected analysts must not inflate identity confidence");

const genericRecord = {
  title: "Full-Stack AI Developer for Document Intelligence Web App",
  description: "Project brief for an AI assistant for solar and electrical installers.",
};
const rejectedGeneric = await identifyRecord(genericRecord, {
  analystAttempts: 1,
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
    { acceptedClaimIds: [], reason: "Solar is an industry reference." },
    { acceptedClaimIds: [], reason: "No owned company is named." },
  ]),
});
assert.equal(rejectedGeneric.identity.kind, "unknown");

const genericCompanyRecord = {
  title: "Senior Full-Stack Software Engineer",
  description: "I run a software and AI consulting firm building custom software, AI automations, internal tools, and AI-powered products.",
  details: {
    buyer: {
      workHistory: [{
        jobInfo: { title: "AI Software Research & Testing" },
        feedbackToClient: { comment: "Jacob provided clear instructions and was easy to work with." },
      }],
    },
  },
};
const genericCompanyClaim = await identifyRecord(genericCompanyRecord, {
  analystAttempts: 1,
  verificationPasses: 2,
  runModel: async (prompt) => {
    if (prompt.includes("CANDIDATE CLAIMS")) {
      assert.equal(prompt.toLowerCase().includes("generic noun phrase"), true);
      return JSON.stringify({ acceptedClaimIds: ["claim-1", "claim-2"], reason: "The personal name and descriptive industry are supported." });
    }
    assert.equal(prompt.includes("software and AI consulting firm"), true);
    assert.equal(prompt.includes("description, not a company name"), true);
    assert.equal(prompt.includes("Industry is separate from company identity"), true);
    return JSON.stringify({
      name: { value: "Jacob", sourceId: "source-4", quote: "Jacob provided clear instructions" },
      company: null,
      product: null,
      website: null,
      industry: { value: "software and AI consulting", sourceId: "source-2", quote: "I run a software and AI consulting firm" },
      confidence: "high",
    });
  },
});
assert.equal(genericCompanyClaim.identity.name, "Jacob");
assert.equal(genericCompanyClaim.identity.company, null, "a generic business description must not become a company identity");
assert.equal(genericCompanyClaim.identity.industry, "software and AI consulting");

const competitorRecord = {
  title: "Build RigScore",
  description: "Existing products include Can You RUN It (systemrequirementslab.com). RigScore combines these ideas into a new product.",
};
const rejectedCompetitor = await identifyRecord(competitorRecord, {
  analystAttempts: 1,
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
    { acceptedClaimIds: [], reason: "The site is a referenced competitor." },
    { acceptedClaimIds: [], reason: "The buyer does not own this site." },
  ]),
});
assert.equal(rejectedCompetitor.identity.kind, "unknown");

const disagreement = await identifyRecord(namedRecord, {
  analystAttempts: 1,
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
    { acceptedClaimIds: ["claim-1"], reason: "Accepted." },
    { acceptedClaimIds: [], reason: "Ambiguous." },
  ]),
});
assert.equal(disagreement.identity.kind, "unknown");

const inventedQuote = await identifyRecord(namedRecord, {
  analystAttempts: 1,
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

const invalidOptionalIndustry = await identifyRecord(namedRecord, {
  analystAttempts: 1,
  runModel: runner([
    {
      name: null,
      company: { value: "Newlane University", sourceId: "source-2", quote: "Newlane University is a licensed online university" },
      product: null,
      website: null,
      industry: "online education",
      confidence: "high",
    },
    { acceptedClaimIds: ["claim-1"] },
    { acceptedClaimIds: ["claim-1"] },
  ]),
});
assert.equal(invalidOptionalIndustry.identity.company, "Newlane University", "one malformed optional field must not discard valid claims");
assert.equal(invalidOptionalIndustry.identity.industry, null);

const validAbstentionWithBadSample = await identifyRecord(genericRecord, {
  analystAttempts: 3,
  runModel: runner([
    { name: null, company: null, product: null, website: null, industry: null, confidence: "low" },
    { name: null, company: null, product: null, website: null, industry: "solar", confidence: "low" },
    { name: null, company: null, product: null, website: null, industry: null, confidence: "low" },
  ]),
});
assert.equal(validAbstentionWithBadSample.identity.kind, "unknown");
assert.equal(validAbstentionWithBadSample.error, undefined, "a bad sample must not override valid abstentions");

const malformedVerifierRetry = await identifyRecord(namedRecord, {
  analystAttempts: 1,
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
    { acceptedClaimIds: ["claim-1"] },
    `{"acceptedClaimIds":["claim-1"],"reason":"The buyer said "hello"."}`,
    { acceptedClaimIds: ["claim-1"] },
  ]),
});
assert.equal(malformedVerifierRetry.identity.company, "Newlane University", "a malformed verifier response should be retried once");

const modelOutage = await identifyRecord(namedRecord, {
  analystAttempts: 2,
  runModel: async () => { throw new Error("provider returned no text"); },
});
assert.equal(modelOutage.identity.kind, "unknown");
assert.match(modelOutage.error || "", /provider returned no text/, "model outages must not look like valid unknown identities");

const providerStopped = new OpenCodeProviderStoppedError("test-model", 4);
await assert.rejects(
  () => identifyRecord(namedRecord, { analystAttempts: 2, runModel: async () => { throw providerStopped; } }),
  (error) => error === providerStopped,
  "a stopped provider must abort identity analysis instead of becoming a client error",
);

assert.equal((await identifyRecord(namedRecord, { useModel: false })).identity.kind, "unknown");

const buyerReviewRecord = {
  title: "Platform engineer",
  details: {
    buyer: {
      workHistory: [{
        jobInfo: { title: "Previous platform work" },
        feedbackToClient: { comment: "Samuel was clear, responsive, and provided everything needed." },
      }],
    },
  },
};
const buyerReviewSource = extractIdentitySignals(buyerReviewRecord).texts.find((source) => source.source === "review-to-client");
assert.deepEqual(buyerReviewSource && {
  source: buyerReviewSource.source,
  authorRole: buyerReviewSource.authorRole,
  subjectRole: buyerReviewSource.subjectRole,
}, {
  source: "review-to-client",
  authorRole: "freelancer",
  subjectRole: "upwork-client",
});

let reviewAnalystCalls = 0;
let reviewVerifierCalls = 0;
const identifiedFromBuyerReview = await identifyRecord(buyerReviewRecord, {
  analystAttempts: 3,
  verificationPasses: 2,
  runModel: async (prompt) => {
    assert.match(prompt, /"source":"review-to-client"/);
    assert.match(prompt, /"authorRole":"freelancer"/);
    assert.match(prompt, /"subjectRole":"upwork-client"/);
    if (prompt.includes("VERIFICATION PASS")) {
      reviewVerifierCalls++;
      return JSON.stringify({ acceptedClaimIds: ["claim-1"], reason: "The source identifies the buyer being reviewed." });
    }
    reviewAnalystCalls++;
    return JSON.stringify({
      name: { value: "Samuel", sourceId: "source-3", quote: "Samuel was clear, responsive" },
      company: null,
      product: null,
      website: null,
      industry: null,
      confidence: "medium",
    });
  },
});
assert.equal(identifiedFromBuyerReview.identity.kind, "identified");
assert.equal(identifiedFromBuyerReview.identity.name, "Samuel");
assert.equal(reviewAnalystCalls, 3);
assert.equal(reviewVerifierCalls, 2);

const representativeReviewRecord = {
  title: "Application developer",
  details: {
    buyer: {
      workHistory: [{
        jobInfo: { title: "Prototype application" },
        feedbackToClient: {
          comment: "Philip explained the goal, provided the assets, and gave feedback. He wanted the best result for his client.",
        },
      }],
    },
  },
};
const identifiedRepresentative = await identifyRecord(representativeReviewRecord, {
  analystAttempts: 1,
  verificationPasses: 2,
  runModel: async (prompt) => {
    assert.match(prompt, /hired them through the Upwork client account/i);
    assert.match(prompt, /end customer/i);
    if (prompt.includes("VERIFICATION PASS")) {
      return JSON.stringify({ acceptedClaimIds: ["claim-1"], reason: "Philip is the Upwork contracting counterpart." });
    }
    return JSON.stringify({
      name: { value: "Philip", sourceId: "source-3", quote: "Philip explained the goal, provided the assets, and gave feedback" },
      company: null,
      product: null,
      website: null,
      industry: null,
      confidence: "high",
    });
  },
});
assert.equal(identifiedRepresentative.identity.name, "Philip");

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
