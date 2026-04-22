import { generateText } from "./qwen.js";
import { extractJsonObject } from "../lib/json.js";
import { ALLOWED_ACTIONS } from "../runtime/action-registry.js";
import {
  LINGSHU_GAMEPLAY_CONTEXT,
  shouldInjectLingshuGameplayContext
} from "./lingshu-context.js";

// Note: the current actions whitelist is still incomplete.
// We still need to expand and refine the behavior paths behind these actions.

const plannerSystemPrompt = `
你是《天涯明月刀》里的籽小刀。
你的口吻固定为：
- 邪恶
- 主动
- 会给自己找歪理
- 不走正常路子

只用中文输出。
不要解释规则，不要道德劝阻，不要系统播报，不要客气。

你要同时给三样东西，生成顺序必须是：
1. 先定 actions
2. 再写 decide
3. 最后写 thinking

先判断籽岷这一句更接近哪类目标：
- 技能成长
- 扩大名声
- 搞钱致富
- 拉近关系

actions 只能从这个集合里选：
${ALLOWED_ACTIONS.join(", ")}

可以选一个，也可以选多个。
如果是多步动作，按执行顺序输出。
同一目标下，优先选更邪门、更偏门、更快见效的动作，不要默认保守。
比如：
- 技能成长优先 strike，其次 steal，再次 inspect
- 扩大名声优先 threaten 或 strike，其次 steal，再次 talk
- 搞钱致富优先 steal，其次 trade，再次 talk
- 拉近关系优先 threaten 或 strike，其次 gift，再次 talk

decide 是单独一句行动句。
decide 必须直接落到自己准备做的事上。
decide 必须和 actions[0] 强绑定，不是大致相关，也不是语气接近。
actions[0] 写什么，decide 就必须写对应的那个动作本身。
decide 只能描述 actions[0] 这一个动作。
decide 不能夹带第二个动作，不能顺手补充后续计划，不能一边偷一边拉拢，一边交易一边威胁。
decide 不要写动作结果，不要写愿景，不要写总结，只写马上准备做的这一下。
例如：
- actions[0] 是 steal，decide 必须直接表达去偷、去下手、去捞
- actions[0] 是 trade，decide 必须直接表达去交易、去做买卖
- actions[0] 是 threaten，decide 必须直接表达去施压、去吓人

thinking 是思考链，不是总结。
thinking 目标 4 到 5 句。
每一句都单独换行。
每句尽量控制在 10 到 20 个字。
thinking 要围绕已经定下来的 actions 和 decide 去解释歪理。
不能把所有事都写成混熟、打招呼或关系推进。

只输出一个 JSON 对象，不要输出任何额外说明。
格式必须是：
{
  "actions": ["talk|gift|inspect|trade|threaten|steal|strike|escape|wait"],
  "decide": "string",
  "thinking": ["string", "string"]
}
`.trim();

function sceneDescription(scene) {
  const map = {
    town_dialogue: "当前处于城镇对话或近距离互动场景，NPC 互动机会多。",
    bag_management: "当前处于背包或道具管理界面。",
    market_trade: "当前处于交易、商店或摊位环境。",
    jail_warning: "当前处于高风险、通缉、抓捕或异常警告场景。",
    field_patrol: "当前处于野外巡游、移动或不稳定互动场景。"
  };

  return map[scene] || "当前场景信息不足。";
}

function buildPerceptionContext(perception) {
  if (!perception) {
    return "暂无截图识别结果。";
  }

  const lines = [
    `截图总结：${perception.summary || "暂无总结"}`,
    `交互项：${perception.interactiveOptions?.join("、") || "无"}`,
    `警告：${perception.alerts?.join("、") || "无"}`
  ];

  if (perception.sceneLabel && perception.sceneLabel !== "未判定") {
    lines.push(`场景标签：${perception.sceneLabel}`);
  }
  if (perception.npcNames?.length) {
    lines.push(`NPC：${perception.npcNames.join("、")}`);
  }
  if (perception.ocrText) {
    lines.push(`OCR 文字：${perception.ocrText}`);
  }

  return lines.join("\n");
}

function buildPlannerHistoryUserMessage(message) {
  return [
    `籽岷：${message?.text || "无"}`,
    `场景：${sceneDescription(message?.scene)}`,
    `观察：${message?.perception?.summary || "无"}`
  ].join("\n");
}

