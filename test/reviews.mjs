import assert from "node:assert/strict";
import { selectedPublicJobs } from "../src/past-jobs.ts";
import { normalizeReviewTitle, pickMatchingReview, reviewTitlesMatch, workHistoryFromRecord } from "../src/reviews.ts";
import { wellFormedJson } from "../src/run-files.ts";
import { parsePublicJobHtml } from "../src/upwork-browser.ts";

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

const unsortedPublicHistory = [
  { ...history[0], title: "Old", jobCiphertext: "~old", access: "PUBLIC_INDEX", startDate: "2023-01-01", endDate: "2023-02-01" },
  { ...history[0], title: "Latest", jobCiphertext: "~latest", access: "PUBLIC_INDEX", startDate: "2026-01-01", endDate: "2026-02-01" },
  { ...history[0], title: "Middle", jobCiphertext: "~middle", access: "PUBLIC_INDEX", startDate: "2025-01-01", endDate: "2025-02-01" },
  { ...history[0], title: "Latest duplicate", jobCiphertext: "~latest", access: "PUBLIC_INDEX", startDate: "2024-01-01", endDate: "2024-02-01" },
];
assert.deepEqual(selectedPublicJobs(unsortedPublicHistory).map((job) => job.jobCiphertext), ["~latest", "~middle", "~old"]);

const nuxtValues = [
  ["ShallowReactive", 1],
  { vuex: 2 },
  ["Reactive", 3],
  { jobDetails: 4 },
  { job: 5, workHistory: 8 },
  { description: 6, attachments: 10 },
  "The real public job description.",
  "A much longer but unrelated string that must never be selected as the job description.",
  [9],
  { feedbackToClient: 7 },
  [11],
  { fileName: 12, uri: 13 },
  "brief.pdf",
  "/att/download/openings/123/attachments/456/download",
];
const publicHtml = `<script type="application/json" id="__NUXT_DATA__">${JSON.stringify(nuxtValues)}</script>`;
assert.equal(parsePublicJobHtml(publicHtml)?.description, "The real public job description.");
assert.deepEqual(parsePublicJobHtml(publicHtml)?.attachments, [{ fileName: "brief.pdf", uri: "/att/download/openings/123/attachments/456/download" }]);
assert.equal(wellFormedJson({ text: `${"x".repeat(20)}\uD83D` }).includes("\\ud83d"), false);

console.log("review checks passed");
