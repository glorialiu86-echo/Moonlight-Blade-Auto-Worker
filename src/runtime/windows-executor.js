import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getActionDefinition } from "./action-registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const workerScript = path.resolve(repoRoot, "scripts/windows_input_worker.py");

function createWorkerAction(id, title, type, payload = {}) {
  return {
    id,
    title,
    type,
    ...payload
  };
}

function resolvePythonPath() {
  const candidate = process.env.CONTROL_PYTHON?.trim()
    || process.env.LOCAL_ASR_PYTHON?.trim();

  if (candidate) {
    return candidate;
  }

  return path.resolve(repoRoot, ".venv/Scripts/python.exe");
}

function createNpcFlowActions(baseAction, steps) {
  return steps.map((step, index) => ({
    id: `${baseAction.id}-step-${index + 1}`,
    title: step.title,
    type: step.type,
    sourceType: baseAction.sourceType,
    ...step.payload
  }));
}

function createAcquireNpcTargetAction(id, title, options = {}) {
  return createWorkerAction(id, title, "acquire_npc_target", {
    timeoutMs: options.timeoutMs || 5000,
    movePulseMs: options.movePulseMs || 160,
    scanIntervalMs: options.scanIntervalMs || 180
  });
}

function createOpenNpcActionMenuAction(id, title, options = {}) {
  return createWorkerAction(id, title, "open_npc_action_menu", {
    viewAttemptLimit: options.viewAttemptLimit || 3
  });
}

function createCloseCurrentPanelAction(id, title = "关闭当前面板") {
  return createWorkerAction(id, title, "close_current_panel");
}

function createPressKeyAction(id, title, key, payload = {}) {
  return createWorkerAction(id, title, "press_key", {
    key,
    ...payload
  });
}

function createPressShortcutAction(id, title, shortcut, payload = {}) {
  return createWorkerAction(id, title, "press_shortcut", {
    shortcut,
    ...payload
  });
}

function createNamedPointClickAction(id, title, pointName, payload = {}) {
  return createWorkerAction(id, title, "click_named_point", {
    pointName,
    ...payload
  });
}

function createSleepAction(id, title, durationMs) {
  return createWorkerAction(id, title, "sleep", {
    durationMs
  });
}

export function createFixedStreetWanderActions() {
  return [
    createPressKeyAction("fixed-street-wander-1", "原地先往前晃一小段", "w", {
      durationMs: 1600,
      postDelayMs: 260
    }),
    createPressKeyAction("fixed-street-wander-2", "原地往左侧乱拐一小段", "a", {
      durationMs: 1200,
      postDelayMs: 260
    }),
    createPressKeyAction("fixed-street-wander-3", "原地往后退着晃一小段", "s", {
      durationMs: 1800,
      postDelayMs: 260
    }),
    createPressKeyAction("fixed-street-wander-4", "原地往右侧再晃一小段", "d", {
      durationMs: 1400,
      postDelayMs: 320
    }),
    createSleepAction("fixed-street-wander-5", "停下来缓一口气", 700)
  ];
}

export function createTravelToCoordinateAction({
  id,
  title,
  xCoordinate,
  yCoordinate,
  confirmPointName,
  waitAfterGoMs = 800,
  coordinateTolerance = 5,
  rerouteLimit = 2,
  maxTravelMs = 24000
}) {
  return createWorkerAction(id, title, "travel_to_coordinate", {
    xCoordinate,
    yCoordinate,
    waitAfterGoMs,
    coordinateTolerance,
    rerouteLimit,
    maxTravelMs,
    ...(confirmPointName ? { confirmPointName } : {})
  });
}

function createNpcChatEntryActions(baseAction, options = {}) {
  return createNpcFlowActions(baseAction, [
    {
      title: "锁定路人目标",
      type: "acquire_npc_target",
      payload: {
        timeoutMs: options.timeoutMs || 5000,
        movePulseMs: options.movePulseMs || 160,
        scanIntervalMs: options.scanIntervalMs || 180
      }
    },
    {
      title: "拉起路人交互菜单",
      type: "open_npc_action_menu",
      payload: {}
    },
    {
      title: "点开交谈入口",
      type: "click_menu_talk",
      payload: {}
    },
    {
      title: "点开闲聊入口",
      type: "click_menu_small_talk",
      payload: {}
    },
    {
      title: "确认进入聊天页",
      type: "confirm_small_talk_entry",
      payload: {}
    }
  ]);
}

