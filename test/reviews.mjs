import assert from "node:assert/strict";
import { applyRecoveredName, normalizeReviewTitle, pickMatchingReview, reviewTitlesMatch, workHistoryFromRecord } from "../src/reviews.ts";

assert.equal(normalizeReviewTitle("Logo + Full Brand Kit"), "logo full brand kit");
assert.equal(reviewTitlesMatch("Packaging Design", "Packaging Design"), true);
assert.equal(reviewTitlesMatch("Packaging Design", "Packaging Design for a Cigar Brand"), false);

const duplicateReviews = [
  { assignmentTitle: "Same Contract", assignmentEndedOn: "2024-01-10", clientFirstName: "A", clientLastName: null, score: 5, text: "first" },
  { assignmentTitle: "Same Contract", assignmentEndedOn: "2025-01-10", clientFirstName: "B", clientLastName: null, score: 5, text: "second" },
];
assert.equal(pickMatchingReview(duplicateReviews, "Same Contract", "2025-01-05")?.clientFirstName, "B");
assert.equal(pickMatchingReview(duplicateReviews, "Same Contract", null), null);

const record = {
  details: {
    buyer: {
      workHistory: [
        { feedback: { score: 5 }, jobInfo: { title: "Reviewed", id: "1", ciphertext: "~01a" }, contractorInfo: { contractorName: "Freelancer A", ciphertext: "~01profile" } },
        { feedback: null, jobInfo: { title: "Unreviewed", id: "2", ciphertext: "~02b" }, contractorInfo: { contractorName: "Freelancer B", ciphertext: "~02profile" } },
      ],
    },
  },
};
const history = workHistoryFromRecord(record);
assert.equal(history.length, 2);
assert.equal(history[0].reviewed, true);
assert.equal(history[1].reviewed, false);
assert.equal(history[0].jobCiphertext, "~01a");
assert.equal(history[0].freelancerCiphertext, "~01profile");

const identity = applyRecoveredName(
  { kind: "unknown", name: null, people: [], company: null, product: null, website: null, industry: null, confidence: "unknown", evidenceQuote: null },
  {
    clientName: "A. Client",
    agreement: 2,
    viaFreelancer: "Freelancer A",
    matchedJob: "Reviewed",
    reviewTitle: "Reviewed",
    freelancerId: "123",
    score: 5,
    otherNames: [],
  }
);
assert.equal(identity.kind, "identified");
assert.equal(identity.name, "A. Client");
assert.equal(identity.evidenceQuote, "A. Client");

console.log("review checks passed");
