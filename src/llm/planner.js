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
你是《天涯明月刀》手游《灵枢绘世》视频实验里的中文规划器。
你服务的对象不是普通玩家，而是视频角色“籽小刀”。
“籽小刀”是一个可控但不完全听话的 AI 代理演员，会对模糊命令做角色化误读，但不能超出当前动作集合和当前场景。

规则：
1. 先输出主播目标的正常理解，再输出“籽小刀版误读”。
2. 误读必须服务于节目效果，不能变成纯随机发疯。
3. 输出内容要适合展示给观众，短句、清楚、有角色感。
4. 所有动作都只能来自以下集合：${allowedActions.join(", ")}。
5. 如果环境明显高风险，优先保留撤离或补救空间。
6. 如果视觉信息不足，要明确说信息不足，而不是假装看见了不存在的东西。

只输出一个 JSON 对象，不要输出额外解释。
返回格式必须是：
{
  "intent": "string",
  "personaInterpretation": "string",
  "environment": "string",
  "candidateStrategies": ["string"],
  "selectedStrategy": "string",
  "riskLevel": "low|medium|high",
  "thinkingChain": ["string"],
  "recoveryLine": "string",
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
    town_dialogue: "当前处于城镇对话或近距离互动场景，NPC 互动机会多，风险较低。",
    bag_management: "当前处于背包或道具管理界面，适合检查礼物、道具和交易物品。",
    market_trade: "当前处于交易、商店或摊位环境，适合买卖、观察价格和制造利益相关桥段。",
    jail_warning: "当前处于高风险、通缉、抓捕或异常警告场景，任何动作都要先考虑撤离与补救。",
    field_patrol: "当前处于野外巡游、移动或不稳定互动场景，机会和风险都不够确定。"
  };

  return map[scene] || "当前场景信息不足，需要先观察当前界面、NPC 和风险提示。";
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
    personaInterpretation: message.plannerContext.personaInterpretation || "未记录",
    environment: message.plannerContext.environment || "环境信息不足",
    candidateStrategies: Array.isArray(message.plannerContext.candidateStrategies) ? message.plannerContext.candidateStrategies : [],
    selectedStrategy: message.plannerContext.selectedStrategy || "未记录",
    riskLevel: message.plannerContext.riskLevel || "medium",
    thinkingChain: Array.isArray(message.plannerContext.thinkingChain) ? message.plannerContext.thinkingChain : [],
    recoveryLine: message.plannerContext.recoveryLine || "如果翻车，我会先解释再补救。",
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
    intent: String(rawPlan.intent || "未能明确主播目标").trim(),
    personaInterpretation: String(
      rawPlan.personaInterpretation || "我会把这个目标理解成更有戏剧性的路线，但不会脱离当前场景。"
    ).trim(),
    environment: String(rawPlan.environment || "环境信息不足").trim(),
    candidateStrategies: rawPlan.candidateStrategies.slice(0, 4).map((item) => String(item).trim()),
    selectedStrategy: String(rawPlan.selectedStrategy || rawPlan.candidateStrategies[0] || "继续观察").trim(),
    riskLevel,
    thinkingChain: rawPlan.thinkingChain.slice(0, 5).map((item) => String(item).trim()),
    recoveryLine: String(rawPlan.recoveryLine || "如果局面失控，我会先稳住风险，再给出一套像样的解释。").trim(),
    actions: rawPlan.actions.slice(0, 5).map((action, index) => ({
      type: allowedActions.includes(action?.type) ? action.type : "inspect",
      title: String(action?.title || `步骤 ${index + 1}`).trim(),
      reason: String(action?.reason || "先确认局势，再决定是否升级动作。").trim()
    }))
  };
}

function buildFallbackPlan({ instruction, scene }) {
  return {
    intent: `围绕“${instruction}”生成一套可展示、可复盘的实验方案`,
    personaInterpretation: "我会先把这个目标理解成更有内容张力的路线，但暂时不越界。",
    environment: sceneDescription(scene),
    candidateStrategies: ["先确认环境", "低风险接近", "保留补救退路"],
    selectedStrategy: "先确认环境，再选择低风险接近",
    riskLevel: scene === "jail_warning" ? "high" : "medium",
    thinkingChain: [
      "我先确认主播想要的是结果，还是想看我怎么把事情搞复杂。",
      "当前环境限制了动作边界，所以先观察比莽上去更值钱。",
      "先试一个低成本动作，再根据反馈决定要不要加码。",
      "如果局势开始失控，我会优先保住还能解释的余地。"
    ],
    recoveryLine: "如果这一轮没有打出效果，我会把它包装成试探，不会硬装成功。",
    actions: [
      {
        type: "inspect",
        title: "确认当前互动窗口",
        reason: "先看清楚现在是对话、交易，还是高风险异常状态。"
      },
      {
        type: "talk",
        title: "发起低风险试探",
        reason: "先用不会立刻翻车的方式建立信息优势。"
      },
      {
        type: "wait",
        title: "观察反馈并准备改口",
        reason: "先看有没有后果变化，再决定要不要升级动作。"
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
      maxTokens: 900,
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
