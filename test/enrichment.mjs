import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildEnrichmentQueries, completeSelectionFromEvidence, evidenceFromOpenCodeTools, parseVerification, removeDefinitivelyDeadLinks, resolveWebPresence, retainSelectedEvidence } from "../src/enrichment.ts";

const labels = JSON.parse(readFileSync(new URL("./enrichment-labels.json", import.meta.url), "utf8"));
const squish = (value) => (value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const valueFor = (presence, field) => ({
  personLinkedin: presence.personLinkedIn,
  companyLinkedin: presence.companyLinkedIn,
  website: presence.verifiedSite,
})[field] || null;
const matches = (actual, expected) => expected === null ? !actual : Boolean(actual && squish(actual).includes(squish(expected)));
const verification = (values = {}) => ({ personLinkedin: false, companyLinkedin: false, website: false, socials: [], emails: [], phones: [], whatsApp: [], supportingLinks: [], reason: "fixture", ...values });
const verifiedTwice = (values = {}) => [verification(values), verification(values)];

// Models sometimes echo the selected URL instead of the verifier's requested boolean. The boundary
// parser should accept that equivalent answer rather than failing an otherwise complete enrichment run.
const stringFlagVerification = parseVerification(JSON.stringify({
  personLinkedin: "false",
  companyLinkedin: "https://www.linkedin.com/company/acme",
  website: "https://acme.example/",
  socials: [],
  emails: [],
  phones: [],
  whatsApp: [],
  supportingLinks: [],
  reason: "observed evidence supports the selected links",
}));
assert.deepEqual(stringFlagVerification, {
  personLinkedin: false,
  companyLinkedin: true,
  website: true,
  socials: [],
  emails: [],
  phones: [],
  whatsApp: [],
  supportingLinks: [],
  reason: "observed evidence supports the selected links",
});

let pass = 0;
let total = 0;
for (const name of Object.keys(labels).filter((key) => !key.startsWith("_"))) {
  const fixture = JSON.parse(readFileSync(new URL(`./enrichment-fixtures/${name}.json`, import.meta.url), "utf8"));
  const expected = labels[name];
  const selected = (field) => {
    const value = expected[field];
    if (typeof value !== "string") return null;
    return fixture.results.find((result) => {
      if (!squish(result.url).includes(squish(value))) return false;
      if (field === "companyLinkedin") return /linkedin\.com\/company\//i.test(result.url);
      if (field === "personLinkedin") return /linkedin\.com\/in\//i.test(result.url);
      return !/linkedin\.com/i.test(result.url);
    })?.url || null;
  };
  const model = {
    personLinkedin: selected("personLinkedin"),
    companyLinkedin: selected("companyLinkedin"),
    website: selected("website"),
    socials: [],
    emails: [],
    phones: [],
    whatsApp: [],
    confidence: "high",
  };
  const presence = resolveWebPresence(fixture.known, fixture.results, model, verifiedTwice({
    personLinkedin: Boolean(model.personLinkedin),
    companyLinkedin: Boolean(model.companyLinkedin),
    website: Boolean(model.website),
  }));
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
  { website: "https://example.com/CasePath/", confidence: "high" },
  verifiedTwice({ website: true })
);
assert.equal(exactObserved.verifiedSite, "https://example.com/CasePath/");

const normalizedInsteadOfCopied = resolveWebPresence(
  { name: null, people: [], company: "Case Path", product: null, website: "example.com", industry: null, location: null, evidence: null },
  [{ url: "https://example.com/CasePath/", title: "Case Path", snippet: "Official company website" }],
  { website: "http://example.com/casepath", confidence: "high" },
  verifiedTwice({ website: true })
);
assert.equal(normalizedInsteadOfCopied.verifiedSite, null);

const publicContacts = resolveWebPresence(
  { name: "Ada Person", people: ["Ada Person"], company: "Acme", product: null, website: "https://acme.example", industry: null, location: null, evidence: "Acme public contact details" },
  [{ url: "https://acme.example/contact", title: "Contact Acme", snippet: "Email hello@acme.example or call +1 (415) 555-0199. WhatsApp https://wa.me/14155550199" }],
  { website: "https://acme.example/contact", emails: ["hello@acme.example"], phones: ["+1 (415) 555-0199"], whatsApp: ["https://wa.me/14155550199"], confidence: "high" },
  verifiedTwice({ website: true, emails: ["hello@acme.example"], phones: ["+1 (415) 555-0199"], whatsApp: ["https://wa.me/14155550199"] })
);
assert.deepEqual(publicContacts.emails, ["hello@acme.example"]);
assert.deepEqual(publicContacts.phones, ["+1 (415) 555-0199"]);
assert.deepEqual(publicContacts.whatsApp, ["https://wa.me/14155550199"]);

const omittedOfficialContacts = resolveWebPresence(
  { name: "Ada Person", people: ["Ada Person"], company: "Acme", product: null, website: "https://acme.example", industry: null, location: null, evidence: "Acme public contact details" },
  [{ url: "https://acme.example/", title: "Acme", snippet: "Contact media@acme.example or call +1 808-400-5055." }],
  { website: "https://acme.example/", emails: [], phones: [], whatsApp: [], confidence: "high" },
  verifiedTwice({ website: true, emails: ["media@acme.example"], phones: ["+1 808-400-5055"] })
);
assert.deepEqual(omittedOfficialContacts.emails, ["media@acme.example"]);
assert.deepEqual(omittedOfficialContacts.phones, ["+1 808-400-5055"]);

const searchOnlyContact = resolveWebPresence(
  { name: "Ada Person", people: ["Ada Person"], company: "Acme", product: null, website: "https://acme.example", industry: null, location: null, evidence: "Acme public contact details" },
  [
    { url: "https://acme.example/", title: "Acme", snippet: "Official Acme website.", source: "webfetch", fetchedFrom: "https://acme.example/" },
    { url: "https://acme.example/contact", title: "Search result", snippet: "A search index lists stale@acme.example.", source: "websearch", fetchedFrom: null },
  ],
  { website: "https://acme.example/", emails: ["stale@acme.example"], phones: [], whatsApp: [], confidence: "high" },
  verifiedTwice({ website: true, emails: ["stale@acme.example"] })
);
assert.deepEqual(searchOnlyContact.emails, []);

const multipleOrganizationProfiles = resolveWebPresence(
  { name: "Ada Person", people: ["Ada Person"], company: "Acme Labs", product: "Acme Cloud", website: "https://cloud.acme.example", industry: null, location: null, evidence: "Acme Cloud by Acme Labs" },
  [
    { url: "https://cloud.acme.example", title: "Acme Cloud", snippet: "Acme Cloud by Acme Labs" },
    { url: "https://www.linkedin.com/company/acme-labs", title: "Acme Labs", snippet: "Acme Cloud by Acme Labs" },
    { url: "https://www.linkedin.com/company/acme-cloud", title: "Acme Cloud", snippet: "Official Acme Cloud LinkedIn" },
  ],
  {
    website: "https://cloud.acme.example",
    companyLinkedin: "https://www.linkedin.com/company/acme-labs",
    supportingLinks: [{ url: "https://www.linkedin.com/company/acme-cloud", title: "Acme Cloud on LinkedIn" }],
    confidence: "high",
  },
  verifiedTwice({ website: true, companyLinkedin: true, supportingLinks: ["https://www.linkedin.com/company/acme-cloud"] })
);
assert.deepEqual(multipleOrganizationProfiles.supportingLinks, [{ url: "https://www.linkedin.com/company/acme-cloud", title: "Acme Cloud on LinkedIn" }]);

const completedOfficialSelection = completeSelectionFromEvidence(
  { name: "Ada Person", people: ["Ada Person"], company: "Acme Labs", product: "Acme Cloud", website: "https://cloud.acme.example", industry: null, location: null, evidence: "Acme Cloud by Acme Labs" },
  {
    personLinkedin: "https://www.linkedin.com/in/ada-person",
    companyLinkedin: "https://www.linkedin.com/company/acme-labs",
    website: "https://cloud.acme.example",
    socials: [],
    emails: [],
    phones: [],
    whatsApp: [],
    supportingLinks: [],
    summary: null,
    confidence: "high",
  },
  [
    { title: "Acme Cloud", url: "https://cloud.acme.example", snippet: "Contact media@cloud.acme.example or +1 808-400-5055.", source: "webfetch", query: null, callID: "fetch-cloud", fetchedFrom: "https://cloud.acme.example" },
    { title: "Acme Cloud directory result", url: "https://cloud.acme.example/contact", snippet: "A search index lists stale@cloud.acme.example.", source: "websearch", query: "cloud.acme.example contact", callID: "search-contact", fetchedFrom: null },
    { title: "Linked from Acme Cloud", url: "https://www.linkedin.com/company/acme-cloud", snippet: "Official Acme Cloud LinkedIn", source: "webfetch", query: null, callID: "fetch-cloud", fetchedFrom: "https://cloud.acme.example" },
    { title: "Linked from Acme Cloud", url: "https://www.facebook.com/acme-cloud", snippet: "Official Acme Cloud Facebook", source: "webfetch", query: null, callID: "fetch-cloud", fetchedFrom: "https://cloud.acme.example" },
    { title: "Acme Labs", url: "https://www.linkedin.com/company/acme-labs", snippet: "Acme Cloud by Acme Labs", source: "websearch", query: "Acme Labs linkedin", callID: "search-labs", fetchedFrom: null },
    { title: "Ada Person", url: "https://www.linkedin.com/in/ada-person", snippet: "Founder of Acme Cloud", source: "websearch", query: "Ada Person cloud.acme.example linkedin", callID: "search-ada", fetchedFrom: null },
  ],
);
assert.deepEqual(completedOfficialSelection.emails, ["media@cloud.acme.example"]);
assert.deepEqual(completedOfficialSelection.phones, ["+1 808-400-5055"]);
assert.deepEqual(completedOfficialSelection.socials, ["https://www.facebook.com/acme-cloud"]);
assert.deepEqual(completedOfficialSelection.supportingLinks, [{ url: "https://www.linkedin.com/company/acme-cloud", title: "cloud.acme.example LinkedIn" }]);

const withoutDeadLinks = removeDefinitivelyDeadLinks({
  ...multipleOrganizationProfiles,
  socials: ["https://x.example/acme", "https://x.example/old-acme"],
  supportingLinks: [
    ...multipleOrganizationProfiles.supportingLinks,
    { url: "https://social.example/retired", title: "Retired profile" },
  ],
}, new Map([
  ["https://x.example/acme", 200],
  ["https://x.example/old-acme", 404],
  ["https://social.example/retired", 410],
]));
assert.deepEqual(withoutDeadLinks.socials, ["https://x.example/acme"]);
assert.deepEqual(withoutDeadLinks.supportingLinks, [{ url: "https://www.linkedin.com/company/acme-cloud", title: "Acme Cloud on LinkedIn" }]);

const disputedContacts = resolveWebPresence(
  { name: "Ada Person", people: ["Ada Person"], company: "Acme", product: null, website: "https://acme.example", industry: null, location: null, evidence: "Acme public contact details" },
  [{ url: "https://acme.example/contact", title: "Contact Acme", snippet: "Email hello@acme.example or call +1 (415) 555-0199." }],
  { website: "https://acme.example/contact", emails: ["hello@acme.example"], phones: ["+1 (415) 555-0199"], whatsApp: [], confidence: "high" },
  [
    verification({ website: true, emails: ["hello@acme.example"], phones: ["+1 (415) 555-0199"] }),
    verification({ website: true, emails: ["hello@acme.example"] }),
  ]
);
assert.deepEqual(disputedContacts.emails, ["hello@acme.example"]);
assert.deepEqual(disputedContacts.phones, []);

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
  { website: "https://acme.example/about", emails: ["sales@directory.example"], phones: ["+1 (212) 555-0100"], whatsApp: [], confidence: "high" },
  verifiedTwice({ website: true, emails: ["sales@directory.example"], phones: ["+1 (212) 555-0100"] })
);
assert.deepEqual(directoryContacts.emails, []);
assert.deepEqual(directoryContacts.phones, []);

