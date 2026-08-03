import assert from "node:assert/strict";
import { normalizeReviewTitle, pickMatchingReview, reviewTitlesMatch, workHistoryFromRecord } from "../src/reviews.ts";

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

console.log("review checks passed");
