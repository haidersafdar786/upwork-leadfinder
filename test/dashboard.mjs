import assert from "node:assert/strict";
import { chromium } from "playwright";
import { clientHistoryFromRecord } from "../src/client-history.ts";
import { newBackgroundPage } from "../src/upwork-browser.ts";

assert.deepEqual(clientHistoryFromRecord({
  feed: { client: { totalHires: 12, totalSpent: "3421.50", totalReviews: 8, totalFeedback: 4.75 } },
  details: { buyer: { info: { stats: { totalAssignments: 12, feedbackCount: 8, score: 4.75, totalCharges: { amount: 3421.5 } } }, workHistory: [] } },
}), { totalSpent: 3421.5, totalHires: 12, totalReviews: 8, rating: 4.75 });

assert.deepEqual(clientHistoryFromRecord({
  feed: { client: { totalSpent: null, totalReviews: 0, totalFeedback: 0 } },
  details: { buyer: { workHistory: [{}, {}] } },
}), { totalSpent: null, totalHires: 2, totalReviews: 0, rating: null });

assert.deepEqual(clientHistoryFromRecord({
  details: { buyer: { workHistory: [
    { feedbackToClient: { score: 4 } },
    { feedbackToClient: { score: 5 } },
    {},
  ] } },
}), { totalSpent: null, totalHires: 3, totalReviews: 2, rating: 4.5 });

const context = await chromium.launchPersistentContext("", { headless: true });
const browser = context.browser();

try {
  assert.ok(browser, "persistent Chromium context should expose its browser");
  const page = await newBackgroundPage(browser, context, "https://example.com");
  assert.equal(page.url().startsWith("about:blank"), false, "new background pages should open on their destination");
} finally {
  await context.close();
}

console.log("dashboard checks passed");
