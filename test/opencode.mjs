import assert from "node:assert/strict";
import {
  clearMuteStreakForTest,
  defaultMuteTimeoutLimit,
  disabledMcpServers,
  globalConfigPaths,
  isMuteTimeout,
  muteStreakState,
  recordAttemptForTest,
  resetOpenCodeProviderState,
} from "../src/opencode.ts";

// A commented global config still yields every server, switched off with its definition intact.
const globalConfig = `{
  // a line comment with a "quoted brace {" inside
  "provider": { "ollama": { "npm": "@ai-sdk/openai-compatible" } },
  /* a block comment */
  "mcp": {
    "figma-bridge": { "type": "local", "command": ["npx", "-y", "@gethopp/figma-mcp-bridge"], "enabled": true },
    "remote-thing": { "type": "remote", "url": "https://example.com/mcp" },
  },
}`;
assert.deepEqual(disabledMcpServers(globalConfig), {
  "figma-bridge": { type: "local", command: ["npx", "-y", "@gethopp/figma-mcp-bridge"], enabled: false },
  "remote-thing": { type: "remote", url: "https://example.com/mcp", enabled: false },
});
assert.deepEqual(disabledMcpServers('{ "share": "disabled" }'), {}, "a config without servers needs no overrides");
assert.deepEqual(disabledMcpServers("not json at all"), {}, "an unreadable config must not stop a run");

const previousConfig = process.env.OPENCODE_CONFIG;
process.env.OPENCODE_CONFIG = "/tmp/upwho-explicit-opencode.json";
try {
  const configPaths = globalConfigPaths();
  assert.ok(configPaths.includes("/tmp/upwho-explicit-opencode.json"));
  assert.ok(configPaths.some((path) => path.endsWith("/opencode/config.json")), "the standard config.json source must also be inspected");
  assert.ok(configPaths.some((path) => path.endsWith("/.opencode/opencode.json")), "the legacy global source must also be inspected");
} finally {
  if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG;
  else process.env.OPENCODE_CONFIG = previousConfig;
}

// Only a deadline reached in total silence counts as the provider never having answered.
const mute = Object.assign(new Error("OpenCode timed out after 59900ms"), { partialOutput: "\n^D\n" });
const slow = Object.assign(new Error("OpenCode timed out after 59900ms"), {
  partialOutput: '{"type":"step_start"}\n{"type":"text","part":{"text":"partial"}}\n',
});
assert.equal(isMuteTimeout(mute), true);
assert.equal(isMuteTimeout(slow), false, "a model that streamed before the deadline is slow, not absent");
assert.equal(isMuteTimeout(new Error("opencode exited with 1: boom")), false, "a crash is not a mute timeout");
assert.equal(isMuteTimeout(new Error("OpenCode returned no text")), false);
assert.equal(isMuteTimeout("not an error"), false);

// The limit scales with how many calls can be in flight, since a burst of them fails together.
assert.equal(defaultMuteTimeoutLimit(1), 3);
assert.equal(defaultMuteTimeoutLimit(8), 4);
assert.equal(defaultMuteTimeoutLimit(12), 6);
assert.equal(defaultMuteTimeoutLimit(24), 12);

// The stopping rule reads the current streak, so a provider that answers again is not held against it.
const limit = defaultMuteTimeoutLimit(Number(process.env.OPENCODE_CONCURRENCY || 8));
resetOpenCodeProviderState();
assert.deepEqual(muteStreakState(), { streak: 0, stopping: false });
for (let attempt = 1; attempt < limit; attempt++) {
  recordAttemptForTest(mute);
  assert.equal(muteStreakState().stopping, false, `${attempt} silent attempts is not yet a dead provider`);
}
recordAttemptForTest(mute);
assert.deepEqual(muteStreakState(), { streak: limit, stopping: true }, "reaching the limit stops the run");

// One answer of any kind clears it, so a saturated burst does not doom every later client.
recordAttemptForTest(slow);
assert.deepEqual(muteStreakState(), { streak: 0, stopping: false }, "a response must let the run continue");
for (let attempt = 0; attempt < limit; attempt++) recordAttemptForTest(mute);
assert.equal(muteStreakState().stopping, true);
clearMuteStreakForTest();

resetOpenCodeProviderState();
console.log("opencode checks passed");
