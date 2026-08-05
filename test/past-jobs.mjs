import assert from "node:assert/strict";
import { CHALLENGE_FAILURE, NAVIGATION_LIMIT_FAILURE, gatherPastJobs, navigationLimitFromEnvironment } from "../src/past-jobs.ts";
import { fetchPublicJobState, isChallengeResponse, isChallengeUrl } from "../src/upwork-browser.ts";

assert.equal(navigationLimitFromEnvironment("0"), 0, "zero is a valid rendered-page budget");
assert.equal(navigationLimitFromEnvironment("-1"), -1, "-1 keeps the unlimited sentinel");
assert.equal(navigationLimitFromEnvironment(undefined), -1, "missing budgets use the unlimited default");
assert.equal(navigationLimitFromEnvironment(""), -1, "empty budgets use the unlimited default");
assert.equal(navigationLimitFromEnvironment("not-a-number"), -1, "invalid budgets use the unlimited default");

const nuxtValues = (description, attachment) => [
  ["ShallowReactive", 1],
  { vuex: 2 },
  ["Reactive", 3],
  { jobDetails: 4 },
  { job: 5 },
  { description: 6, attachments: 8 },
  description,
  null,
  attachment ? [9] : [],
  { fileName: 10, uri: 11 },
  attachment?.fileName || null,
  attachment?.uri || null,
];

function publicJobHtml(description, attachment) {
  const state = JSON.stringify(nuxtValues(description, attachment));
  return `<!doctype html><html><head><title>x</title></head><body>${"filler ".repeat(2_000)}<script type="application/json" id="__NUXT_DATA__">${state}</script></body></html>`;
}

// A page stub that runs the evaluated callback against a scripted fetch, the way the browser would.
function fakePage({ responses, onFetch = () => {} }) {
  let live = 0;
  let peak = 0;
  return {
    responses,
    peakConcurrency: () => peak,
    context: () => ({}),
    url: () => "https://www.upwork.com/jobs/x",
    goto: async () => {},
    waitForTimeout: async () => {},
    evaluate: async (callback, argument) => {
      // The rendered read takes no argument and inspects the page's own state, which a stub never has.
      if (argument === undefined) return null;
      const original = globalThis.fetch;
      globalThis.fetch = async (path) => {
        live++;
        peak = Math.max(peak, live);
        onFetch(path);
        await new Promise((resolve) => setTimeout(resolve, 20));
        live--;
        const response = responses.get(path);
        if (!response) throw new Error(`unexpected request ${path}`);
        return { status: response.status, text: async () => response.html || "", body: null };
      };
      try {
        return await callback(argument);
      } finally {
        globalThis.fetch = original;
      }
    },
  };
}

const attachment = { fileName: "brief.pdf", uri: "/att/download/openings/1/attachments/2/download" };
const challengeHtml = `<!doctype html><html><head><title>Challenge - Upwork</title></head><body>__cf_chl_tk=abc</body></html>`;

// Only the embedded state crosses back out of the page, and it parses to the same job.
const single = fakePage({ responses: new Map([["/jobs/~one", { status: 200, html: publicJobHtml("A described job.", attachment) }]]) });
const read = await fetchPublicJobState(single, "~one");
assert.equal(read.kind, "job");
assert.equal(read.job.description, "A described job.");
assert.deepEqual(read.job.attachments, [attachment]);

const missing = fakePage({ responses: new Map([["/jobs/~gone", { status: 404, html: "not found" }]]) });
assert.equal((await fetchPublicJobState(missing, "~gone")).kind, "unavailable", "a plain miss still lets the caller fall back");

const blocked = fakePage({ responses: new Map([["/jobs/~blocked", { status: 403, html: challengeHtml }]]) });
assert.equal((await fetchPublicJobState(blocked, "~blocked")).kind, "challenged", "a bot check is reported as such");

assert.equal(isChallengeResponse(403, challengeHtml), true);
assert.equal(isChallengeResponse(200, challengeHtml), false, "a served page is not a challenge whatever it says");
assert.equal(isChallengeResponse(403, "<html><body>forbidden</body></html>"), false, "a plain refusal is not a challenge");
assert.equal(isChallengeUrl("https://www.upwork.com/jobs/~02?__cf_chl_tk=abc"), true);
assert.equal(isChallengeUrl("https://www.upwork.com/jobs/~02"), false);

// A page that never answers must fail the read rather than hold the research page for the whole run.
const stalledPage = {
  context: () => ({}),
  url: () => "https://www.upwork.com/jobs/x",
  goto: async () => {},
  waitForTimeout: async () => {},
  evaluate: () => new Promise(() => {}),
};
const stalledStarted = Date.now();
await assert.rejects(
  () => fetchPublicJobState(stalledPage, "~stalled", 150),
  /did not finish within/,
  "a read that never settles must time out",
);
assert.ok(Date.now() - stalledStarted < 30_000, "the timeout must not wait out the default budget");