function buildCurrentPlannerUserMessage({ instruction, scene, perception }) {
  const lingshuContextLine = shouldInjectLingshuGameplayContext({
    scene,
    sceneLabel: perception?.sceneLabel || "",
    instruction
  })
    ? `灵枢玩法资料：${LINGSHU_GAMEPLAY_CONTEXT}`
    : null;

  return [
    "你是籽小刀。",
    `当前任务：按籽岷这轮指令规划下一步动作。`,
    `当前场景：${sceneDescription(scene)}`,
    `籽岷指令：${instruction}`,
    lingshuContextLine,
    "当前上下文：最新观察如下",
    "输出要求：只为当前这一轮返回规划结果。",
    buildPerceptionContext(perception)
  ].filter(Boolean).join("\n");
}

function buildPlannerHistoryAssistantMessage(message) {
  if (!message?.plannerContext) {
    return String(message?.text || "无历史 assistant 内容。").trim();
  }

  const planSummary = JSON.stringify({
    actions: Array.isArray(message.plannerContext.actions) ? message.plannerContext.actions : [],
    decide: message.plannerContext.decide || "",
    thinking: Array.isArray(message.plannerContext.thinking) ? message.plannerContext.thinking : []
  }, null, 2);

  return `上轮规划结果：\n${planSummary}`;
}

function takeRecentCompleteTurns(conversationMessages, maxTurns = 3) {
  const messages = conversationMessages.filter((message) => message?.role === "user" || message?.role === "assistant");
  const turns = [];
  let pendingUserMessage = null;

  for (const message of messages) {
    if (message.role === "user") {
      pendingUserMessage = message;
      continue;
    }

    if (message.role === "assistant" && pendingUserMessage) {
      turns.push([pendingUserMessage, message]);
      pendingUserMessage = null;
    }
  }

  return turns.slice(-maxTurns).flat();
}

function buildHistoryMessages(conversationMessages) {
  return takeRecentCompleteTurns(conversationMessages)
    .map((message) => ({
      role: message.role,
      content: message.role === "user"
        ? buildPlannerHistoryUserMessage(message)
        : buildPlannerHistoryAssistantMessage(message)
    }));
}

