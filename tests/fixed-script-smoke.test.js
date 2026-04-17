import test from "node:test";
import assert from "node:assert/strict";

import {
  checkFixedScriptConfig,
  expectedRounds,
  expectedVariantCounts,
  loadFixedScriptArtifacts,
  requiredStartupLines,
  retiredLines,
  verifyProtectionDelay,
  verifyRuntimeDoc,
  verifyStartupAndEndingCopy
} from "../scripts/lib/fixed-script-config-check.js";

test("fixed-script smoke: stage voice pool counts and rounds stay aligned", async () => {
  const summary = await checkFixedScriptConfig();

  assert.deepEqual(summary.expectedVariantCounts, expectedVariantCounts);
  assert.deepEqual(summary.expectedRounds, expectedRounds);
  assert.equal(summary.stageSummaries.length, Object.keys(expectedVariantCounts).length);

  summary.stageSummaries.forEach((stageSummary) => {
    assert.equal(
      stageSummary.variantCount,
      expectedVariantCounts[stageSummary.stageKey],
      `unexpected variant count for ${stageSummary.stageKey}`
    );
  });
});

test("fixed-script smoke: runtime flow doc stays synced with startup lines and protection copy", async () => {
  const { serverSource, runtimeFlowDoc } = await loadFixedScriptArtifacts();

  assert.doesNotThrow(() => verifyProtectionDelay(serverSource));
  assert.doesNotThrow(() => verifyRuntimeDoc(runtimeFlowDoc));
  assert.doesNotThrow(() => verifyStartupAndEndingCopy(serverSource, runtimeFlowDoc));
});

test("fixed-script smoke: retired startup and ending lines stay absent", async () => {
  const { serverSource, runtimeFlowDoc } = await loadFixedScriptArtifacts();

  retiredLines.forEach((line) => {
    assert.equal(serverSource.includes(line), false, `retired line leaked back into server source: ${line}`);
    assert.equal(runtimeFlowDoc.includes(line), false, `retired line leaked back into runtime doc: ${line}`);
  });

  Object.values(requiredStartupLines).forEach((line) => {
    assert.equal(serverSource.includes(line) || runtimeFlowDoc.includes(line), true);
  });
});
