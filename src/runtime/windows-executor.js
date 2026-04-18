import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getActionDefinition } from "./action-registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const workerScript = path.resolve(repoRoot, "scripts/windows_input_worker.py");

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
      title: `固定礼物上架 ${options.giftBundleCount || 10} 次`,
      type: "trade_prepare_gift_bundle",
      payload: {
        repeatCount: options.giftBundleCount || 10
      }
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

function createStealthSetupActions(baseAction) {
  return [
    {
      id: `${baseAction.id}-primitive-1`,
      title: "Route To Stealth Point",
      type: "map_route_to_coordinate",
      sourceType: baseAction.sourceType,
      xCoordinate: 742,
      yCoordinate: 946,
      postDelayMs: 1000,
      waitAfterGoMs: 800
    },
    {
      id: `${baseAction.id}-primitive-2`,
      title: "Confirm Teleport",
      type: "click_named_point",
      sourceType: baseAction.sourceType,
      pointName: "teleport_confirm",
      postDelayMs: 1000
    },
    {
      id: `${baseAction.id}-primitive-3`,
      title: "Close Map Before Stealth",
      type: "press_key",
      sourceType: baseAction.sourceType,
      key: "m",
      postDelayMs: 1000
    },
    {
      id: `${baseAction.id}-primitive-4`,
      title: "Wait For Auto Route To Finish",
      type: "sleep",
      sourceType: baseAction.sourceType,
      durationMs: 15000
    },
    {
      id: `${baseAction.id}-primitive-5`,
      title: "Dismount Before Stealth",
      type: "press_key",
      sourceType: baseAction.sourceType,
      key: "1",
      postDelayMs: 800
    },
    {
      id: `${baseAction.id}-primitive-6`,
      title: "Search Front Target",
      type: "stealth_search_target",
      sourceType: baseAction.sourceType,
      searchTimeoutMs: 7000,
      turnPulseMs: 180,
      moveSettleMs: 80,
      frontRoi: [0.43, 0.12, 0.58, 0.52]
    },
    {
      id: `${baseAction.id}-primitive-7`,
      title: "Select Front Target",
      type: "stealth_select_target",
      sourceType: baseAction.sourceType,
      selectionTimeoutMs: 2200,
      selectionSettleMs: 120,
      frontRoi: [0.36, 0.18, 0.64, 0.42]
    },
    {
      id: `${baseAction.id}-primitive-8`,
      title: "Enter Stealth",
      type: "press_shortcut",
      sourceType: baseAction.sourceType,
      shortcut: "stealth",
      postDelayMs: 500
    }
  ];
}

function createStealthMiaoquActions(baseAction) {
  return [
    ...createStealthSetupActions(baseAction),
    {
      id: `${baseAction.id}-primitive-9`,
      title: "Trigger Knockout",
      type: "stealth_rush_knockout",
      sourceType: baseAction.sourceType,
      knockoutTimeoutMs: 5000,
      strikeIntervalMs: 0,
      moveSettleMs: 50
    },
    {
      id: `${baseAction.id}-primitive-10`,
      title: "Carry Target",
      type: "stealth_carry_target",
      sourceType: baseAction.sourceType,
      carrySettleMs: 120
    },
    {
      id: `${baseAction.id}-primitive-11`,
      title: "Backstep With Target",
      type: "stealth_backstep_target",
      sourceType: baseAction.sourceType,
      backstepMs: 2000,
      moveSettleMs: 40
    },
    {
      id: `${baseAction.id}-primitive-12`,
      title: "Drop Carried Target",
      type: "stealth_drop_target",
      sourceType: baseAction.sourceType,
      dropSettleMs: 80
    },
    {
      id: `${baseAction.id}-primitive-13`,
      title: "Trigger Miaoqu",
      type: "stealth_trigger_miaoqu",
      sourceType: baseAction.sourceType,
      triggerTimeoutMs: 5000,
      triggerSettleMs: 40
    },
    {
      id: `${baseAction.id}-primitive-14`,
      title: "Click Fixed Miaoqu Button",
      type: "click_steal_button",
      sourceType: baseAction.sourceType,
      buttonIndex: 3,
      settleMs: 1500,
      postDelayMs: 1500
    },
    {
      id: `${baseAction.id}-primitive-15`,
      title: "Escape Backward",
      type: "stealth_escape_backward",
      sourceType: baseAction.sourceType,
      backstepMs: 3000,
      moveSettleMs: 40
    }
  ];
}