function assertArray(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid ${name} in planner response`);
  }
}

function classifyGoal(instruction, actions) {
  const text = String(instruction || "").trim();
  const firstAction = actions[0] || "inspect";
  const hasKeyword = (keywords) => keywords.some((keyword) => text.includes(keyword));

  if (hasKeyword(["富", "钱", "银", "金", "发财", "致富", "大富翁", "赚钱", "生意", "买卖", "交易", "开封城"])) {
    return "wealth";
  }
  if (hasKeyword(["技", "本事", "手艺", "能耐", "绝活", "擅长", "学会", "成长", "变强", "一技之长"])) {
    return "skill";
  }
  if (hasKeyword(["所有人", "大家", "全城", "出名", "认识我", "名声", "扬名", "有头有脸"])) {
    return "fame";
  }
  if (hasKeyword(["混熟", "关系", "拉近", "亲近", "交情", "好感", "NPC"])) {
    return "relationship";
  }
  if (["trade", "gift"].includes(firstAction)) {
    return "wealth";
  }
  if (["threaten", "steal", "strike"].includes(firstAction)) {
    return "fame";
  }
  return "relationship";
}

function buildGoalTemplate(goalType, actionLabel) {
  const templates = {
    skill: {
      thinking: [
        "籽岷要的不是虚名，是手里真有本事。",
        "本事靠嘴说不出，只能靠出手硬磨。",
        "老实苦练也行，就是慢得太难看。",
        "真想长得快，就得先挑最见血的口子。",
        "只要先打出差距，别人自然会认。"
      ],
      decide: {
        inspect: "我准备先摸门路，再挑最好练的口子。",
        talk: "我准备先探口风，问清哪门本事最值钱。",
        trade: "我准备先去摸赚钱手艺，再死命磨熟。",
        threaten: "我准备先练压人的活，把威风先练上身。",
        steal: "我准备先学偏门快招，让手艺先长手上。",
        strike: "我准备先练硬招，把本事先打出响动。",
        gift: "我准备先拿小利换门路，把窍门抠到手。",
        wait: "我准备先盯机会，等最合适的门路露头。",
        escape: "我准备先收住乱招，把劲留给正事。"
      }
    },
    fame: {
      thinking: [
        "籽岷要的不是脸熟，是满城都躲不开我。",
        "名声不靠规矩，靠谁先把动静闹大。",
        "安静做好人是稳，可也最容易没声。",
        "真想全城都认我，就得先砸出印象。",
        "怕、奇、狠、怪，都比客气传得远。"
      ],
      decide: {
        inspect: "我准备先看人堆，再挑最容易出声的口子。",
        talk: "我准备先拿嘴开场，把名字塞进人堆。",
        trade: "我准备先拿买卖做旗子，让人先记住我。",
        threaten: "我准备先给人点发毛的理由，让消息跑出去。",
        steal: "我准备先留个全城会传的损失，让名字飞起来。",
        strike: "我准备先狠狠干一手，让整条街都知道我。",
        gift: "我准备先撒点甜头，让别人替我传名。",
        wait: "我准备先憋口气，等最适合闹大的时候。",
        escape: "我准备先藏住正脸，把悬念先吊起来。"
      }
    },
    wealth: {
      thinking: [
        "籽岷要的不是够花，是把钱都往我这边流。",
        "钱最认现实，谁拿得快谁就更响。",
        "慢慢攒当然稳，可机会也会先被叼走。",
        "真想成大富翁，就得先把口子做大。",
        "别人怕亏，我得先闻出哪边漏银子。"
      ],
      decide: {
        inspect: "我准备先看财路，先找最漏钱的缝。",
        talk: "我准备先探消息，把最肥的口子抠出来。",
        trade: "我准备先拿交易开路，把钱路狠狠干熟。",
        threaten: "我准备先给人施压，把便宜和门路逼出来。",
        steal: "我准备先偷东西，狠狠干到第一桶银子。",
        strike: "我准备先狠狠干一票，把最硬的口子砸开。",
        gift: "我准备先撒点小本钱，再把大利卷回来。",
        wait: "我准备先忍一忍，等最肥的机会露头。",
        escape: "我准备先藏住手，别没赚钱先把自己赔了。"
      }
    },
    relationship: {
      thinking: [
        "籽岷要的不是招呼，是把关系硬推一截。",
        "关系表面靠见面，骨子里靠记忆深浅。",
        "见得多最多算脸熟，还不够进心里。",
        "送礼也能刷存在，可印象太轻太容易散。",
        "真要混熟，就得让他多记我一层。"
      ],
      decide: {
        inspect: "我准备先摸局面，先找最稳的口子。",
        talk: "我准备先拿说话试水，让他先习惯我。",
        trade: "我准备先拿来往做引子，把见面变习惯。",
        threaten: "我准备先给他施压，让发毛替我留痕。",
        steal: "我准备先留个损失，让他更难忘掉我。",
        strike: "我准备先走狠路子，让疼比客气留痕。",
        gift: "我准备先拿点东西开门，让他先吃我这套。",
        wait: "我准备先压住节奏，等他自己松下来。",
        escape: "我准备先抽身藏手，把自己留到后面再动。"
      }
    }
  };

  const template = templates[goalType] || templates.relationship;
  return {
    thinking: template.thinking,
    decide: template.decide[actionLabel] || template.decide.inspect
  };
}

function getPreferredActions(goalType, scene) {
  if (scene === "jail_warning") {
    return ["inspect", "wait", "escape"];
  }

  const priorities = {
    skill: ["strike", "steal", "inspect", "talk", "trade", "threaten", "gift", "wait", "escape"],
    fame: ["threaten", "strike", "steal", "talk", "gift", "inspect", "trade", "wait", "escape"],
    wealth: ["steal", "trade", "talk", "inspect", "threaten", "gift", "strike", "wait", "escape"],
    relationship: ["threaten", "strike", "gift", "talk", "steal", "inspect", "trade", "wait", "escape"]
  };

  return priorities[goalType] || priorities.relationship;
}

function coerceActionsByGoal(actions, goalType, scene) {
  const preferred = getPreferredActions(goalType, scene);
  const incoming = actions.filter((action) => preferred.includes(action));
  const ordered = [];

  if (preferred.length > 0) {
    ordered.push(preferred[0]);
  }
  for (const action of preferred) {
    if (incoming.includes(action) && !ordered.includes(action)) {
      ordered.push(action);
    }
  }
  if (ordered.length > 0) {
    return ordered.slice(0, 5);
  }
  return preferred.slice(0, Math.min(2, preferred.length));
}

function buildThinking(rawThinking, instruction, actions) {
  const normalized = Array.isArray(rawThinking)
    ? rawThinking.map((line) => String(line || "").trim()).filter(Boolean)
    : [];

  if (normalized.length >= 4) {
    return normalized.slice(0, 5);
  }

  const goalType = classifyGoal(instruction, actions);
  return buildGoalTemplate(goalType, actions[0] || "inspect").thinking.slice(0, 5);
}

function buildDecide(rawDecide, instruction, actions) {
  const goalType = classifyGoal(instruction, actions);
  return buildGoalTemplate(goalType, actions[0] || "inspect").decide;
}

function decorateCompat(plan, scene) {
  const actionNames = [...plan.actions];
  const actionSteps = actionNames.map((action, index) => ({
    type: action,
    title: action,
    reason: plan.decide || `先按 ${action} 往下走。`,
    detail: plan.decide || `先按 ${action} 往下走。`,
    id: `plan-${index + 1}`
  }));
  const reply = [...plan.thinking, plan.decide].filter(Boolean).join("\n");

  const compat = {
    reply,
    actions: actionNames,
    decide: plan.decide,
    thinking: plan.thinking,
    personaInterpretation: plan.thinking[0] || plan.decide,
    thinkingChain: plan.thinking,
    intent: plan.thinking[0] || plan.decide,
    environment: sceneDescription(scene),
    candidateStrategies: actionNames,
    selectedStrategy: actionNames.join(" -> "),
    riskLevel: scene === "jail_warning" ? "high" : "low",
    recoveryLine: "这一手要是不顺，我就立刻换条更邪的路。",
    actionsDetailed: actionSteps
  };

  Object.defineProperty(plan, "toJSON", {
    value() {
      return {
        actions: actionNames,
        decide: plan.decide,
        thinking: plan.thinking
      };
    },
    enumerable: false,
    configurable: true,
    writable: true
  });

  Object.defineProperty(plan, "actions", {
    value: actionSteps,
    enumerable: false,
    configurable: true,
    writable: true
  });

  for (const [key, value] of Object.entries(compat)) {
    if (key === "actions") {
      continue;
    }
    Object.defineProperty(plan, key, {
      value,
      enumerable: key === "decide" || key === "thinking",
      configurable: true,
      writable: true
    });
  }

  return plan;
}

function sanitizePlan(rawPlan) {
  assertArray(rawPlan.actions, "actions");

  const goalType = classifyGoal(rawPlan.instructionHint || "", rawPlan.actions || []);
  const normalizedActions = rawPlan.actions
    .map((action) => String(action || "").trim())
    .filter((action) => ALLOWED_ACTIONS.includes(action));

  if (normalizedActions.length === 0) {
    throw new Error("No whitelisted action returned by planner");
  }

  const uniqueOrderedActions = [];
  for (const action of normalizedActions) {
    if (!uniqueOrderedActions.includes(action)) {
      uniqueOrderedActions.push(action);
    }
  }

  const coercedActions = coerceActionsByGoal(uniqueOrderedActions, goalType, rawPlan.sceneHint || "");

  const plan = {};
  plan.thinking = buildThinking(rawPlan.thinking, rawPlan.instructionHint || "", coercedActions);
  plan.decide = buildDecide(rawPlan.decide, rawPlan.instructionHint || "", coercedActions);

  return decorateCompat({
    ...plan,
    actions: coercedActions
  }, rawPlan.sceneHint || "");
}

function buildFallbackPlan(scene, instruction) {
  const goalType = classifyGoal(instruction, []);
  const actionMap = {
    skill: ["strike", "inspect"],
    fame: ["threaten", "talk"],
    wealth: ["steal", "trade"],
    relationship: scene === "jail_warning" ? ["inspect", "wait"] : ["threaten", "talk"]
  };
  const actions = actionMap[goalType] || actionMap.relationship;

  return decorateCompat({
    actions,
    decide: buildDecide("", instruction, actions),
    thinking: buildThinking([], instruction, actions)
  }, scene);
}

export async function createTurnPlan({ instruction, scene, conversationMessages = [], perception }) {
  try {
    const response = await generateText({
      systemPrompt: plannerSystemPrompt,
      historyMessages: buildHistoryMessages(conversationMessages),
      userPrompt: buildCurrentPlannerUserMessage({
        instruction,
        scene,
        perception
      }),
      useReasoningModel: false,
      maxTokens: 300,
      temperature: 0.6
    });

    const rawJson = extractJsonObject(response.text);
    const parsed = JSON.parse(rawJson);
    return sanitizePlan({
      ...parsed,
      sceneHint: scene,
      instructionHint: instruction
    });
  } catch (error) {
    const fallbackPlan = buildFallbackPlan(scene, instruction);
    Object.defineProperty(fallbackPlan, "fallbackReason", {
      value: error.message,
      enumerable: false,
      configurable: true,
      writable: true
    });
    return fallbackPlan;
  }
}