const genericOrganization = resolveWebPresence(
  { name: null, people: [], company: "Solar", product: null, website: null, industry: "solar software", location: "GBR", evidence: "AI assistant for solar and electrical installers" },
  [{ url: "https://solarconnect.solar/contact", title: "Solar Connect", snippet: "Software for solar installers. Email connect@solarconnect.co.in or call 1800 890 2450." }],
  { website: "https://solarconnect.solar/contact", emails: ["connect@solarconnect.co.in"], phones: ["1800 890 2450"], whatsApp: [], confidence: "high" },
  verifiedTwice({ website: false, emails: ["connect@solarconnect.co.in"], phones: ["1800 890 2450"] })
);
assert.equal(genericOrganization.verifiedSite, null);
assert.deepEqual(genericOrganization.emails, []);
assert.deepEqual(genericOrganization.phones, []);
assert.deepEqual(buildEnrichmentQueries({ name: "Jacob J", people: ["Jacob J"], company: null, product: null, website: null, industry: null, location: "USA", evidence: null }), []);
assert.ok(buildEnrichmentQueries({ name: null, people: [], company: "Sole Sister Ramblers", product: null, website: null, industry: null, location: "USA", evidence: null }).length > 0);
const multiAnchorQueries = buildEnrichmentQueries({ name: "Ada Person", people: ["Ada Person"], company: "Acme Labs", product: "Acme Cloud", website: "https://cloud.acme.example", industry: null, location: null, evidence: null });
assert.equal(multiAnchorQueries.some((query) => query === "Ada Person cloud.acme.example linkedin"), true);
assert.equal(multiAnchorQueries.some((query) => query === "Acme Labs linkedin"), true);
assert.equal(multiAnchorQueries.some((query) => query === "Acme Cloud linkedin"), true);
assert.equal(multiAnchorQueries.some((query) => query === "cloud.acme.example contact"), true);

