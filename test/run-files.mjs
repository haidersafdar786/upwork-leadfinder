import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  acquireRunRootLock,
  createRunFolder,
  readRunManifest,
  readRunResult,
  writeRawJobRecord,
  writeRunResult,
} from "../src/run-files.ts";
import { processedJobIds } from "../src/run.ts";

const root = await mkdtemp(join("/tmp", "upwho-run-files-"));
const selection = { kind: "best-matches", url: "https://www.upwork.com/nx/find-work/best-matches" };
const job = {
  selection,
  id: "123",
  ciphertext: "~123",
  url: "https://www.upwork.com/jobs/~123",
  title: "Synthetic job",
  description: "Synthetic description",
  publishedAt: null,
  clientCountry: null,
};

const partialDirectory = await createRunFolder(selection, root, new Date("2026-08-05T10:00:00.000Z"));
await writeRawJobRecord(partialDirectory, job, { uid: "123" }, {}, []);
assert.equal(await readRunResult(partialDirectory), null, "a raw-only run must not look complete");
assert.deepEqual(await processedJobIds(root), new Set(), "partial raw data must not deduplicate a future run");

const client = {
  buyerId: "buyer-1",
  jobs: [],
  history: { totalSpent: null, totalHires: null, totalReviews: null, rating: null },
  evidence: [],
  identity: {
    kind: "unknown",
    status: "unknown",
    name: null,
    people: [],
    company: null,
    product: null,
    website: null,
    industry: null,
    evidenceStrength: "none",
    evidenceQuote: null,
    evidenceSource: null,
    evidenceSourceId: null,
    claimEvidence: { name: null, company: null, product: null, website: null, industry: null },
  },
  nameRecovery: { kind: "not-found", attempted: 0, succeeded: 0, failures: [] },
  webPresence: { personLinkedIn: null, companyLinkedIn: null, socials: [], verifiedSite: null, supportingLinks: [], emails: [], phones: [], whatsApp: [] },
  webEvidence: [],
};
const interruptedDirectory = await createRunFolder(selection, root, new Date("2026-08-05T10:00:30.000Z"));
const interruptedJob = { ...job, id: "interrupted-1", ciphertext: "~interrupted-1", url: "https://www.upwork.com/jobs/~interrupted-1" };
await writeRawJobRecord(interruptedDirectory, interruptedJob, { uid: "interrupted-1" }, {}, []);
await writeFile(join(interruptedDirectory, "result.json"), JSON.stringify({
  runId: basename(interruptedDirectory),
  feed: selection,
  startedAt: "2026-08-05T10:00:30.000Z",
  completedAt: "2026-08-05T10:00:31.000Z",
  clients: [client],
}) + "\n");
assert.equal(await readRunResult(interruptedDirectory), null, "a new result without a manifest must remain incomplete");
assert.equal((await processedJobIds(root)).has("interrupted-1"), false, "an interrupted result must not deduplicate its raw jobs");

const completeDirectory = await createRunFolder(selection, root, new Date("2026-08-05T10:01:00.000Z"));
await writeRawJobRecord(completeDirectory, job, { uid: "123" }, {}, []);
const result = {
  runId: basename(completeDirectory),
  feed: selection,
  startedAt: "2026-08-05T10:01:00.000Z",
  completedAt: "2026-08-05T10:02:00.000Z",
  clients: [client],
};
await writeRunResult(completeDirectory, result);
assert.equal((await readRunManifest(completeDirectory))?.status, "complete");
assert.equal((await readRunManifest(completeDirectory))?.dataFileCount, 1);
assert.deepEqual((await readRunResult(completeDirectory))?.clients, [client]);
await assert.rejects(
  () => writeRunResult(completeDirectory, { ...result, clients: [{ ...client, identity: { ...client.identity, claimEvidence: undefined } }] }),
  /Invalid input/,
  "invalid result data must be rejected before replacing a complete run",
);
assert.equal((await readRunManifest(completeDirectory))?.status, "complete");
assert.deepEqual((await readRunResult(completeDirectory))?.clients, [client]);

const legacyDirectory = await createRunFolder(selection, root, new Date("2026-08-05T10:03:00.000Z"));
const legacyJob = { ...job, id: "legacy-1", ciphertext: "~legacy-1", url: "https://www.upwork.com/jobs/~legacy-1" };
await writeRawJobRecord(legacyDirectory, legacyJob, { uid: "legacy-1" }, {}, []);
await writeFile(join(legacyDirectory, "result.json"), JSON.stringify({
  runId: basename(legacyDirectory),
  feed: selection,
  startedAt: "2026-08-05T10:03:00.000Z",
  completedAt: "2026-08-05T10:04:00.000Z",
  clients: [{
    buyerId: "legacy-buyer",
    jobs: [legacyJob],
    history: { totalSpent: null, totalHires: null, totalReviews: null, rating: null },
    evidence: [{ source: "description", text: "We are Legacy Labs." }],
    identity: {
      kind: "identified", name: null, people: [], company: "Legacy Labs", product: null, website: null, industry: null,
      confidence: "high", evidenceQuote: "We are Legacy Labs.",
    },
    webPresence: { personLinkedIn: null, companyLinkedIn: null, socials: [], verifiedSite: null, supportingLinks: [] },
    webEvidence: [],
  }],
}) + "\n");
const migratedLegacy = await readRunResult(legacyDirectory);
assert.equal(migratedLegacy?.clients[0]?.identity.status, "possible", "legacy identities must not be upgraded to verified");
assert.equal(migratedLegacy?.clients[0]?.identity.company, "Legacy Labs");
assert.equal(migratedLegacy?.clients[0]?.identity.claimEvidence.company?.source, "description");
assert.equal((await processedJobIds(root)).has("legacy-1"), true, "legacy complete runs must remain in deduplication");

const lock = await acquireRunRootLock(root);
await assert.rejects(() => acquireRunRootLock(root), /locked/);
await lock.release();
const secondLock = await acquireRunRootLock(root);
await secondLock.release();

console.log("run file checks passed");
