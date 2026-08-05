import assert from "node:assert/strict";
import { selectHistoricalWebClientCandidate } from "../src/run.ts";

const identity = ({ name = null, company = null, product = null, website = null } = {}) => ({
  kind: "identified",
  name,
  people: name ? [name] : [],
  company,
  product,
  website,
  industry: null,
  confidence: "high",
  evidenceQuote: name || company || product || "fixture",
});

const unknownIdentity = {
  kind: "unknown",
  name: null,
  people: [],
  company: null,
  product: null,
  website: null,
  industry: null,
  confidence: "unknown",
  evidenceQuote: null,
};

const client = ({ candidateIdentity, webPresence, webEvidence = [] }) => ({
  buyerId: "buyer-1",
  jobs: [],
  history: { totalSpent: null, totalHires: null, totalReviews: null, rating: null },
  evidence: [],
  identity: candidateIdentity,
  nameRecovery: { kind: "not-found", attempted: 0, succeeded: 0, failures: [] },
  webPresence,
  webEvidence,
});

const targetIdentity = identity({ name: "Jill Morris", product: "Sole Sister Ramblers" });
const legacyCandidate = client({
  candidateIdentity: identity({ company: "Sole Sister Ramblers" }),
  webPresence: {
    personLinkedIn: "https://www.linkedin.com/in/jillybeanjam",
    companyLinkedIn: "https://www.linkedin.com/company/sole-sister-ramblers",
    socials: ["https://www.instagram.com/solesisterrambles/"],
    verifiedSite: "https://solesisterramblers.com/",
    supportingLinks: [{ url: "https://solesisterramblers.com/about", title: "About the community" }],
  },
});
const recoveredLegacy = selectHistoricalWebClientCandidate(legacyCandidate, targetIdentity);
assert.ok(recoveredLegacy, "a durable historical identity should survive legacy result shapes");
assert.equal(recoveredLegacy.webPresence.verifiedSite, "https://solesisterramblers.com/");
assert.deepEqual(recoveredLegacy.webPresence.emails, []);
assert.deepEqual(recoveredLegacy.webPresence.phones, []);
assert.deepEqual(recoveredLegacy.webPresence.whatsApp, []);
assert.deepEqual(recoveredLegacy.webEvidence, []);

const contactOnly = selectHistoricalWebClientCandidate(
  client({
    candidateIdentity: identity({ name: "Narii" }),
    webPresence: {
      personLinkedIn: null,
      companyLinkedIn: null,
      socials: [],
      verifiedSite: null,
      supportingLinks: [],
      emails: ["narii@example.com"],
      phones: [],
      whatsApp: [],
    },
  }),
  identity({ name: "Narii" }),
);
assert.equal(contactOnly, null, "an email-only historical match must not revive a buyer identity");

const personOnlyTarget = identity({ name: "Josh B" });
const employerLinks = selectHistoricalWebClientCandidate(
  client({
    candidateIdentity: personOnlyTarget,
    webPresence: {
      personLinkedIn: "https://www.linkedin.com/in/josh-bacon",
      companyLinkedIn: "https://www.linkedin.com/company/former-employer",
      socials: [],
      verifiedSite: "https://josh.example/",
      supportingLinks: [{ url: "https://www.linkedin.com/company/former-employer", title: "Former employer" }],
      emails: [],
      phones: [],
      whatsApp: [],
    },
  }),
  personOnlyTarget,
);
assert.ok(employerLinks);
assert.equal(employerLinks.webPresence.personLinkedIn, "https://www.linkedin.com/in/josh-bacon");
assert.equal(employerLinks.webPresence.companyLinkedIn, null, "a person-only buyer must not inherit an employer company page");
assert.deepEqual(employerLinks.webPresence.supportingLinks, []);

const organizationWithoutPerson = selectHistoricalWebClientCandidate(
  client({
    candidateIdentity: identity({ company: "Acme Labs" }),
    webPresence: {
      personLinkedIn: "https://www.linkedin.com/in/acme-employee",
      companyLinkedIn: "https://www.linkedin.com/company/acme-labs",
      socials: [],
      verifiedSite: "https://acme.example/",
      supportingLinks: [],
      emails: [],
      phones: [],
      whatsApp: [],
    },
  }),
  identity({ company: "Acme Labs" }),
);
assert.ok(organizationWithoutPerson);
assert.equal(organizationWithoutPerson.webPresence.personLinkedIn, null, "an organization buyer must not inherit an employee profile");
assert.equal(organizationWithoutPerson.webPresence.companyLinkedIn, "https://www.linkedin.com/company/acme-labs");

const unknownBuyerHistory = selectHistoricalWebClientCandidate(
  client({
    candidateIdentity: unknownIdentity,
    webPresence: {
      personLinkedIn: null,
      companyLinkedIn: "https://www.linkedin.com/company/unknown-buyer",
      socials: [],
      verifiedSite: "https://unknown.example/",
      supportingLinks: [],
      emails: [],
      phones: [],
      whatsApp: [],
    },
  }),
  unknownIdentity,
);
assert.equal(unknownBuyerHistory, null, "an unknown buyer must not inherit historical web identity");

const mismatched = selectHistoricalWebClientCandidate(
  client({
    candidateIdentity: identity({ company: "Other Labs" }),
    webPresence: {
      personLinkedIn: null,
      companyLinkedIn: "https://www.linkedin.com/company/other-labs",
      socials: [],
      verifiedSite: "https://other.example/",
      supportingLinks: [],
      emails: [],
      phones: [],
      whatsApp: [],
    },
  }),
  identity({ company: "Acme Labs" }),
);
assert.equal(mismatched, null, "historical web presence must not cross identity anchors");

console.log("run checks passed");