const crossDomainEmail = resolveWebPresence(
  { name: null, people: [], company: "Acme Instruments", product: null, website: "https://acme.example", industry: null, location: null, evidence: "Acme Instruments" },
  [{ url: "https://acme.example/contact", title: "Contact Acme Instruments", snippet: "Email sales@acme.example. Our distributor is partner@unrelated.example." }],
  { website: "https://acme.example/contact", emails: ["sales@acme.example", "partner@unrelated.example"], phones: [], whatsApp: [], confidence: "high" },
  verifiedTwice({ website: true, emails: ["sales@acme.example", "partner@unrelated.example"] })
);
assert.deepEqual(crossDomainEmail.emails, ["sales@acme.example"]);

const fetchedEvidence = evidenceFromOpenCodeTools([{
  tool: "webfetch",
  callID: "fetch-1",
  state: {
    status: "completed",
    input: { url: "https://acme.example/contact" },
    output: "Contact Acme at sales@acme.example. Follow https://social.example/acme and see https://unrelated.example/directory.",
  },
}]);
assert.deepEqual(fetchedEvidence.map((item) => item.url), [
  "https://acme.example/contact",
  "https://social.example/acme",
  "https://unrelated.example/directory",
]);
assert.equal(fetchedEvidence[1].fetchedFrom, "https://acme.example/contact");

