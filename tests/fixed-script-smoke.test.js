import test from "node:test";
import assert from "node:assert/strict";

import {
  checkFixedScriptConfig,
  expectedNpcChatMaxRounds,
  expectedRounds,
  expectedVariantCounts,
  loadFixedScriptArtifacts,
  requiredStartupLines,
  retiredLines,
  verifyProtectionDelay,
  verifyRuntimeDoc,
  verifyStartupAndEndingCopy
} from "../scripts/lib/fixed-script-config-check.js";
import {
  createFixedEndingTradeBundleActions,
  createFixedEndingTradeOpenTradeActions,
  createFixedEndingTradeRelocateActions,
  createFixedSocialGiftEntryActions,
  createFixedSocialGiftResolveActions,
  createFixedSellLoopActions,
  createFixedStreetWanderActions
} from "../src/runtime/windows-executor.js";

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

test("fixed-script smoke: npc chat loop stays on the 7-round vision flow", async () => {
  const { serverSource, runtimeFlowDoc } = await loadFixedScriptArtifacts();

  assert.equal(
    serverSource.includes(`const NPC_CHAT_MAX_ROUNDS = ${expectedNpcChatMaxRounds};`),
    true
  );
  assert.equal(serverSource.includes("当前聊天目标："), true);
  assert.equal(serverSource.includes("边套话边压低好感"), false);
  assert.equal(serverSource.includes("这是空态首轮。先打招呼，再说自己想搞钱，问对方有没有什么建议"), true);
  assert.equal(serverSource.includes("这是空态首轮。先打招呼，再说自己最近手紧、也想搞钱，问对方有没有什么建议"), true);
  assert.equal(runtimeFlowDoc.includes("自动追加最多 `7` 轮 NPC 回复"), true);
  assert.equal(runtimeFlowDoc.includes("聊天空态首轮"), true);
  assert.equal(runtimeFlowDoc.includes("不走聊天 OCR 轮询"), true);
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

test("fixed-script smoke: social gift flow keeps the favor-cap branch split", () => {
  const giftEntryActions = createFixedSocialGiftEntryActions({ includeAcquire: false, idPrefix: "smoke-gift-entry" });
  const giftResolveActions = createFixedSocialGiftResolveActions({ idPrefix: "smoke-gift-resolve" });

  assert.deepEqual(
    giftEntryActions.map((action) => action.title),
    [
      "拉起路人交互菜单",
      "打开赠礼页",
      "查看这人的聊天门槛"
    ]
  );

  assert.deepEqual(
    giftEntryActions.map((action) => action.type),
    [
      "open_npc_action_menu",
      "click_menu_gift",
      "inspect_gift_chat_threshold"
    ]
  );

  assert.deepEqual(giftResolveActions.map((action) => action.type), [
    "resolve_gift_chat_threshold"
  ]);
});

test("fixed-script smoke: stage 0 keeps the street wander opener", () => {
  const actions = createFixedStreetWanderActions();

  assert.deepEqual(actions.map((action) => action.type), [
    "press_key",
    "press_key",
    "press_key",
    "press_key",
    "sleep"
  ]);

  assert.deepEqual(actions.slice(0, 4).map((action) => action.key), [
    "w",
    "a",
    "s",
    "d"
  ]);
});

test("fixed-script smoke: ending trade keeps the local retry and relocate split", () => {
  const openTradeActions = createFixedEndingTradeOpenTradeActions({ idPrefix: "smoke-ending-open" });
  const relocateActions = createFixedEndingTradeRelocateActions({ idPrefix: "smoke-ending-relocate" });
  const bundleActions = createFixedEndingTradeBundleActions({ idPrefix: "smoke-ending-bundle" });

  assert.deepEqual(openTradeActions.map((action) => action.type), [
    "acquire_npc_target",
    "open_npc_action_menu",
    "click_menu_trade"
  ]);

  assert.deepEqual(relocateActions.map((action) => action.type), [
    "travel_to_coordinate",
    "press_key"
  ]);

  assert.deepEqual(bundleActions.map((action) => action.type), [
    "trade_prepare_gift_bundle",
    "trade_select_right_money_slot",
    "trade_scale_quantity",
    "trade_right_item_up_shelf",
    "trade_submit",
    "close_current_panel"
  ]);
});
