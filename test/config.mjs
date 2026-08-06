import assert from "node:assert/strict";
import { parseConfig } from "../src/config.ts";

const defaults = parseConfig({});
assert.equal(defaults.opencodeModel, "opencode/deepseek-v4-flash-free");
assert.equal(defaults.opencodeConcurrency, 8);
assert.equal(defaults.pastJobNavigations, -1);

const configured = parseConfig({
  OPENCODE_MODEL: "ollama/qwen2.5-coder:7b",
  OPENCODE_CONCURRENCY: "2",
  OPENCODE_BUDGET_MS: "9000",
  UPWHO_CDP_URL: "ws://127.0.0.1:9222/devtools/browser/test",
});
assert.equal(configured.opencodeModel, "ollama/qwen2.5-coder:7b");
assert.equal(configured.opencodeConcurrency, 2);
assert.equal(configured.opencodeBudgetMs, 9000);
assert.equal(configured.cdpUrl, "ws://127.0.0.1:9222/devtools/browser/test");

assert.throws(() => parseConfig({ OPENCODE_CONCURRENCY: "not-a-number" }), /OPENCODE_CONCURRENCY/);
assert.throws(() => parseConfig({ UPWHO_CDP_URL: "file:///tmp/browser" }), /UPWHO_CDP_URL/);

console.log("config checks passed");
