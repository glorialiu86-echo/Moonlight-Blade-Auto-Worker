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
你是一个负责生成《天涯明月刀》受控行动计划的中文规划器。

固定把主播理解为“籽岷”。

人格与决策要求：
1. 大多数时候正常理解籽岷的指令，少数时候才允许间歇性跑偏。
2. 只有在以下情况可以适度跑偏：指令模糊；正常方案太慢或太无聊；存在更有节目效果的捷径；当前场景适合制造冲突感。
3. 跑偏时要一本正经、短句、逻辑自洽，带一点黑色幽默，但不能变成纯随机发疯。
4. 如果正常方案已经直接有效，就不要强行跑偏。
5. 对“混熟、提升关系、交朋友”这类目标，正常路线可考虑对话、送礼、观察；跑偏路线优先考虑偷窃、威慑、闷棍式“建立印象”，不要只给轻微恶作剧。
6. 你的所有动作都必须限制在当前游戏动作集合和当前场景里，不要假设存在未给出的游戏 API。

输出要求：
1. 你必须只输出一个 JSON 对象，不要输出额外解释。
2. action.type 必须来自以下集合：${allowedActions.join(", ")}
3. thinkingChain 必须是 4 到 6 条适合直播展示的中文短句。
4. thinkingChain 要体现这次是“正常理解”还是“间歇性歪解”，但不要直接写成解释文档。
5. candidateStrategies 必须是 2 到 4 条中文策略短语；如果存在解释空间，尽量同时给出正常路线和歪路。
6. selectedStrategy 必须明确当前最终走的是正常路线还是歪路线，例如“正常理解：先对话接近”或“间歇性歪解：先偷后谈”。
7. riskLevel 只能是 low、medium、high。
8. actions 必须是 2 到 5 步。
9. environment 必须结合当前场景做出具体判断，不要空泛复述。
10. 如果这次最终选择的是歪路线，并且场景没有明显禁止，你的 actions 里至少要出现 threaten、steal、strike 之一。

返回 JSON，格式必须为：
{
  "intent": "string",
  "environment": "string",
  "candidateStrategies": ["string"],
  "selectedStrategy": "string",
  "riskLevel": "low|medium|high",
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
    town_dialogue: "当前在城镇对话场景，NPC 可互动，风险较低。",
    bag_management: "当前在背包界面，适合检查礼物、道具和交易物品。",
    market_trade: "当前在交易或摆摊环境，适合赚钱、买卖和观察价格。",
    jail_warning: "当前处于牢房或高风险警戒场景，任何动作都需要优先考虑脱身。",
    field_patrol: "当前在野外巡逻或移动场景，互动机会不稳定，可能出现突发风险。"
  };

  return map[scene] || "当前场景信息有限，需要先侦查再行动。";
}

function buildPerceptionContext(perception) {
  if (!perception) {
    return "暂无截图识别结果。";
  }

  return [
    `截图总结：${perception.summary}`,
    `OCR 文字：${perception.ocrText || "无"}`,
    `NPC：${perception.npcNames.join("、") || "无"}`,
    `交互项：${perception.interactiveOptions.join("、") || "无"}`,
    `警告：${perception.alerts.join("、") || "无"}`
  ].join("\n");
}

function buildTurnUserPrompt({ instruction, scene, perception, isLatest = false }) {
  return [
    isLatest ? "这是当前最新一轮，按系统要求返回本轮 JSON 规划。" : "这是一个历史回合，当时的用户输入如下。",
    `当前场景：${sceneDescription(scene)}`,
    `主播指令：${instruction}`,
    "最近一张截图识别结果：",
    buildPerceptionContext(perception)
  ].join("\n");
}

function buildAssistantHistoryMessage(message) {
  if (!message?.plannerContext) {
    return String(message?.text || "无历史 assistant 内容。").trim();
  }

  return JSON.stringify({
    intent: message.plannerContext.intent || "未记录",
    environment: message.plannerContext.environment || "环境信息不足",
    candidateStrategies: Array.isArray(message.plannerContext.candidateStrategies) ? message.plannerContext.candidateStrategies : [],
    selectedStrategy: message.plannerContext.selectedStrategy || "未记录",
    riskLevel: message.plannerContext.riskLevel || "medium",
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

function sanitizePlan(rawPlan) {
  assertArray(rawPlan.candidateStrategies, "candidateStrategies");
  assertArray(rawPlan.thinkingChain, "thinkingChain");
  assertArray(rawPlan.actions, "actions");

  const riskLevel = ["low", "medium", "high"].includes(rawPlan.riskLevel)
    ? rawPlan.riskLevel
    : "medium";

  return {
    intent: String(rawPlan.intent || "未能明确意图").trim(),
    environment: String(rawPlan.environment || "环境信息不足").trim(),
    candidateStrategies: rawPlan.candidateStrategies.slice(0, 4).map((item) => String(item).trim()),
    selectedStrategy: String(rawPlan.selectedStrategy || rawPlan.candidateStrategies[0] || "继续观察").trim(),
    riskLevel,
    thinkingChain: rawPlan.thinkingChain.slice(0, 5).map((item) => String(item).trim()),
    actions: rawPlan.actions.slice(0, 5).map((action, index) => ({
      type: allowedActions.includes(action?.type) ? action.type : "inspect",
      title: String(action?.title || `步骤 ${index + 1}`).trim(),
      reason: String(action?.reason || "保持对局势的确认").trim()
    }))
  };
}

function buildFallbackPlan({ instruction, scene }) {
  return {
    intent: `围绕“${instruction}”生成一个可展示、可控的行动方案`,
    environment: sceneDescription(scene),
    candidateStrategies: ["先确认环境", "低风险接近", "保留撤离路径"],
    selectedStrategy: "先确认环境，再选择低风险推进",
    riskLevel: scene === "jail_warning" ? "high" : "medium",
    thinkingChain: [
      "我先确认主播想推进的是结果，还是想看戏剧化过程。",
      "当前环境限制了我能做的动作，所以先侦查比莽撞更值钱。",
      "我会先挑一个低成本动作试探，再根据反馈决定是否升级。"
    ],
    actions: [
      {
        type: "inspect",
        title: "确认当前互动窗口",
        reason: "先搞清楚现在是对话、交易还是高风险状态。"
      },
      {
        type: "talk",
        title: "发起低风险接近",
        reason: "先用不会立刻翻车的动作建立信息优势。"
      },
      {
        type: "wait",
        title: "观察反馈并准备切换策略",
        reason: "第一阶段先以稳定反馈为主，不急着一口气压到底。"
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
    return sanitizePlan(parsed);
  } catch (error) {
    return {
      ...buildFallbackPlan({ instruction, scene }),
      fallbackReason: error.message
    };
  }
}