function createNpcGiftActions(baseAction, options = {}) {
  const giftRounds = Math.max(1, options.giftRounds || 2);
  const giftSteps = Array.from({ length: giftRounds }).flatMap((_, roundIndex) => ([
    {
      title: `选中礼物槽位 ${roundIndex + 1}`,
      type: "select_gift_first_slot",
      payload: {}
    },
    {
      title: `送出一轮礼物 ${roundIndex + 1}`,
      type: "submit_gift_once",
      payload: {}
    }
  ]));

  return createNpcFlowActions(baseAction, [
    {
      title: "锁定路人目标",
      type: "acquire_npc_target",
      payload: {
        timeoutMs: options.timeoutMs || 4500,
        movePulseMs: options.movePulseMs || 160,
        scanIntervalMs: options.scanIntervalMs || 180
      }
    },
    {
      title: "拉起路人交互菜单",
      type: "open_npc_action_menu",
      payload: {}
    },
    {
      title: "打开赠礼页",
      type: "click_menu_gift",
      payload: {}
    },
    ...giftSteps,
    {
      title: "关闭当前面板",
      type: "close_current_panel",
      payload: {}
    }
  ]);
}

function createNpcTradeActions(baseAction, options = {}) {
  return createNpcFlowActions(baseAction, [
    {
      title: "锁定路人目标",
      type: "acquire_npc_target",
      payload: {
        timeoutMs: options.timeoutMs || 5000,
        movePulseMs: options.movePulseMs || 180,
        scanIntervalMs: options.scanIntervalMs || 180
      }
    },
    {
      title: "拉起路人交互菜单",
      type: "open_npc_action_menu",
      payload: {}
    },
    {
      title: "打开交易页",
      type: "click_menu_trade",
      payload: {}
    },
    {
      title: "切到左侧货栏",
      type: "trade_select_left_item_tab",
      payload: {}
    },
    {
      title: "选中左侧货物",
      type: "trade_select_left_item",
      payload: {}
    },
    {
      title: "左侧货物上架",
      type: "trade_left_item_up_shelf",
      payload: {}
    },
    {
      title: "选中右侧支付物",
      type: "trade_select_right_money_slot",
      payload: {}
    },
    {
      title: "调整支付数量",
      type: "trade_scale_quantity",
      payload: {}
    },
    {
      title: "右侧支付物上架",
      type: "trade_right_item_up_shelf",
      payload: {}
    },
    {
      title: "提交当前交易",
      type: "trade_submit",
      payload: {}
    },
    {
      title: "关闭当前面板",
      type: "close_current_panel",
      payload: {}
    }
  ]);
}

function createNpcStealActions(baseAction, options = {}) {
  return createNpcFlowActions(baseAction, [
    {
      title: "触发妙取",
      type: "press_shortcut",
      payload: {
        shortcut: "steal",
        postDelayMs: options.triggerDelayMs || 700
      }
    },
    {
      title: "点击右侧第一条金色妙取按钮",
      type: "click_steal_button",
      payload: {
        buttonIndex: options.buttonIndex || 1,
        postDelayMs: options.clickDelayMs || 500
      }
    }
  ]);
}

export function createRetargetSocialTargetActions(options = {}) {
  return [
    createWorkerAction(options.id || "social-retarget-1", options.title || "换一个可查看的路人目标", "retarget_social_target", {
      attemptsPerCycle: options.attemptsPerCycle || 5,
      maxCycles: options.maxCycles || 2,
      dragStartRatio: options.dragStartRatio || [0.54, 0.48],
      dragEndRatio: options.dragEndRatio || [0.64, 0.48],
      dragDurationMs: options.dragDurationMs || 180,
      settleMs: options.settleMs || 220
    })
  ];
}

function getFixedSocialStageConfig(stageKey = "social_warm") {
  switch (stageKey) {
    case "social_dark":
      return {
        approachIdPrefix: "fixed-social-dark-approach",
        travelTitle: "去第二个卦摊",
        xCoordinate: 698,
        yCoordinate: 753,
        dismountTitle: "到第二个卦摊前先下马"
      };
    case "social_warm":
    default:
      return {
        approachIdPrefix: "fixed-social-warm-approach",
        travelTitle: "去第一个卦摊",
        xCoordinate: 548,
        yCoordinate: 630,
        dismountTitle: "到第一个卦摊前先下马"
      };
  }
}

export function createFixedSocialApproachActions(stageKey = "social_warm") {
  const config = getFixedSocialStageConfig(stageKey);
  return [
    createTravelToCoordinateAction({
      id: `${config.approachIdPrefix}-1`,
      title: config.travelTitle,
      xCoordinate: config.xCoordinate,
      yCoordinate: config.yCoordinate
    }),
    createPressKeyAction(`${config.approachIdPrefix}-2`, config.dismountTitle, "1", {
      postDelayMs: 1000
    })
  ];
}