const workHistory = (ciphertexts) => ({
  details: {
    buyer: {
      workHistory: ciphertexts.map((ciphertext, index) => ({
        jobInfo: { title: `Job ${ciphertext}`, id: String(index + 1), ciphertext, access: "PUBLIC_INDEX" },
        contractorInfo: { contractorName: "Freelancer", ciphertext: `~profile${index}` },
        startDate: `2026-01-0${index + 1}`,
        endDate: `2026-02-0${index + 1}`,
      })),
    },
  },
});

// Past jobs are read together, and the results stay in the newest-first order the selection produced.
const ciphertexts = ["~a", "~b", "~c", "~d"];
const responses = new Map(ciphertexts.map((ciphertext) => [`/jobs/${ciphertext}`, { status: 200, html: publicJobHtml(`Description ${ciphertext}`, null) }]));
const many = fakePage({ responses });
const research = await gatherPastJobs(many, workHistory(ciphertexts), { concurrency: 4 });
assert.equal(research.attempted, 4);
assert.deepEqual(research.failures, []);
assert.deepEqual(research.items.map((item) => item.ciphertext), ["~d", "~c", "~b", "~a"]);
assert.deepEqual(research.items.map((item) => item.description), ["Description ~d", "Description ~c", "Description ~b", "Description ~a"]);
assert.ok(many.peakConcurrency() > 1, `past-job reads should overlap, saw peak ${many.peakConcurrency()}`);

// Only the newest four and oldest four public jobs are read: the middle of a long history is skipped,
// which the stub proves by never being asked for those pages.
const longHistory = {
  details: {
    buyer: {
      workHistory: ["~a", "~b", "~c", "~d", "~e", "~f", "~g", "~h", "~i", "~j"].map((ciphertext, index) => ({
        jobInfo: { title: `Job ${ciphertext}`, id: String(index + 1), ciphertext, access: "PUBLIC_INDEX" },
        contractorInfo: { contractorName: "Freelancer", ciphertext: `~profile${index}` },
        startDate: `2026-01-${String(index + 1).padStart(2, "0")}`,
        endDate: `2026-02-${String(index + 1).padStart(2, "0")}`,
      })),
    },
  },
};
const windowed = ["~a", "~b", "~c", "~d", "~g", "~h", "~i", "~j"];
const ends = fakePage({
  responses: new Map(windowed.map((ciphertext) => [`/jobs/${ciphertext}`, { status: 200, html: publicJobHtml(`Description ${ciphertext}`, null) }])),
});
const endsResearch = await gatherPastJobs(ends, longHistory, { concurrency: 4 });
assert.equal(endsResearch.attempted, 8, "a ten-job history is narrowed to the two ends");
assert.deepEqual(endsResearch.failures, [], "the skipped middle is never requested");
assert.deepEqual(endsResearch.items.map((item) => item.ciphertext), ["~j", "~i", "~h", "~g", "~d", "~c", "~b", "~a"]);

// A read that throws is recorded against its own job and leaves the others intact.
const partial = fakePage({
  responses: new Map([
    ["/jobs/~a", { status: 200, html: publicJobHtml("Description ~a", null) }],
    ["/jobs/~b", { status: 200, html: publicJobHtml("Description ~b", null) }],
  ]),
});
const withFailure = await gatherPastJobs(partial, workHistory(["~a", "~b", "~missing"]), { concurrency: 3 });
assert.deepEqual(withFailure.items.map((item) => item.ciphertext), ["~b", "~a"]);
assert.equal(withFailure.attempted, 3);
assert.equal(withFailure.failures.length, 1);
assert.match(withFailure.failures[0], /^~missing: unexpected request \/jobs\/~missing$/);

// A transient in-page failure must still reach the rendered fallback. This is the failure mode seen when
// Upwork destroys an execution context while a research tab is settling a background request.
let retryNavigations = 0;
let retryReads = 0;
const transientRead = {
  context: () => ({}),
  url: () => "https://www.upwork.com/jobs/~retry",
  goto: async () => { retryNavigations++; },
  waitForTimeout: async () => {},
  evaluate: async (_callback, argument) => {
    if (argument !== undefined) {
      retryReads++;
      if (retryReads === 1) throw new Error("Execution context was destroyed");
      return { status: 404, head: "not found", state: null };
    }
    return { description: "Recovered after a transient read failure", attachments: [] };
  },
};
const recovered = await gatherPastJobs(transientRead, workHistory(["~retry"]), { concurrency: 1 });
assert.equal(retryNavigations, 1, "a transient read failure should spend one rendered retry");
assert.deepEqual(recovered.items.map((item) => item.ciphertext), ["~retry"]);
assert.deepEqual(recovered.failures, []);

