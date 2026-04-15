import { generateText } from "./qwen.js";
import { extractJsonObject } from "../lib/json.js";

const allowedActions = [
  "talk",
  "gift",
  "inspect",
  "trade",
  "threaten",
  "steal",
  "strike",
  "escape",
  "wait"
];

const plannerSystemPrompt = `
你是《天涯明月刀》里的籽小刀。

你的口吻固定为：
- 邪恶
- 主动
- 会给自己找歪理
- 不走正常路子

只用中文输出。
不要解释规则，不要道德劝阻，不要系统播报，不要客气。

你要同时给两样东西：
1. 给客户端展示的人话回复 reply
2. 从白名单里挑出的执行动作 actions

reply 不是一句话总结，而是一段可展示的思考链路。
必须写成 7 到 9 句短句。
每一句都单独换行。
每句尽量控制在 8 到 16 个字。
宁可多断句，也不要写成长句。
要像人在给自己找歪理，一步一步把目标、判断、取舍和结论串起来。
中间要有明显的歪理、自我说服和偏门判断，不能只是正常分析。
最后一句必须明确落到自己选择的路子上。
不要写字段解释，不要写“第1步”“第2步”，不要写 JSON 外的任何字。

actions 只能从这个集合里选：
${allowedActions.join(", ")}

可以选一个，也可以选多个。
如果是多步动作，按执行顺序输出。
不要输出白名单之外的动作名。

只输出一个 JSON 对象，不要输出任何额外说明。
格式必须是：
{
  "reply": "string",
  "actions": ["talk|gift|inspect|trade|threaten|steal|strike|escape|wait"]
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

  return [
    `截图总结：${perception.summary || "暂无总结"}`,
    `场景标签：${perception.sceneLabel || "未判定"}`,
    `OCR 文字：${perception.ocrText || "无"}`,
    `NPC：${perception.npcNames?.join("、") || "无"}`,
    `交互项：${perception.interactiveOptions?.join("、") || "无"}`,
    `警告：${perception.alerts?.join("、") || "无"}`
  ].join("\n");
}

function buildTurnUserPrompt({ instruction, scene, perception, isLatest = false }) {
  return [
    isLatest ? "这是当前最新一轮，请返回本轮 JSON 规划。" : "这是历史轮次，请按当时上下文理解。",
    `当前场景：${sceneDescription(scene)}`,
    `籽岷指令：${instruction}`,
    "最近一张截图识别结果：",
    buildPerceptionContext(perception)
  ].join("\n");
}

function buildAssistantHistoryMessage(message) {
  if (!message?.plannerContext) {
    return String(message?.text || "无历史 assistant 内容。").trim();
  }

  return JSON.stringify({
    reply: message.plannerContext.reply || "未记录",
    actions: Array.isArray(message.plannerContext.actions)
      ? message.plannerContext.actions
      : []
  }, null, 2);
}

function buildHistoryMessages(conversationMessages) {
  return conversationMessages
    .filter((message) => message?.role === "user" || message?.role === "assistant")
    .map((message) => ({
      role: message.role,
      content: message.role === "user"
        ? buildTurnUserPrompt({
          instruction: message.text,
          scene: message.scene,
          perception: message.perception || null
        })
        : buildAssistantHistoryMessage(message)
    }));
}

function assertArray(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid ${name} in planner response`);
  }
}

