import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extractIdentitySignals, isAllowedIdentityCandidate } from "../src/identity-extraction.ts";
import { identifyRecord } from "../src/identity-model.ts";

async function fixture(file) {
  return JSON.parse(await readFile(new URL(`./fixtures/${file}`, import.meta.url), "utf8"));
}

const newlane = await fixture("newlane.json");
const signals = extractIdentitySignals(newlane);
assert.ok(signals.candidates.some((candidate) => candidate.value === "Newlane University"));
assert.equal((await identifyRecord(newlane, { useModel: false })).identity.company, "Newlane University");

const adrianMagnus = await fixture("job_2079130192376414852.json");
const adrianSignals = extractIdentitySignals(adrianMagnus);
assert.ok(adrianSignals.candidates.some((candidate) => candidate.value === "Adrian Magnus Humidors"));
assert.equal((await identifyRecord(adrianMagnus, { useModel: false })).identity.company, "Adrian Magnus Humidors");

const anonymous = await fixture("null_architect_marketplace.json");
assert.equal((await identifyRecord(anonymous, { useModel: false })).identity.company, null);

assert.equal(isAllowedIdentityCandidate("React"), false);
assert.equal(isAllowedIdentityCandidate("Financial Reporting Workbook"), false);
assert.equal(isAllowedIdentityCandidate("Adrian Magnus Humidors"), true);

console.log("identity checks passed");