// A rendered Cloudflare challenge can resolve in place. The reader must give that page time to finish
// instead of rejecting solely because the current URL contains the challenge token.
let challengeActive = false;
let challengeWaits = 0;
const resolvingChallenge = {
  context: () => ({}),
  url: () => challengeActive ? "https://www.upwork.com/jobs/~clear?__cf_chl_tk=abc" : "https://www.upwork.com/jobs/~clear",
  goto: async () => { challengeActive = true; },
  waitForTimeout: async () => {
    challengeWaits++;
    if (challengeWaits === 1) challengeActive = false;
  },
  evaluate: async (_callback, argument) => argument === undefined
    ? { description: "Recovered after the challenge cleared", attachments: [] }
    : { status: 403, head: challengeHtml, state: null },
};
const challengeCleared = await gatherPastJobs(resolvingChallenge, workHistory(["~clear"]), { concurrency: 1 });
assert.equal(challengeWaits, 1, "a rendered challenge should be allowed to clear");
assert.deepEqual(challengeCleared.items.map((item) => item.ciphertext), ["~clear"]);
assert.deepEqual(challengeCleared.failures, []);

// A navigation can clear a bot check, so one is spent and the rest are re-read cheaply rather than each
// paying its own navigation. Nothing readable is skipped: the recovered jobs still come back.
const blockedCiphertexts = ["~a", "~b", "~c", "~d"];
const clearing = fakePage({
  responses: new Map(blockedCiphertexts.map((ciphertext) => [`/jobs/${ciphertext}`, { status: 403, html: challengeHtml }])),
});
let navigations = 0;
clearing.goto = async () => {
  navigations++;
  // Standing in for the browser answering the interstitial: reads start working afterwards.
  for (const ciphertext of blockedCiphertexts) {
    clearing.responses.set(`/jobs/${ciphertext}`, { status: 200, html: publicJobHtml(`Description ${ciphertext}`, null) });
  }
};
const cleared = await gatherPastJobs(clearing, workHistory(blockedCiphertexts), { concurrency: 4 });
assert.equal(navigations, 1, "one navigation should clear the check for the whole batch");
assert.deepEqual(cleared.items.map((item) => item.ciphertext), ["~d", "~c", "~b", "~a"], "every past job is still recovered");
assert.deepEqual(cleared.failures, []);

// A check that no navigation clears still reports per job, and never costs more than one navigation each.
let stuckNavigations = 0;
const stuck = fakePage({
  responses: new Map(["~a", "~b", "~c"].map((ciphertext) => [`/jobs/${ciphertext}`, { status: 403, html: challengeHtml }])),
});
stuck.goto = async () => { stuckNavigations++; };
stuck.url = () => "https://www.upwork.com/jobs/~a?__cf_chl_tk=abc";
const stuckResearch = await gatherPastJobs(stuck, workHistory(["~a", "~b", "~c"]), { concurrency: 3 });
assert.deepEqual(stuckResearch.items, []);
assert.equal(stuckResearch.attempted, 3);
assert.equal(stuckNavigations, 3, "each unread job still gets its one rendered attempt by default");
assert.equal(stuckResearch.failures.length, 3);

// A navigation budget bounds that worst case, and each skipped job still says why it was not read.
stuckNavigations = 0;
const budgeted = await gatherPastJobs(stuck, workHistory(["~a", "~b", "~c"]), { concurrency: 3, navigationLimit: 1 });
assert.equal(stuckNavigations, 1, "the budget caps how many rendered pages a buyer costs");
assert.equal(budgeted.failures.filter((failure) => failure.includes(CHALLENGE_FAILURE)).length, 2);

// A plain miss under a spent budget is reported as unread rather than as a bot challenge.
let missNavigations = 0;
const misses = fakePage({
  responses: new Map(["~a", "~b"].map((ciphertext) => [`/jobs/${ciphertext}`, { status: 404, html: "not found" }])),
});
misses.goto = async () => { missNavigations++; };
misses.url = () => "https://www.upwork.com/nx/page-not-found";
const missResearch = await gatherPastJobs(misses, workHistory(["~a", "~b"]), { concurrency: 2, navigationLimit: 1 });
assert.equal(missNavigations, 1);
assert.deepEqual(missResearch.failures, [`~a: ${NAVIGATION_LIMIT_FAILURE}`]);

console.log("past-job checks passed");
