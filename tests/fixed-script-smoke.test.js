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
import { createFixedSellLoopActions } from "../src/runtime/windows-executor.js";

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

test("fixed-script smoke: sell loop keeps the new vendor approach chain", () => {
  const actions = createFixedSellLoopActions();
  const roundTwoActions = createFixedSellLoopActions({ roundNumber: 2 });
  const vendorSetupTitles = actions.slice(0, 5).map((action) => action.title);
  const vendorSetupTypes = actions.slice(0, 5).map((action) => action.type);
  const hawkingTitles = actions.slice(8, 11).map((action) => action.title);
  const hawkingTypes = actions.slice(8, 11).map((action) => action.type);

  assert.deepEqual(vendorSetupTitles, [
    "去货商坐标",
    "下马准备进货",
    "转到阿依娜正前方并贴近到出现对话[F]",
    "按 F 打开阿依娜进货页",
    "买满墨锭并关闭面板"
  ]);

  assert.deepEqual(vendorSetupTypes, [
    "travel_to_coordinate",
    "press_key",
    "align_named_vendor_interact_prompt",
    "open_named_vendor_purchase",
    "buy_current_vendor_item"
  ]);

  assert.deepEqual(hawkingTitles, [
    "打开叫卖界面",
    "选中第一格墨锭并最大化后上架",
    "点击出摊并等卖完回到正常街道"
  ]);

  assert.deepEqual(hawkingTypes, [
    "press_shortcut",
    "stock_first_hawking_item",
    "submit_hawking"
  ]);

  assert.equal(roundTwoActions[4].title, "买满散酒并关闭面板");
  assert.equal(roundTwoActions[4].itemName, "散酒");
  assert.equal(roundTwoActions[9].title, "选中第一格散酒并最大化后上架");
});