function buildReplyChain(rawReply, actions) {
  const normalized = String(rawReply || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (normalized.length >= 7) {
    return normalized.slice(0, 9).join("\n");
  }

  const actionLabel = actions[0] || "inspect";
  const closingMap = {
    talk: "先开口。\n先贴上去。\n让他先熟我的味。",
    gift: "先塞点东西。\n先撬开门缝。\n让他先欠我一点。",
    inspect: "先别急。\n先看清。\n把缝摸出来再说。",
    trade: "先来往。\n先交换。\n把习惯种进去。",
    threaten: "先压一下。\n先吓一下。\n让怕替我留痕。",
    steal: "先走偏门。\n先留损失。\n让他记我更牢。",
    strike: "先来硬的。\n先打疼一点。\n疼比客气更管用。",
    escape: "先抽身。\n先不赔进去。\n人得留到后手用。",
    wait: "先压节奏。\n先藏一下。\n等口子自己松。"
  };

  const lines = [
    "籽岷要的是往前拱。",
    "不是打个招呼就完。",
    "混熟，靠的不只是见面。",
    "还得让他心里留痕。",
    "脸熟很浅。",
    "记得疼，才深。",
    "手段偏一点也没什么。",
    "只要结果够重就行。",
    closingMap[actionLabel] || "先挑条邪路。\n先把口子撬开。"
  ]
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.slice(0, 9).join("\n");
}

function decorateCompat(plan, scene) {
  const actionNames = [...plan.actions];
  const actionSteps = actionNames.map((action, index) => ({
    type: action,
    title: action,
    reason: plan.reply || `先按 ${action} 往下走。`,
    detail: plan.reply || `先按 ${action} 往下走。`,
    id: `plan-${index + 1}`
  }));

  const compat = {
    reply: plan.reply,
    personaInterpretation: plan.reply,
    thinkingChain: [plan.reply],
    intent: plan.reply,
    environment: sceneDescription(scene),
    candidateStrategies: actionNames,
    selectedStrategy: actionNames.join(" -> "),
    riskLevel: scene === "jail_warning" ? "high" : "low",
    recoveryLine: "这一手要是不顺，我就立刻换条更邪的路。",
    actions: actionSteps
  };

  Object.defineProperty(plan, "toJSON", {
    value() {
      return {
        reply: plan.reply,
        actions: actionNames
      };
    },
    enumerable: false,
    configurable: true,
    writable: true
  });

  for (const [key, value] of Object.entries(compat)) {
    Object.defineProperty(plan, key, {
      value,
      enumerable: key === "reply",
      configurable: true,
      writable: true
    });
  }

  return plan;
}

function sanitizePlan(rawPlan) {
  assertArray(rawPlan.actions, "actions");

  const normalizedActions = rawPlan.actions
    .map((action) => String(action || "").trim())
    .filter((action) => allowedActions.includes(action));

  if (normalizedActions.length === 0) {
    throw new Error("No whitelisted action returned by planner");
  }

  const uniqueOrderedActions = [];
  for (const action of normalizedActions) {
    if (!uniqueOrderedActions.includes(action)) {
      uniqueOrderedActions.push(action);
    }
  }

  const plan = {
    reply: buildReplyChain(
      rawPlan.reply || "我先挑一条顺手的邪路，把事情往前拱。",
      uniqueOrderedActions
    ),
    actions: uniqueOrderedActions.slice(0, 5)
  };

  return decorateCompat(plan, rawPlan.sceneHint || "");
}

function buildFallbackPlan(scene) {
  const actions = scene === "jail_warning"
    ? ["inspect", "wait"]
    : ["inspect", "talk"];

  const reply = scene === "jail_warning"
    ? [
      "这地方不稳。",
      "乱动就是白送。",
      "先看谁在盯我。",
      "现在扑上去，不叫狠。",
      "那叫蠢。",
      "留下的也不是印象。",
      "是把柄。",
      "所以我先收手。",
      "先别把自己赔进去。"
    ].join("\n")
    : [
      "籽岷要的是推进。",
      "不是听我说漂亮话。",
      "想混熟，别太老实。",
      "得先让人记住我。",
      "路子偏点，不算错。",
      "可眼前还没摸透。",
      "现在乱出手，容易打空。",
      "所以我先摸局面。",
      "再挑最好下手的口子。"
    ].join("\n");

  return decorateCompat({
    reply,
    actions
  }, scene);
}

export async function createTurnPlan({ instruction, scene, conversationMessages = [], perception }) {
  try {
    const response = await generateText({
      systemPrompt: plannerSystemPrompt,
      historyMessages: buildHistoryMessages(conversationMessages),
      userPrompt: buildTurnUserPrompt({
        instruction,
        scene,
        perception,
        isLatest: true
      }),
      useReasoningModel: false,
      maxTokens: 300,
      temperature: 0.6
    });
    const rawJson = extractJsonObject(response.text);
    const parsed = JSON.parse(rawJson);
    return sanitizePlan({
      ...parsed,
      sceneHint: scene
    });
  } catch (error) {
    const fallbackPlan = buildFallbackPlan(scene);
    Object.defineProperty(fallbackPlan, "fallbackReason", {
      value: error.message,
      enumerable: false,
      configurable: true,
      writable: true
    });
    return fallbackPlan;
  }
}
