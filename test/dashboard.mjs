import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { currentCancellationSignal } from "../src/cancellation.ts";
import { clientHistoryFromRecord } from "../src/client-history.ts";
import { createDashboardServer } from "../src/dashboard.ts";
import { mergeRerunResult } from "../src/run.ts";
import { newBackgroundPage } from "../src/upwork-browser.ts";

const dashboardHtml = readFileSync(new URL("../dashboard/index.html", import.meta.url), "utf8");
assert.ok(dashboardHtml.includes('id="icon-youtube"'), "the dashboard should define a YouTube icon");
assert.ok(dashboardHtml.includes('return { name: "youtube", label: "YouTube" }'), "YouTube links should use the YouTube icon and label");

const previousRun = {
  runId: "source-run",
  feed: { kind: "best-matches", url: "https://example.com/feed" },
  startedAt: "2026-08-03T10:00:00.000Z",
  completedAt: "2026-08-03T10:10:00.000Z",
  clients: [{ buyerId: "buyer-a", version: 1 }, { buyerId: "buyer-b", version: 1 }],
};
const updatedClient = { buyerId: "buyer-b", version: 2 };
const mergedRun = mergeRerunResult(previousRun, updatedClient, "2026-08-03T10:20:00.000Z");
assert.equal(mergedRun.runId, previousRun.runId, "a row rerun should keep the source run ID");
assert.equal(mergedRun.startedAt, previousRun.startedAt, "a row rerun should keep the source run start time");
assert.equal(mergedRun.completedAt, "2026-08-03T10:20:00.000Z");
assert.deepEqual(mergedRun.clients, [previousRun.clients[0], updatedClient], "a row rerun should replace only its client");

let cancellationCount = 0;
const fakeRun = async (_feed, _query, _options, progress) => {
  const signal = currentCancellationSignal();
  assert.ok(signal, "dashboard runs should own a cancellation signal");
  return new Promise((_, reject) => {
    const cancel = () => {
      cancellationCount++;
      void Promise.resolve(progress({ kind: "run-cancelled" })).finally(() => reject(signal.reason));
    };
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
  });
};
const context = await chromium.launchPersistentContext("", { headless: true });
const browser = context.browser();
const dashboardServer = createDashboardServer({ runOnce: fakeRun });
await new Promise((resolve, reject) => {
  dashboardServer.once("error", reject);
  dashboardServer.listen(0, "127.0.0.1", resolve);
});
try {
  const address = dashboardServer.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  assert.ok(browser, "persistent Chromium context should expose its browser");
  const dashboardPage = await context.newPage();
  try {
    await dashboardPage.goto(baseUrl);
    const cancelButton = dashboardPage.locator("#cancel");
    assert.equal(await cancelButton.isVisible(), false, "Cancel should stay out of the idle command bar");
    await dashboardPage.getByRole("button", { name: "Run", exact: true }).click();
    await cancelButton.waitFor({ state: "visible" });
    await dashboardPage.waitForFunction(() => !document.querySelector("#cancel")?.disabled);
    assert.equal(await cancelButton.isEnabled(), true, "Cancel should enable once the run has an ID");
    await cancelButton.click();
    await dashboardPage.waitForFunction(() => document.querySelector("#status")?.textContent === "Run cancelled");
    assert.equal(cancellationCount, 1, "Cancel should abort the active run");
    assert.equal(await cancelButton.isVisible(), false, "Cancel should leave the command bar after cancellation");
    assert.equal(await dashboardPage.getByRole("button", { name: "Run", exact: true }).isEnabled(), true, "Run should be available again after cancellation");
  } finally {
    await dashboardPage.close();
  }

  const backgroundPage = await newBackgroundPage(browser, context, "https://example.com");
  assert.equal(backgroundPage.url().startsWith("about:blank"), false, "new background pages should open on their destination");
} finally {
  await new Promise((resolve, reject) => dashboardServer.close((error) => error ? reject(error) : resolve()));
  await context.close();
}

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

console.log("dashboard checks passed");