export function createFixedSocialTradeActions(options = {}) {
  const prefix = options.idPrefix || "social-trade";
  const steps = [];
  if (options.includeAcquire !== false) {
    steps.push(createAcquireNpcTargetAction(`${prefix}-1`, "锁定路人目标", {
      timeoutMs: 5000,
      movePulseMs: 180,
      scanIntervalMs: 180
    }));
  }
  steps.push(createOpenNpcActionMenuAction(`${prefix}-2`, "拉起路人交互菜单"));
  steps.push(createWorkerAction(`${prefix}-3`, "打开交易页", "click_menu_trade"));
  steps.push(createWorkerAction(`${prefix}-4`, "切到左侧货栏", "trade_select_left_item_tab"));
  steps.push(createWorkerAction(`${prefix}-5`, "选中左侧货物", "trade_select_left_item"));
  steps.push(createWorkerAction(`${prefix}-6`, "左侧货物上架", "trade_left_item_up_shelf"));
  steps.push(createWorkerAction(`${prefix}-7`, "选中右侧支付物", "trade_select_right_money_slot"));
  steps.push(createWorkerAction(`${prefix}-8`, "调整支付数量", "trade_scale_quantity"));
  steps.push(createWorkerAction(`${prefix}-9`, "右侧支付物上架", "trade_right_item_up_shelf"));
  steps.push(createWorkerAction(`${prefix}-10`, "提交当前交易", "trade_submit"));
  steps.push(createCloseCurrentPanelAction(`${prefix}-11`));
  return steps;
}

export function createFixedSocialGiftActions(options = {}) {
  const prefix = options.idPrefix || "social-gift";
  const steps = [];
  if (options.includeAcquire) {
    steps.push(createAcquireNpcTargetAction(`${prefix}-1`, "锁定路人目标", {
      timeoutMs: 4500,
      movePulseMs: 160,
      scanIntervalMs: 180
    }));
  }
  steps.push(createOpenNpcActionMenuAction(`${prefix}-${steps.length + 1}`, "拉起路人交互菜单"));
  steps.push(createWorkerAction(`${prefix}-${steps.length + 1}`, "打开赠礼页", "click_menu_gift"));
  steps.push(createWorkerAction(`${prefix}-${steps.length + 1}`, "查看这人的聊天门槛", "inspect_gift_chat_threshold"));
  steps.push(createWorkerAction(`${prefix}-${steps.length + 1}`, "按当前聊天门槛处理赠礼", "resolve_gift_chat_threshold"));
  return steps;
}

export function createFixedSocialGiftEntryActions(options = {}) {
  const prefix = options.idPrefix || "social-gift-entry";
  const steps = [];
  if (options.includeAcquire) {
    steps.push(createAcquireNpcTargetAction(`${prefix}-1`, "锁定路人目标", {
      timeoutMs: 4500,
      movePulseMs: 160,
      scanIntervalMs: 180
    }));
  }
  steps.push(createOpenNpcActionMenuAction(`${prefix}-${steps.length + 1}`, "拉起路人交互菜单"));
  steps.push(createWorkerAction(`${prefix}-${steps.length + 1}`, "打开赠礼页", "click_menu_gift"));
  steps.push(createWorkerAction(`${prefix}-${steps.length + 1}`, "查看这人的聊天门槛", "inspect_gift_chat_threshold"));
  return steps;
}

export function createFixedSocialGiftResolveActions(options = {}) {
  const prefix = options.idPrefix || "social-gift-resolve";
  return [
    createWorkerAction(`${prefix}-1`, "按当前聊天门槛处理赠礼", "resolve_gift_chat_threshold")
  ];
}

export function createFixedSocialTalkActions(options = {}) {
  const prefix = options.idPrefix || "social-talk";
  const steps = [];
  if (options.includeAcquire) {
    steps.push(createAcquireNpcTargetAction(`${prefix}-1`, "锁定路人目标", {
      timeoutMs: 7000,
      movePulseMs: 160,
      scanIntervalMs: 180
    }));
  }
  steps.push(createOpenNpcActionMenuAction(`${prefix}-${steps.length + 1}`, "拉起路人交互菜单"));
  steps.push(createWorkerAction(`${prefix}-${steps.length + 1}`, "点开交谈入口", "click_menu_talk"));
  steps.push(createWorkerAction(`${prefix}-${steps.length + 1}`, "点开闲聊入口", "click_menu_small_talk"));
  steps.push(createWorkerAction(`${prefix}-${steps.length + 1}`, "确认进入聊天页", "confirm_small_talk_entry"));
  return steps;
}