const lateContactEvidence = evidenceFromOpenCodeTools([{
  tool: "webfetch",
  callID: "fetch-late-contact",
  state: {
    status: "completed",
    input: { url: "https://acme.example" },
    output: `${"About Acme. ".repeat(100)} Contact media@acme.example or +1 808-400-5055.`,
  },
}]);
assert.equal(lateContactEvidence[0].snippet.includes("media@acme.example"), true);
assert.equal(lateContactEvidence[0].snippet.includes("+1 808-400-5055"), true);

const duplicateOfficialSiteEvidence = evidenceFromOpenCodeTools([
  {
    tool: "websearch",
    callID: "search-official",
    state: {
      status: "completed",
      input: { query: "acme.example" },
      output: "Title: Acme\nURL: https://acme.example/\nHighlights:\nA directory lists help@acme.example.",
    },
  },
  {
    tool: "webfetch",
    callID: "fetch-official",
    state: {
      status: "completed",
      input: { url: "https://acme.example/" },
      output: "Official Acme website. Contact media@acme.example or +1 808-400-5055.",
    },
  },
]);
const retainedOfficialSite = duplicateOfficialSiteEvidence.find((item) => item.url === "https://acme.example/");
assert.equal(retainedOfficialSite?.source, "webfetch");
assert.equal(retainedOfficialSite?.snippet.includes("media@acme.example"), true);
assert.equal(retainedOfficialSite?.snippet.includes("+1 808-400-5055"), true);
assert.equal(retainedOfficialSite?.snippet.includes("help@acme.example"), false);

const linkedSearchEvidence = evidenceFromOpenCodeTools([{
  tool: "websearch",
  callID: "search-1",
  state: {
    status: "completed",
    input: { query: "Alex Example Acme Labs linkedin" },
    output: "Title: Alex Example\nURL: https://www.linkedin.com/in/alex-example\nHighlights:\nFounder - [Acme Labs](https://www.linkedin.com/company/acme-labs)",
  },
}]);
assert.deepEqual(linkedSearchEvidence.map((item) => item.url), [
  "https://www.linkedin.com/in/alex-example",
  "https://www.linkedin.com/company/acme-labs",
]);
assert.equal(linkedSearchEvidence[1].fetchedFrom, "https://www.linkedin.com/in/alex-example");

const unicodeEvidence = evidenceFromOpenCodeTools([{
  tool: "websearch",
  callID: "search-unicode",
  state: {
    status: "completed",
    input: { query: "unicode" },
    output: `Title: Unicode\nURL: https://example.com/unicode\nHighlights:\n${"x".repeat(499)}🧘`,
  },
}]);
assert.equal(/[\uD800-\uDBFF]$/.test(unicodeEvidence[0].snippet), false);

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