function createKnockLootActions(baseAction) {
  const actions = [
    ...createStealthSetupActions(baseAction),
    {
      id: `${baseAction.id}-primitive-9`,
      title: "Trigger Knockout",
      type: "stealth_rush_knockout",
      sourceType: baseAction.sourceType,
      knockoutTimeoutMs: 5000,
      strikeIntervalMs: 0,
      moveSettleMs: 50
    },
    {
      id: `${baseAction.id}-primitive-10`,
      title: "Carry Target",
      type: "stealth_carry_target",
      sourceType: baseAction.sourceType,
      carrySettleMs: 120
    },
    {
      id: `${baseAction.id}-primitive-11`,
      title: "Backstep With Target",
      type: "stealth_backstep_target",
      sourceType: baseAction.sourceType,
      backstepMs: 2000,
      moveSettleMs: 40
    },
    {
      id: `${baseAction.id}-primitive-12`,
      title: "Drop Carried Target",
      type: "stealth_drop_target",
      sourceType: baseAction.sourceType,
      dropSettleMs: 80
    },
    {
      id: `${baseAction.id}-primitive-13`,
      title: "Open Loot Panel",
      type: "stealth_open_loot",
      sourceType: baseAction.sourceType,
      lootOpenTimeoutMs: 1200,
      lootSettleMs: 40
    }
  ];

  for (let index = 0; index < 8; index += 1) {
    actions.push(
      {
        id: `${baseAction.id}-primitive-${14 + index * 2}`,
        title: `Loot Select Item ${index + 1}`,
        type: "loot_select_item_once",
        sourceType: baseAction.sourceType,
        lootSettleMs: 20
      },
      {
        id: `${baseAction.id}-primitive-${15 + index * 2}`,
        title: `Loot Put In ${index + 1}`,
        type: "loot_put_in_once",
        sourceType: baseAction.sourceType,
        lootSettleMs: 20
      }
    );
  }

  actions.push(
    {
      id: `${baseAction.id}-primitive-30`,
      title: "Submit Loot",
      type: "loot_submit_once",
      sourceType: baseAction.sourceType,
      lootSettleMs: 40
    },
    {
      id: `${baseAction.id}-primitive-31`,
      title: "Escape After Loot",
      type: "loot_escape_forward",
      sourceType: baseAction.sourceType,
      escapeForwardMs: 5000
    }
  );

  return actions;
}