export function createFixedSocialStageActions(stageKey = "social_warm") {
  return [
    ...createFixedSocialApproachActions(stageKey),
    ...createFixedSocialTradeActions({ includeAcquire: true, idPrefix: "fixed-social-trade" }),
    ...createFixedSocialGiftActions({ includeAcquire: false, idPrefix: "fixed-social-gift" }),
    ...createFixedSocialTalkActions({ includeAcquire: false, idPrefix: "fixed-social-talk" })
  ];
}

export function createFixedSocialRecoveryActions() {
  return [
    ...createRetargetSocialTargetActions({ id: "fixed-social-recovery-retarget" }),
    ...createFixedSocialGiftActions({ includeAcquire: false, idPrefix: "fixed-social-recovery-gift" }),
    ...createFixedSocialTalkActions({ includeAcquire: false, idPrefix: "fixed-social-recovery-talk" })
  ];
}

function getFixedSellLoopRoundConfig(roundNumber = 1) {
  const normalizedRound = Math.max(1, Number(roundNumber) || 1);
  if (normalizedRound % 2 === 0) {
    return {
      itemName: "散酒",
      buyTitle: "买满散酒并关闭面板",
      stockTitle: "选中第一格散酒并最大化后上架"
    };
  }

  return {
    itemName: "墨锭",
    buyTitle: "买满墨锭并关闭面板",
    stockTitle: "选中第一格墨锭并最大化后上架"
  };
}

export function createFixedSellLoopActions(options = {}) {
  const sellConfig = getFixedSellLoopRoundConfig(options.roundNumber);
  return [
    createTravelToCoordinateAction({
      id: "fixed-sale-1",
      title: "去货商坐标",
      xCoordinate: 667,
      yCoordinate: 554
    }),
    createPressKeyAction("fixed-sale-2", "下马准备进货", "1", { postDelayMs: 1000 }),
    createWorkerAction("fixed-sale-3", "转到阿依娜正前方并贴近到出现对话[F]", "align_named_vendor_interact_prompt", {
      targetName: "阿依娜",
      retryLimit: 5,
      forwardPulseMs: 180,
      dragDurationMs: 220,
      settleMs: 280
    }),
    createWorkerAction("fixed-sale-4", "按 F 打开阿依娜进货页", "open_named_vendor_purchase", {
      targetName: "阿依娜",
      interactAttempts: 3,
      postDelayMs: 1000
    }),
    createWorkerAction("fixed-sale-5", sellConfig.buyTitle, "buy_current_vendor_item", {
      itemName: sellConfig.itemName,
      quantity: 1,
      postDelayMs: 1000
    }),
    createTravelToCoordinateAction({
      id: "fixed-sale-6",
      title: "去大街坐标",
      xCoordinate: 670,
      yCoordinate: 538
    }),
    createPressKeyAction("fixed-sale-7", "下马准备叫卖", "1", { postDelayMs: 1000 }),
    createPressKeyAction("fixed-sale-8", "矫正视角准备叫卖", "v", { postDelayMs: 1000 }),
    createPressShortcutAction("fixed-sale-9", "打开叫卖界面", "hawking", { postDelayMs: 2000 }),
    createWorkerAction("fixed-sale-10", sellConfig.stockTitle, "stock_first_hawking_item", {
      postDelayMs: 1000
    }),
    createWorkerAction("fixed-sale-11", "点击出摊并等卖完回到正常街道", "submit_hawking", {
      submitReadyDelayMs: 1000,
      activeTimeoutMs: 8000,
      finishTimeoutMs: 120000
    })
  ];
}

function createFixedDarkCloseLootActions(options = {}) {
  return [
    createWorkerAction("fixed-dark-close-loot-collect", "固定点搜刮物品 6 次", "loot_collect_fixed_items", {
      clickCount: Math.max(1, Number(options.clickCount || 6)),
      itemSettleMs: Math.max(120, Number(options.itemSettleMs || 400)),
      putInSettleMs: Math.max(80, Number(options.putInSettleMs || 200))
    })
  ];
}

