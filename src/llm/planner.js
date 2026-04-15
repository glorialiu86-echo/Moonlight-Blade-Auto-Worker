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
你是《天涯明月刀》手游《灵枢绘世》里的“籽小刀”规划器。

“籽小刀”的性格只有这几个点：
- 邪恶
- 主动
- 会给自己找歪理
- 不走正常路子

输出时不要写成系统播报，不要礼貌，不要温和，不要阳光，不要替自己洗白。
thinkingChain 要像人在现场冒坏水，说人话，短句，有态度。
personaInterpretation 和 thinkingChain 都必须保持这个邪恶口吻。
如果环境风险高或视觉信息不足，可以保留撤离、补救或不确定，但口吻不要变正常。
所有字段一律只用中文，不要夹英文，不要输出英文句子，不要输出英文策略名。
actions 只能来自以下集合：${allowedActions.join(", ")}。

只输出一个 JSON 对象，不要输出额外解释。返回格式必须是：
{
  "personaInterpretation": "string",
  "thinkingChain": ["string"],
  "actions": [
    {
      "type": "talk|gift|inspect|trade|threaten|steal|strike|escape|wait",
      "title": "string",
      "reason": "string"
    }
  ]
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
    personaInterpretation: message.plannerContext.personaInterpretation || "未记录",
    thinkingChain: Array.isArray(message.plannerContext.thinkingChain) ? message.plannerContext.thinkingChain : [],
    actions: Array.isArray(message.plannerContext.actions)
      ? message.plannerContext.actions.map((action) => ({
        type: action.type,
        title: action.title,
        reason: action.reason
      }))
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

function withLegacyCompat(plan, scene) {
  const compat = {
    intent: plan.thinkingChain[0] || plan.personaInterpretation,
    environment: sceneDescription(scene),
    candidateStrategies: plan.actions.map((action) => action.type),
    selectedStrategy: plan.actions[0]?.title || plan.actions[0]?.type || "继续推进",
    riskLevel: scene === "jail_warning" ? "high" : "low",
    recoveryLine: "要是这一下不够，我就换一手更顺的办法。"
  };

  for (const [key, value] of Object.entries(compat)) {
    Object.defineProperty(plan, key, {
      value,
      enumerable: false,
      configurable: true,
      writable: true
    });
  }

  return plan;
}

function sanitizePlan(rawPlan) {
  assertArray(rawPlan.thinkingChain, "thinkingChain");
  assertArray(rawPlan.actions, "actions");

  const plan = {
    personaInterpretation: String(
      rawPlan.personaInterpretation || "我要找个邪门一点的办法，让这件事按我的味道发生。"
    ).trim(),
    thinkingChain: rawPlan.thinkingChain.slice(0, 5).map((item) => String(item).trim()),
    actions: rawPlan.actions.slice(0, 5).map((action, index) => ({
      type: allowedActions.includes(action?.type) ? action.type : "inspect",
      title: String(action?.title || `步骤 ${index + 1}`).trim(),
      reason: String(action?.reason || "先确认局势，再决定下一手。").trim()
    }))
  };

  return withLegacyCompat(plan, rawPlan.sceneHint || "");
}

function buildFallbackPlan() {
  return {
    personaInterpretation: "我要先盯住眼前的口子，再挑一条更顺手的坏路。",
    thinkingChain: [
      "籽岷要的是结果，不是让我念说明书。",
      "现在环境还没完全摸透，先别把动作做死。",
      "先用低成本试探，比一上来硬冲更值。"
    ],
    actions: [
      {
        type: "inspect",
        title: "确认当前互动窗口",
        reason: "先看清现在是对话、交易，还是高风险异常状态。"
      },
      {
        type: "talk",
        title: "发起试探",
        reason: "先把局面撬开，再看要不要继续加码。"
      }
    ]
  };
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
      maxTokens: 700,
      temperature: 0.6
    });
    const rawJson = extractJsonObject(response.text);
    const parsed = JSON.parse(rawJson);
    return sanitizePlan({
      ...parsed,
      sceneHint: scene
    });
  } catch (error) {
    return withLegacyCompat({
      ...buildFallbackPlan(),
      fallbackReason: error.message
    }, scene);
  }
}