function createWorkerActions(plan) {
  const workerActions = [];

  for (let index = 0; index < plan.actions.length; index += 1) {
    const action = plan.actions[index];
    const actionDefinition = getActionDefinition(action.type);
    const baseAction = {
      id: `input-${index + 1}`,
      title: action.title || actionDefinition?.label || action.type,
      sourceType: action.type
    };

    const nextAction = plan.actions[index + 1];
    const nextNextAction = plan.actions[index + 2];
    if (
      action.type === "stealth"
      && nextAction?.type === "steal"
      && nextNextAction?.type !== "strike"
    ) {
      workerActions.push(...createStealthMiaoquActions(baseAction));
      index += 1;
      continue;
    }

    if (
      action.type === "stealth"
      && nextAction?.type === "strike"
      && nextNextAction?.type === "steal"
    ) {
      workerActions.push(...createKnockLootActions(baseAction));
      index += 2;
      continue;
    }

    switch (action.type) {
      case "sale":
        workerActions.push(...createPrimitiveActions("sale").map((primitiveAction, primitiveIndex) => ({
          ...primitiveAction,
          id: `${baseAction.id}-primitive-${primitiveIndex + 1}`,
          sourceType: action.type
        })));
        break;
      case "stealth":
        workerActions.push(...createPrimitiveActions("stealth").map((primitiveAction, primitiveIndex) => ({
          ...primitiveAction,
          id: `${baseAction.id}-primitive-${primitiveIndex + 1}`,
          sourceType: action.type
        })));
        break;
      case "talk":
        workerActions.push(...createNpcChatEntryActions(baseAction, {
          timeoutMs: 7000,
          movePulseMs: 160,
          scanIntervalMs: 180
        }));
        break;
      case "gift":
        workerActions.push(...createNpcGiftActions(baseAction, {
          giftRounds: 2,
          timeoutMs: 4500,
          movePulseMs: 160,
          scanIntervalMs: 180
        }));
        break;
      case "trade":
        workerActions.push(...createNpcTradeActions(baseAction, {
          timeoutMs: 5000,
          movePulseMs: 180,
          scanIntervalMs: 180
        }));
        break;
      case "threaten":
      case "strike":
        workerActions.push(...createNpcChatEntryActions(baseAction, {
          timeoutMs: 4500,
          movePulseMs: 160,
          scanIntervalMs: 180
        }));
        break;
      case "steal":
        workerActions.push(...createNpcStealActions(baseAction, {
          triggerDelayMs: 700,
          clickDelayMs: 500,
          buttonIndex: 1
        }));
        break;
      case "escape":
        workerActions.push({
          ...baseAction,
          type: "press_key",
          key: "esc",
          postDelayMs: 500
        });
        break;
      case "wait":
        workerActions.push({
          ...baseAction,
          type: "sleep",
          durationMs: 1200
        });
        break;
      case "inspect":
      default:
        workerActions.push({
          ...baseAction,
          type: "focus_window",
          postDelayMs: 200
        });
        break;
    }
  }

  return workerActions;
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
    {
      id: "primitive-1",
      title: "Route To Stealth Point",
      type: "map_route_to_coordinate",
      xCoordinate: 742,
      yCoordinate: 946,
      postDelayMs: 1000,
      waitAfterGoMs: 800
    },
    {
      id: "primitive-2",
      title: "Confirm Teleport",
      type: "click_named_point",
      pointName: "teleport_confirm",
      postDelayMs: 1000
    },
    {
      id: "primitive-3",
      title: "Close Map Before Stealth",
      type: "press_key",
      key: "m",
      postDelayMs: 1000
    },
    {
      id: "primitive-4",
      title: "Wait For Auto Route To Finish",
      type: "sleep",
      durationMs: 15000
    },
    {
      id: "primitive-5",
      title: "Dismount Before Stealth",
      type: "press_key",
      key: "1",
      postDelayMs: 800
    },
    {
      id: "primitive-6",
      title: "Enter Stealth",
      type: "press_shortcut",
      shortcut: "stealth",
      postDelayMs: 800
    },
    {
      id: "primitive-7",
      title: "Front Arc Search And Strike",
      type: "stealth_front_arc_strike",
      searchTimeoutMs: 7000,
      turnPulseMs: 180,
      holdForwardMs: 2200,
      strikeIntervalMs: 180,
      frontRoi: [0.36, 0.18, 0.64, 0.42],
      postDelayMs: 600
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
          type: "map_route_to_coordinate",
          xCoordinate: 670,
          yCoordinate: 538,
          postDelayMs: 1000,
          waitAfterGoMs: 1000
        },
        {
          id: "primitive-3",
          title: "收起地图",
          type: "press_key",
          key: "m",
          postDelayMs: 1000
        },
        {
          id: "primitive-4",
          title: "等待籽岷跑到大街",
          type: "sleep",
          durationMs: 15000
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
          title: "选中第一件货物上架",
          type: "stock_first_hawking_item",
          postDelayMs: 1000
        },
        {
          id: "primitive-9",
          title: "开始出摊",
          type: "submit_hawking",
          postDelayMs: 1000
        }
      ];
    case "sale":
      return [
        {
          id: "primitive-1",
          title: "打开地图去货商",
          type: "map_route_to_coordinate",
          xCoordinate: 667,
          yCoordinate: 554,
          postDelayMs: 1000,
          waitAfterGoMs: 1000
        },
        {
          id: "primitive-2",
          title: "收起地图准备找货商",
          type: "press_key",
          key: "m",
          postDelayMs: 1000
        },
        {
          id: "primitive-3",
          title: "等待籽岷跑到货商",
          type: "sleep",
          durationMs: 15000
        },
        {
          id: "primitive-4",
          title: "下马准备进货",
          type: "press_key",
          key: "1",
          postDelayMs: 1000
        },
        {
          id: "primitive-5",
          title: "矫正视角准备进货",
          type: "press_key",
          key: "v",
          postDelayMs: 1000
        },
        {
          id: "primitive-6",
          title: "打开阿依娜进货页",
          type: "open_named_vendor_purchase",
          targetName: "阿依娜",
          approachSteps: 2,
          approachMovePulseMs: 180,
          interactAttempts: 3,
          postDelayMs: 1000
        },
        {
          id: "primitive-7",
          title: "买满墨锭并关闭面板",
          type: "buy_current_vendor_item",
          itemName: "墨锭",
          quantity: 1,
          postDelayMs: 1000
        },
        {
          id: "primitive-8",
          title: "打开地图去大街",
          type: "map_route_to_coordinate",
          xCoordinate: 670,
          yCoordinate: 538,
          postDelayMs: 1000,
          waitAfterGoMs: 1000
        },
        {
          id: "primitive-9",
          title: "收起地图准备叫卖",
          type: "press_key",
          key: "m",
          postDelayMs: 1000
        },
        {
          id: "primitive-10",
          title: "等待籽岷跑到大街",
          type: "sleep",
          durationMs: 15000
        },
        {
          id: "primitive-11",
          title: "下马准备叫卖",
          type: "press_key",
          key: "1",
          postDelayMs: 1000
        },
        {
          id: "primitive-12",
          title: "矫正视角准备叫卖",
          type: "press_key",
          key: "v",
          postDelayMs: 1000
        },
        {
          id: "primitive-13",
          title: "打开叫卖界面",
          type: "press_shortcut",
          shortcut: "hawking",
          postDelayMs: 2000
        },
        {
          id: "primitive-14",
          title: "选中货物并上架",
          type: "stock_first_hawking_item",
          postDelayMs: 1000
        },
        {
          id: "primitive-15",
          title: "开始出摊",
          type: "submit_hawking",
          postDelayMs: 1000
        }
      ];
    case "stealth":
      return createStealthPrimitiveActions();
    default:
      throw new Error(`Unsupported primitive action sequence: ${sequenceName}`);
  }
}