export function createFixedDarkCloseStageActions() {
  return [
    createTravelToCoordinateAction({
      id: "fixed-dark-close-1",
      title: "去潜行点",
      xCoordinate: 405,
      yCoordinate: 812,
      confirmPointName: "teleport_confirm"
    }),
    createPressKeyAction("fixed-dark-close-2", "下马准备潜行", "1", { postDelayMs: 800 }),
    createPressKeyAction("fixed-dark-close-2b", "校正视角准备潜行", "v", { postDelayMs: 800 }),
    createWorkerAction("fixed-dark-close-3", "进入潜行并在失败时短退一步再重试", "enter_stealth_with_retry", {
      retryLimit: 5,
      settleMs: 260,
      retryBackstepMs: 180,
      retryMoveSettleMs: 140
    }),
    createWorkerAction("fixed-dark-close-4", "潜行后直接按 3 闷棍附近目标", "stealth_front_arc_strike", {
      knockoutTimeoutMs: 2600,
      retryPressMs: 180,
      postDelayMs: 600
    }),
    createWorkerAction("fixed-dark-close-5", "扛走被闷倒的目标", "stealth_carry_target", {
      carrySettleMs: 180
    }),
    createWorkerAction("fixed-dark-close-6", "长按 S 把人拖离人堆", "stealth_backstep_target", {
      backstepMs: 3000,
      moveSettleMs: 80
    }),
    createWorkerAction("fixed-dark-close-7", "放下扛走的目标", "stealth_drop_target", {
      dropSettleMs: 200
    }),
    createWorkerAction("fixed-dark-close-8", "拉起搜刮面板", "stealth_open_loot", {
      lootOpenTimeoutMs: 1600,
      lootSettleMs: 80
    }),
    ...createFixedDarkCloseLootActions(),
    createWorkerAction("fixed-dark-close-9", "提交这一轮搜刮", "loot_submit_once", {
      lootSettleMs: 160
    })
  ];
}

export function createStealthEscapeRecoveryActions() {
  return [
    createWorkerAction("fixed-dark-close-recovery-1", "长按 S 后撤脱离", "stealth_escape_backward", {
      backstepMs: 3000,
      moveSettleMs: 80
    }),
    ...createFixedDarkCloseStageActions().slice(2)
  ];
}

export function createFixedDarkMiaoquStageActions() {
  return [
    createTravelToCoordinateAction({
      id: "fixed-dark-miaoqu-1",
      title: "去妙取潜行点",
      xCoordinate: 405,
      yCoordinate: 812,
      confirmPointName: "teleport_confirm"
    }),
    createPressKeyAction("fixed-dark-miaoqu-2", "下马准备妙取", "1", { postDelayMs: 800 }),
    createPressKeyAction("fixed-dark-miaoqu-2b", "校正视角准备妙取", "v", { postDelayMs: 800 }),
    createWorkerAction("fixed-dark-miaoqu-3", "进入潜行并在失败时短退一步再重试", "enter_stealth_with_retry", {
      retryLimit: 5,
      settleMs: 260,
      retryBackstepMs: 180,
      retryMoveSettleMs: 140
    }),
    createWorkerAction("fixed-dark-miaoqu-4", "按 4 拉起妙取面板并自动吃到附近目标", "stealth_trigger_miaoqu", {
      triggerKey: "4",
      retryLimit: 3,
      triggerTimeoutMs: 5000,
      triggerSettleMs: 60,
      retryForwardMs: 140,
      retryMoveSettleMs: 80
    }),
    createWorkerAction("fixed-dark-miaoqu-5", "盲点固定妙取按钮并在 1.2 秒后撤离", "click_fixed_steal_button_and_escape", {
      buttonIndex: 1,
      escapeDelayMs: 1200,
      shortBackstepMs: 120,
      betweenEscapeMs: 80,
      longBackstepMs: 3000,
      moveSettleMs: 80
    }),
    createWorkerAction("fixed-dark-miaoqu-6", "退出潜行回到普通场景", "exit_stealth", {
      settleMs: 450
    })
  ];
}

export function createFixedDarkMiaoquRecoveryActions() {
  return [
    createWorkerAction("fixed-dark-miaoqu-recovery-1", "长按 S 先撤离妙取现场", "stealth_escape_backward", {
      backstepMs: 3000,
      moveSettleMs: 80
    }),
    createWorkerAction("fixed-dark-miaoqu-recovery-2", "退出潜行回到普通场景", "exit_stealth", {
      settleMs: 450
    }),
    ...createFixedDarkMiaoquStageActions()
  ];
}

export function createFixedEndingTradeActions() {
  return [
    createAcquireNpcTargetAction("fixed-ending-trade-1", "随便锁一个路人目标", {
      timeoutMs: 5000,
      movePulseMs: 180,
      scanIntervalMs: 180
    }),
    createOpenNpcActionMenuAction("fixed-ending-trade-2", "拉起路人交互菜单"),
    createWorkerAction("fixed-ending-trade-3", "打开交易页准备收尾卖货", "click_menu_trade"),
    createWorkerAction("fixed-ending-trade-4", "连续上架十个道具", "trade_prepare_gift_bundle", {
      repeatCount: 10
    }),
    createWorkerAction("fixed-ending-trade-5", "选中右侧支付物", "trade_select_right_money_slot"),
    createWorkerAction("fixed-ending-trade-6", "调整支付数量", "trade_scale_quantity"),
    createWorkerAction("fixed-ending-trade-7", "右侧支付物上架", "trade_right_item_up_shelf"),
    createWorkerAction("fixed-ending-trade-8", "提交最后一笔交易", "trade_submit"),
    createCloseCurrentPanelAction("fixed-ending-trade-9", "关闭面板回到街道")
  ];
}

