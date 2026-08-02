#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { identifyRecord } from "../src/identity-model.ts";

const labels = JSON.parse(await readFile(new URL("./labels.json", import.meta.url), "utf8"));
const cases = Object.entries(labels).filter(([file]) => !file.startsWith("_"));
const deterministic = process.argv.includes("--deterministic");

const squish = (value) => (value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const companyMatches = (actual, expected) => {
  if (expected === null) return !actual;
  if (!actual) return false;
  const a = squish(actual);
  const e = squish(expected);
  return a.length >= 3 && e.length >= 3 && (a.includes(e) || e.includes(a));
};

const results = await Promise.all(cases.map(async ([file, label]) => {
  const record = JSON.parse(await readFile(new URL(`./fixtures/${file}`, import.meta.url), "utf8"));
  const result = await identifyRecord(record, { useModel: !deterministic });
  const actual = result.identity.company || result.identity.product || null;
  return { file, expected: label.company, actual, ok: companyMatches(actual, label.company), error: result.error || null };
}));

let positiveTotal = 0;
let positiveHit = 0;
let nullTotal = 0;
let nullHit = 0;
let truePositive = 0;
let falsePositive = 0;
let falseNegative = 0;
let trueNegative = 0;
let nullFalsePositive = 0;
let abstained = 0;
const misses = [];
let errors = 0;

for (const result of results) {
  if (result.expected === null) {
    nullTotal++;
    if (result.ok) nullHit++;
    if (result.actual) {
      falsePositive++;
      nullFalsePositive++;
    } else trueNegative++;
  } else {
    positiveTotal++;
    if (result.ok) {
      positiveHit++;
      truePositive++;
    } else {
      falseNegative++;
      if (result.actual) falsePositive++;
    }
  }
  if (!result.actual) abstained++;
  if (result.error) errors++;
  if (!result.ok) misses.push(`${result.file}: expected ${JSON.stringify(result.expected)}, got ${JSON.stringify(result.actual)}`);
  console.log(`  ${result.ok ? "✓" : "✗"} ${result.file.padEnd(38)} expected=${JSON.stringify(result.expected)} got=${JSON.stringify(result.actual)}`);
}

const correct = positiveHit + nullHit;
const total = positiveTotal + nullTotal;
const percent = (value, denominator) => denominator ? `${(100 * value / denominator).toFixed(1)}%` : "n/a";
console.log(`\nReplacement identity extraction (${deterministic ? "deterministic" : "model"}): ${correct}/${total} correct`);
console.log(`  positives (found the right brand):   ${positiveHit}/${positiveTotal}`);
console.log(`  null cases (no junk asserted):        ${nullHit}/${nullTotal}`);
console.log(`\nClassification metrics:`);
console.log(`  exact accuracy:      ${percent(correct, total)} (${correct}/${total})`);
console.log(`  precision:           ${percent(truePositive, truePositive + falsePositive)} (${truePositive} TP, ${falsePositive} FP)`);
console.log(`  recall:              ${percent(truePositive, truePositive + falseNegative)} (${truePositive} TP, ${falseNegative} FN)`);
console.log(`  false-positive rate: ${percent(nullFalsePositive, nullTotal)} (${nullFalsePositive}/${nullTotal} null cases)`);
console.log(`  abstention rate:     ${percent(abstained, total)} (${abstained}/${total})`);
console.log(`  model errors:        ${errors}`);
console.log(`  confusion counts:    TP=${truePositive} FP=${falsePositive} FN=${falseNegative} TN=${trueNegative}`);
if (misses.length) console.log(`\nmisses:\n  ${misses.join("\n  ")}`);
