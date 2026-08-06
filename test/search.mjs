import assert from "node:assert/strict";
import { buildSearchUrl, parseSearchFilters } from "../src/upwork-browser.ts";

const url = new URL(buildSearchUrl("shopify app", {
  exactPhrase: "checkout extension",
  excludeWords: "agency",
  jobTypes: ["hourly", "fixed-price"],
  experienceLevels: ["intermediate", "expert"],
  paymentVerified: true,
  page: 3,
  perPage: 20,
  daysPosted: 7,
  sort: "recency+desc",
}));
assert.equal(url.searchParams.get("q"), "shopify app");
assert.equal(url.searchParams.get("exact_phrase"), "checkout extension");
assert.equal(url.searchParams.get("exclude_words"), "agency");
assert.equal(url.searchParams.get("job_type"), "hourly,fixed-price");
assert.equal(url.searchParams.get("experience_level"), "intermediate,expert");
assert.equal(url.searchParams.get("payment_verified"), "1");
assert.equal(url.searchParams.get("page"), "3");
assert.equal(url.searchParams.get("per_page"), "20");
assert.equal(url.searchParams.get("days_posted"), "7");
assert.equal(url.searchParams.get("sort"), "recency+desc");

const pasted = buildSearchUrl("https://www.upwork.com/nx/search/jobs/?q=existing&category=custom", { enterpriseOnly: true });
assert.match(pasted, /q=existing/);
assert.match(pasted, /category=custom/);
assert.match(pasted, /enterprise=1/);

assert.deepEqual(parseSearchFilters('{"jobTypes":["hourly"],"page":2,"perPage":25,"daysPosted":3}'), { jobTypes: ["hourly"], page: 2, perPage: 25, daysPosted: 3 });
assert.throws(() => parseSearchFilters('{"notAFilter":true}'), /Unrecognized key|notAFilter/);
assert.throws(() => parseSearchFilters('{"page":0}'), /Too small|greater than or equal to 1/);
assert.throws(() => parseSearchFilters('{"perPage":51}'), /Too big|less than or equal to 50/);

console.log("search checks passed");