export function createFixedEndingTradeOpenTradeActions(options = {}) {
  const prefix = options.idPrefix || "fixed-ending-trade-open";
  const acquireTitle = options.acquireTitle || "随便锁一个路人目标";
  const menuTitle = options.menuTitle || "拉起路人交互菜单";
  const tradeTitle = options.tradeTitle || "打开交易页准备收尾卖货";
  return [
    createAcquireNpcTargetAction(`${prefix}-1`, acquireTitle, {
      timeoutMs: 5000,
      movePulseMs: 180,
      scanIntervalMs: 180
    }),
    createOpenNpcActionMenuAction(`${prefix}-2`, menuTitle),
    createWorkerAction(`${prefix}-3`, tradeTitle, "click_menu_trade")
  ];
}

export function createFixedEndingTradeRelocateActions(options = {}) {
  const prefix = options.idPrefix || "fixed-ending-trade-relocate";
  return [
    createTravelToCoordinateAction({
      id: `${prefix}-1`,
      title: "重新去第一个卦摊附近找肯交易的路人",
      xCoordinate: 548,
      yCoordinate: 630
    }),
    createPressKeyAction(`${prefix}-2`, "到卦摊附近先下马", "1", {
      postDelayMs: 1000
    })
  ];
}

export function createFixedEndingTradeBundleActions(options = {}) {
  const prefix = options.idPrefix || "fixed-ending-trade-bundle";
  return [
    createWorkerAction(`${prefix}-1`, "连续上架十个道具", "trade_prepare_gift_bundle", {
      repeatCount: 10
    }),
    createWorkerAction(`${prefix}-2`, "选中右侧支付物", "trade_select_right_money_slot"),
    createWorkerAction(`${prefix}-3`, "调整支付数量", "trade_scale_quantity"),
    createWorkerAction(`${prefix}-4`, "右侧支付物上架", "trade_right_item_up_shelf"),
    createWorkerAction(`${prefix}-5`, "提交最后一笔交易", "trade_submit"),
    createCloseCurrentPanelAction(`${prefix}-6`, "关闭面板回到街道")
  ];
}

function createWorkerActions(plan) {
  return plan.actions.flatMap((action, index) => {
    const actionDefinition = getActionDefinition(action.type);
    const baseAction = {
      id: `input-${index + 1}`,
      title: action.title || actionDefinition?.label || action.type,
      sourceType: action.type
    };

    switch (action.type) {
      case "sale":
        return createPrimitiveActions("sale").map((primitiveAction, primitiveIndex) => ({
          ...primitiveAction,
          id: `${baseAction.id}-primitive-${primitiveIndex + 1}`,
          sourceType: action.type
        }));
      case "stealth":
        return createPrimitiveActions("stealth").map((primitiveAction, primitiveIndex) => ({
          ...primitiveAction,
          id: `${baseAction.id}-primitive-${primitiveIndex + 1}`,
          sourceType: action.type
        }));
      case "talk":
        return createNpcChatEntryActions(baseAction, {
          timeoutMs: 7000,
          movePulseMs: 160,
          scanIntervalMs: 180
        });
      case "gift":
        return createNpcGiftActions(baseAction, {
          giftRounds: 2,
          timeoutMs: 4500,
          movePulseMs: 160,
          scanIntervalMs: 180
        });
      case "trade":
        return createNpcTradeActions(baseAction, {
          timeoutMs: 5000,
          movePulseMs: 180,
          scanIntervalMs: 180
        });
      case "threaten":
      case "strike":
        return createNpcChatEntryActions(baseAction, {
          timeoutMs: 4500,
          movePulseMs: 160,
          scanIntervalMs: 180
        });
      case "steal":
        return createNpcStealActions(baseAction, {
          triggerDelayMs: 700,
          clickDelayMs: 500,
          buttonIndex: 1
        });
      case "escape":
        return {
          ...baseAction,
          type: "press_key",
          key: "esc",
          postDelayMs: 500
        };
      case "wait":
        return {
          ...baseAction,
          type: "sleep",
          durationMs: 1200
        };
      case "inspect":
      default:
        return {
          ...baseAction,
          type: "focus_window",
          postDelayMs: 200
        };
    }
  });
}

