import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolveWebPresence, retainSelectedEvidence } from "../src/enrichment.ts";

const labels = JSON.parse(readFileSync(new URL("./enrichment-labels.json", import.meta.url), "utf8"));
const squish = (value) => (value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const valueFor = (presence, field) => ({
  personLinkedin: presence.personLinkedIn,
  companyLinkedin: presence.companyLinkedIn,
  website: presence.verifiedSite,
})[field] || null;
const matches = (actual, expected) => expected === null ? !actual : Boolean(actual && squish(actual).includes(squish(expected)));

let pass = 0;
let total = 0;
for (const name of Object.keys(labels).filter((key) => !key.startsWith("_"))) {
  const fixture = JSON.parse(readFileSync(new URL(`./enrichment-fixtures/${name}.json`, import.meta.url), "utf8"));
  const presence = resolveWebPresence(fixture.known, fixture.results);
  for (const field of Object.keys(labels[name]).filter((key) => key !== "note")) {
    total++;
    assert.equal(matches(valueFor(presence, field), labels[name][field]), true, `${name} ${field}`);
    pass++;
  }
}

const unrelated = resolveWebPresence(
  { name: null, people: [], company: "Acme", product: null, website: null, industry: null, location: null, evidence: null },
  [{ url: "https://example.com", title: "Unrelated result", snippet: "Nothing relevant" }],
  { website: "https://example.com", confidence: "high" }
);
assert.equal(unrelated.verifiedSite, null);

const sameNameDomain = resolveWebPresence(
  { name: "Alpay", people: ["Alpay"], company: "SecurApp", product: "SecurApp", website: null, industry: "privacy rights SaaS", location: "Germany", evidence: "GDPR access, deletion, correction and objection" },
  [{ url: "https://securapp.securapp.co/", title: "Secur App - Login", snippet: "Aplicación colombiana de gestión de riesgos" }],
  { website: "https://securapp.securapp.co/", confidence: "high" }
);
assert.equal(sameNameDomain.verifiedSite, null);

const ambiguous = resolveWebPresence(
  { name: null, people: [], company: "Movatech", product: null, website: null, industry: null, location: "Gijon, Spain", evidence: null },
  [
    { url: "https://linkedin.com/company/movatech", title: "Movatech", snippet: "Chatbot company" },
    { url: "https://linkedin.com/company/movatech-solutions", title: "MovaTech Solutions", snippet: "Software company" },
  ]
);
assert.equal(ambiguous.companyLinkedIn, null);

const exactObserved = resolveWebPresence(
  { name: null, people: [], company: "Case Path", product: null, website: "example.com", industry: null, location: null, evidence: null },
  [{ url: "https://example.com/CasePath/", title: "Case Path", snippet: "Official company website" }],
  { website: "http://example.com/casepath", confidence: "high" }
);
assert.equal(exactObserved.verifiedSite, "https://example.com/CasePath/");

const publicContacts = resolveWebPresence(
  { name: "Ada Person", people: ["Ada Person"], company: "Acme", product: null, website: "https://acme.example", industry: null, location: null, evidence: "Acme public contact details" },
  [{ url: "https://acme.example/contact", title: "Contact Acme", snippet: "Email hello@acme.example or call +1 (415) 555-0199. WhatsApp https://wa.me/14155550199" }],
  { website: "https://acme.example/contact", confidence: "high" }
);
assert.deepEqual(publicContacts.emails, ["hello@acme.example"]);
assert.deepEqual(publicContacts.phones, ["+1 (415) 555-0199"]);
assert.deepEqual(publicContacts.whatsApp, ["https://wa.me/14155550199"]);

const unrelatedContacts = resolveWebPresence(
  { name: null, people: [], company: "Acme", product: null, website: null, industry: null, location: null, evidence: null },
  [{ url: "https://unrelated.example/contact", title: "Different company", snippet: "other@unrelated.example +1 212 555 0100" }]
);
assert.deepEqual(unrelatedContacts.emails, []);
assert.deepEqual(unrelatedContacts.phones, []);

const directoryContacts = resolveWebPresence(
  { name: null, people: [], company: "Acme", product: null, website: null, industry: "software", location: null, evidence: null },
  [
    { url: "https://acme.example/about", title: "Acme", snippet: "Official software company" },
    { url: "https://directory.example/acme-alternatives", title: "Acme alternatives", snippet: "Contact sales@directory.example or call +1 (212) 555-0100" },
  ],
  { website: "https://acme.example/about", confidence: "high" }
);
assert.deepEqual(directoryContacts.emails, []);
assert.deepEqual(directoryContacts.phones, []);

const evidence = Array.from({ length: 65 }, (_, index) => ({
  title: "Evidence " + index,
  url: "https://evidence.example/" + index,
  snippet: "Observed",
  source: "websearch",
  query: "q",
  callID: "call",
  fetchedFrom: null,
}));
const selected = { personLinkedIn: null, companyLinkedIn: evidence[63].url, verifiedSite: evidence[64].url, socials: [], supportingLinks: [], confidence: "medium" };
const retained = retainSelectedEvidence(evidence, selected, 60);
assert.equal(retained.length, 60);
assert.equal(retained.some((item) => item.url === evidence[63].url), true);
assert.equal(retained.some((item) => item.url === evidence[64].url), true);
assert.throws(() => retainSelectedEvidence(evidence, { ...selected, verifiedSite: "https://missing.example" }));

console.log(`enrichment checks passed: ${pass}/${total} fixture fields`);