function parseWorkerResponse(rawStdout, rawStderr, exitCode) {
  const stderr = String(rawStderr || "").trim();
  const stdout = String(rawStdout || "").trim();

  if (exitCode !== 0) {
    throw new Error(stderr || stdout || `Windows input worker exited with code ${exitCode}`);
  }

  if (!stdout) {
    throw new Error(stderr || "Windows input worker returned empty output");
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Windows input worker returned non-JSON output: ${stdout}`);
  }

  if (!parsed.ok) {
    const error = new Error(parsed.message || "Windows input execution failed");
    error.code = parsed.errorCode || "INPUT_EXECUTION_FAILED";
    error.workerPayload = parsed;
    throw error;
  }

  return parsed;
}

async function runWorkerPayload(workerPayload) {
  const pythonPath = resolvePythonPath();
  const startedAt = Date.now();

  let workerResult;
  try {
    workerResult = await new Promise((resolve, reject) => {
      const child = spawn(pythonPath, [workerScript], {
        cwd: repoRoot,
        windowsHide: true
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", reject);
      child.on("close", (code) => {
        try {
          resolve(parseWorkerResponse(stdout, stderr, code));
        } catch (error) {
          reject(error);
        }
      });

      child.stdin.write(JSON.stringify(workerPayload));
      child.stdin.end();
    });
  } catch (error) {
    error.workerActions = workerPayload.actions;
    error.durationMs = Date.now() - startedAt;
    throw error;
  }

  return {
    workerResult,
    durationMs: Date.now() - startedAt
  };
}

function normalizeExecution(workerResult, actions, durationMs) {
  const steps = workerResult.steps.map((step, index) => ({
    id: step.id || `input-${index + 1}`,
    title: step.title || actions[index]?.title || `步骤 ${index + 1}`,
    detail: step.detail || "已执行输入动作",
    status: step.status || "performed",
    meta: {
      sourceType: step.sourceType || actions[index]?.sourceType || null,
      input: step.input || null
    }
  }));

  const performedCount = steps.filter((step) => step.status === "performed").length;
  const outcome = performedCount === 0
    ? "这一轮没有成功打出任何实际输入。"
    : `这一轮已向游戏窗口发送 ${performedCount} 个实际输入动作。`;

  return {
    executor: workerResult.executor || "WindowsInputExecutor",
    steps,
    rawSteps: Array.isArray(workerResult.steps) ? workerResult.steps : [],
    durationMs,
    outcome
  };
}

export async function runWindowsActions(actions, options = {}) {
  const workerPayload = {
    windowTitleKeyword: process.env.GAME_WINDOW_TITLE?.trim() || "天涯明月刀手游",
    actions,
    interruptOnExternalInput: Boolean(options.interruptOnExternalInput)
  };

  const { workerResult, durationMs } = await runWorkerPayload(workerPayload);
  return normalizeExecution(workerResult, actions, durationMs);
}

export async function runWindowsExecution(plan, options = {}) {
  const actions = createWorkerActions(plan);
  return runWindowsActions(actions, options);
}

function createStealthPrimitiveActions() {
  return [
    createTravelToCoordinateAction({
      id: "primitive-1",
      title: "Route To Stealth Point",
      xCoordinate: 405,
      yCoordinate: 812,
      confirmPointName: "teleport_confirm"
    }),
    {
      id: "primitive-2",
      title: "Dismount Before Stealth",
      type: "press_key",
      key: "1",
      postDelayMs: 800
    },
    {
      id: "primitive-2b",
      title: "Align Camera Before Stealth",
      type: "press_key",
      key: "v",
      postDelayMs: 800
    },
    {
      id: "primitive-3",
      title: "Enter Stealth",
      type: "enter_stealth_with_retry",
      retryLimit: 5,
      settleMs: 260,
      retryBackstepMs: 180,
      retryMoveSettleMs: 140
    },
    {
      id: "primitive-4",
      title: "Front Arc Search And Strike",
      type: "stealth_front_arc_strike",
      searchTimeoutMs: 7000,
      turnPulseMs: 180,
      holdForwardMs: 2200,
      strikeIntervalMs: 180,
      frontRoi: [0.36, 0.18, 0.64, 0.42],
      postDelayMs: 600
    },
    {
      id: "primitive-5",
      title: "Trigger Miaoqu",
      type: "stealth_trigger_miaoqu",
      retryLimit: 3,
      triggerTimeoutMs: 5000,
      triggerSettleMs: 40,
      retryForwardMs: 140,
      retryMoveSettleMs: 80
    },
    {
      id: "primitive-6",
      title: "Click Gold Steal Button",
      type: "click_steal_button",
      buttonIndex: 1,
      postDelayMs: 500
    }
  ];
}

export function createPrimitiveActions(sequenceName) {
  switch (sequenceName) {
    case "town_movement_smoke":
      return [
        {
          id: "primitive-1",
          title: "Focus Game Window",
          type: "focus_window",
          postDelayMs: 200
        },
        {
          id: "primitive-2",
          title: "Small Forward Step",
          type: "move_forward_pulse",
          movePulseMs: 180,
          postDelayMs: 300
        },
        {
          id: "primitive-3",
          title: "Rotate Camera Right",
          type: "drag_camera",
          startRatio: [0.52, 0.48],
          endRatio: [0.68, 0.48],
          durationMs: 240,
          postDelayMs: 300
        },
        {
          id: "primitive-4",
          title: "Center Click Probe",
          type: "click_relative",
          xRatio: 0.50,
          yRatio: 0.46,
          postDelayMs: 300
        }
      ];
    case "vendor_purchase_to_hawking":
      return [
        {
          id: "primitive-1",
          title: "关闭货商页面",
          type: "close_vendor_panel",
          postDelayMs: 2000
        },
        {
          id: "primitive-2",
          title: "打开地图去大街",
          ...createTravelToCoordinateAction({
            id: "primitive-2",
            title: "打开地图去大街",
            xCoordinate: 670,
            yCoordinate: 538
          })
        },
        // Any map-driven 15s travel wait should be followed by an explicit dismount
        // plus camera reset so the next fixed UI interaction does not get blocked
        // by auto-mount or a skewed camera angle.
        {
          id: "primitive-5",
          title: "下马准备叫卖",
          type: "press_key",
          key: "1",
          postDelayMs: 1000
        },
        {
          id: "primitive-6",
          title: "矫正视角准备叫卖",
          type: "press_key",
          key: "v",
          postDelayMs: 1000
        },
        {
          id: "primitive-7",
          title: "打开叫卖界面",
          type: "press_shortcut",
          shortcut: "hawking",
          postDelayMs: 2000
        },
        {
          id: "primitive-8",
          title: "选中第一格墨锭并最大化后上架",
          type: "stock_first_hawking_item",
          postDelayMs: 1000
        },
        {
          id: "primitive-9",
          title: "点击出摊并等卖完回到正常街道",
          type: "submit_hawking",
          submitReadyDelayMs: 1000,
          activeTimeoutMs: 8000,
          finishTimeoutMs: 120000
        }
      ];
    case "sale":
      return [
        {
          id: "primitive-1",
          title: "打开地图去货商",
          ...createTravelToCoordinateAction({
            id: "primitive-1",
            title: "打开地图去货商",
            xCoordinate: 667,
            yCoordinate: 554
          })
        },
        {
          id: "primitive-2",
          title: "下马准备进货",
          type: "press_key",
          key: "1",
          postDelayMs: 1000
        },
        {
          id: "primitive-3",
          title: "转到阿依娜正前方并贴近到出现对话[F]",
          type: "align_named_vendor_interact_prompt",
          targetName: "阿依娜",
          retryLimit: 5,
          forwardPulseMs: 180,
          dragDurationMs: 220,
          settleMs: 280
        },
        {
          id: "primitive-4",
          title: "按 F 打开阿依娜进货页",
          type: "open_named_vendor_purchase",
          targetName: "阿依娜",
          interactAttempts: 3,
          postDelayMs: 1000
        },
        {
          id: "primitive-5",
          title: "买满墨锭并关闭面板",
          type: "buy_current_vendor_item",
          itemName: "墨锭",
          quantity: 1,
          postDelayMs: 1000
        },
        {
          id: "primitive-6",
          title: "打开地图去大街",
          ...createTravelToCoordinateAction({
            id: "primitive-6",
            title: "打开地图去大街",
            xCoordinate: 670,
            yCoordinate: 538
          })
        },
        {
          id: "primitive-7",
          title: "下马准备叫卖",
          type: "press_key",
          key: "1",
          postDelayMs: 1000
        },
        {
          id: "primitive-8",
          title: "矫正视角准备叫卖",
          type: "press_key",
          key: "v",
          postDelayMs: 1000
        },
        {
          id: "primitive-9",
          title: "打开叫卖界面",
          type: "press_shortcut",
          shortcut: "hawking",
          postDelayMs: 2000
        },
        {
          id: "primitive-10",
          title: "选中第一格墨锭并最大化后上架",
          type: "stock_first_hawking_item",
          postDelayMs: 1000
        },
        {
          id: "primitive-11",
          title: "点击出摊并等卖完回到正常街道",
          type: "submit_hawking",
          submitReadyDelayMs: 1000,
          activeTimeoutMs: 8000,
          finishTimeoutMs: 120000
        }
      ];
    case "stealth":
      return createStealthPrimitiveActions();
    default:
      throw new Error(`Unsupported primitive action sequence: ${sequenceName}`);
  }
}
